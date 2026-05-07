import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { GameState, Player, PlayerHand, PlayOrderEntry } from '../lib/supabase';
import { subscribeToGameState, subscribeToPlayers } from '../lib/realtime';
import {
  calculateHand,
  canSplit,
  createDeck,
  dealCard,
  isBlackjack,
  isBust,
  runDealerLogic,
  determineWinner,
} from '../lib/blackjack';
import CardComponent from '../components/CardComponent';
import type { RealtimeChannel } from '@supabase/supabase-js';

function fmt(n: number) {
  return n.toLocaleString();
}

export default function Game() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomId, setRoomId] = useState('');
  const [acting, setActing] = useState(false);
  const [betInput, setBetInput] = useState(100);
  const dealerRanRef = useRef(false);

  const myPlayerId = localStorage.getItem('playerId') || '';

  // ── Load initial data ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!code) return;
    supabase.from('rooms').select().eq('code', code).single().then(async ({ data: room }) => {
      if (!room) { navigate('/'); return; }
      setRoomId(room.id);
      const [{ data: gs }, { data: ps }] = await Promise.all([
        supabase.from('game_state').select().eq('room_id', room.id).single(),
        supabase.from('players').select().eq('room_id', room.id).eq('is_active', true).order('created_at'),
      ]);
      if (gs) setGameState(gs as GameState);
      if (ps) setPlayers(ps as Player[]);
    });
  }, [code, navigate]);

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return;
    const gsChannel: RealtimeChannel = subscribeToGameState(roomId, gs => {
      setGameState(gs);
      dealerRanRef.current = false;
    });
    const plChannel: RealtimeChannel = subscribeToPlayers(roomId, updatedPlayers => {
      setPlayers(updatedPlayers);
      // If current player was deactivated (cashed out by another client), go home
      const myId = localStorage.getItem('playerId');
      if (myId && !updatedPlayers.some(p => p.id === myId)) {
        localStorage.removeItem('playerId');
        localStorage.removeItem('roomCode');
      }
    });
    return () => { gsChannel.unsubscribe(); plChannel.unsubscribe(); };
  }, [roomId]);

  // ── Auto-run dealer phase ───────────────────────────────────────────────────
  useEffect(() => {
    if (gameState?.phase !== 'dealer_turn' || dealerRanRef.current) return;
    dealerRanRef.current = true;

    const gs = gameState;
    (async () => {
      const { finalHand, updatedDeck } = runDealerLogic(gs.dealer_hand, gs.deck);
      const dealerBJ = isBlackjack(finalHand);

      const newHands: Record<string, PlayerHand[]> = {};
      const newChips = { ...gs.player_chips };

      for (const [pid, hands] of Object.entries(gs.player_hands)) {
        newHands[pid] = hands.map(hand => {
          let result: 'win' | 'lose' | 'push';
          if (hand.status === 'bust') {
            result = 'lose';
          } else if (hand.status === 'blackjack') {
            result = dealerBJ ? 'push' : 'win';
          } else {
            result = determineWinner(hand.cards, finalHand);
          }
          // Payout: blackjack pays 3:2
          if (result === 'win') {
            newChips[pid] += hand.status === 'blackjack'
              ? Math.floor(hand.bet * 2.5)
              : hand.bet * 2;
          } else if (result === 'push') {
            newChips[pid] += hand.bet;
          }
          return { ...hand, result };
        });
      }

      const { error } = await supabase.from('game_state').update({
        dealer_hand: finalHand,
        deck: updatedDeck,
        player_hands: newHands,
        player_chips: newChips,
        phase: 'finished',
        updated_at: new Date().toISOString(),
      }).eq('room_id', roomId).eq('phase', 'dealer_turn');

      if (!error) {
        // Persist chips to players table
        for (const [pid, chips] of Object.entries(newChips)) {
          await supabase.from('players').update({ chips }).eq('id', pid);
        }
      }
    })();
  }, [gameState?.phase, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Advance turn helper ─────────────────────────────────────────────────────
  async function advanceTurn(
    updatedHands: Record<string, PlayerHand[]>,
    updatedDeck: import('../lib/blackjack').Card[],
    playOrder: PlayOrderEntry[],
    currentIdx: number,
    updatedChips?: Record<string, number>
  ) {
    let nextIdx = currentIdx + 1;
    while (nextIdx < playOrder.length) {
      const { player_id, hand_index } = playOrder[nextIdx];
      if (updatedHands[player_id][hand_index].status === 'playing') break;
      nextIdx++;
    }

    const allDone = nextIdx >= playOrder.length;
    const base = {
      deck: updatedDeck,
      player_hands: updatedHands,
      current_player_index: nextIdx,
      ...(updatedChips ? { player_chips: updatedChips } : {}),
      updated_at: new Date().toISOString(),
    };

    if (allDone) {
      await supabase.from('game_state').update({ ...base, phase: 'dealer_turn' }).eq('room_id', roomId);
    } else {
      await supabase.from('game_state').update(base).eq('room_id', roomId);
    }
  }

  // ── Betting ─────────────────────────────────────────────────────────────────
  async function handlePlaceBet() {
    if (!gameState || acting) return;
    const myChips = gameState.player_chips[myPlayerId] ?? 0;
    const bet = Math.max(1, Math.min(betInput, myChips));
    setActing(true);

    try {
      const newBets = { ...gameState.player_bets, [myPlayerId]: bet };
      const activePlayers = players.filter(p => (gameState.player_chips[p.id] ?? 0) > 0);
      const allBet = activePlayers.every(p => newBets[p.id] !== undefined);

      if (!allBet) {
        await supabase.from('game_state').update({
          player_bets: newBets,
          updated_at: new Date().toISOString(),
        }).eq('room_id', roomId);
        return;
      }

      // Everyone bet — deal cards
      let deck = createDeck();
      const playerHandsMap: Record<string, PlayerHand[]> = {};

      for (const p of activePlayers) {
        const b = newBets[p.id];
        const { card: c1, deck: d1 } = dealCard(deck); deck = d1;
        const { card: c2, deck: d2 } = dealCard(deck); deck = d2;
        const cards = [c1, c2];
        const status = isBlackjack(cards) ? 'blackjack' : 'playing';
        playerHandsMap[p.id] = [{ cards, status, bet: b, doubled: false }];
      }
      // Players with 0 chips get empty hand array (skipped)
      for (const p of players) {
        if (!playerHandsMap[p.id]) playerHandsMap[p.id] = [];
      }

      const { card: dc1, deck: d3 } = dealCard(deck); deck = d3;
      const { card: dc2, deck: d4 } = dealCard(deck); deck = d4;
      const dealerHand = [dc1, { ...dc2, faceDown: true }];

      const playOrder: PlayOrderEntry[] = [];
      for (const p of activePlayers) {
        if (playerHandsMap[p.id][0]?.status === 'playing') {
          playOrder.push({ player_id: p.id, hand_index: 0 });
        }
      }

      const newChips = { ...gameState.player_chips };
      for (const p of activePlayers) {
        newChips[p.id] -= newBets[p.id];
      }

      const phase = playOrder.length === 0 ? 'dealer_turn' : 'player_turns';

      await supabase.from('game_state').update({
        deck,
        dealer_hand: dealerHand,
        player_hands: playerHandsMap,
        play_order: playOrder,
        current_player_index: 0,
        phase,
        player_bets: newBets,
        player_chips: newChips,
        updated_at: new Date().toISOString(),
      }).eq('room_id', roomId).eq('phase', 'betting');
    } finally {
      setActing(false);
    }
  }

  // ── Hit ─────────────────────────────────────────────────────────────────────
  async function handleHit() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    setActing(true);
    try {
      const { card, deck } = dealCard(gameState.deck);
      const hands = gameState.player_hands[entry.player_id];
      const hand = hands[entry.hand_index];
      const newCards = [...hand.cards, card];
      const bust = isBust(newCards);

      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...hands];
      newHands[entry.player_id][entry.hand_index] = {
        ...hand,
        cards: newCards,
        status: bust ? 'bust' : 'playing',
      };

      if (bust) {
        await advanceTurn(newHands, deck, gameState.play_order, gameState.current_player_index);
      } else {
        await supabase.from('game_state').update({
          deck,
          player_hands: newHands,
          updated_at: new Date().toISOString(),
        }).eq('room_id', roomId);
      }
    } finally {
      setActing(false);
    }
  }

  // ── Stand ───────────────────────────────────────────────────────────────────
  async function handleStand() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    setActing(true);
    try {
      const hands = gameState.player_hands[entry.player_id];
      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...hands];
      newHands[entry.player_id][entry.hand_index] = { ...hands[entry.hand_index], status: 'stand' };
      await advanceTurn(newHands, gameState.deck, gameState.play_order, gameState.current_player_index);
    } finally {
      setActing(false);
    }
  }

  // ── Double ──────────────────────────────────────────────────────────────────
  async function handleDouble() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    const hand = gameState.player_hands[entry.player_id][entry.hand_index];
    const myChips = gameState.player_chips[myPlayerId] ?? 0;
    if (myChips < hand.bet) return;
    setActing(true);
    try {
      const { card, deck } = dealCard(gameState.deck);
      const newCards = [...hand.cards, card];
      const bust = isBust(newCards);

      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...gameState.player_hands[entry.player_id]];
      newHands[entry.player_id][entry.hand_index] = {
        ...hand,
        cards: newCards,
        status: bust ? 'bust' : 'stand',
        bet: hand.bet * 2,
        doubled: true,
      };

      const newChips = { ...gameState.player_chips };
      newChips[entry.player_id] -= hand.bet;

      await advanceTurn(newHands, deck, gameState.play_order, gameState.current_player_index, newChips);
    } finally {
      setActing(false);
    }
  }

  // ── Split ───────────────────────────────────────────────────────────────────
  async function handleSplit() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    const { player_id, hand_index } = entry;
    const hand = gameState.player_hands[player_id][hand_index];
    const myChips = gameState.player_chips[player_id] ?? 0;
    if (myChips < hand.bet) return;
    setActing(true);
    try {
      let deck = gameState.deck;
      const [card1, card2] = hand.cards;

      const { card: nc1, deck: d1 } = dealCard(deck); deck = d1;
      const { card: nc2, deck: d2 } = dealCard(deck); deck = d2;

      const hand1: PlayerHand = { cards: [card1, nc1], status: isBlackjack([card1, nc1]) ? 'blackjack' : 'playing', bet: hand.bet, doubled: false };
      const hand2: PlayerHand = { cards: [card2, nc2], status: isBlackjack([card2, nc2]) ? 'blackjack' : 'playing', bet: hand.bet, doubled: false };

      const newPlayerHands = { ...gameState.player_hands };
      const playerHandArr = [...newPlayerHands[player_id]];
      playerHandArr[hand_index] = hand1;
      playerHandArr.push(hand2);
      newPlayerHands[player_id] = playerHandArr;
      const newHandIndex = playerHandArr.length - 1;

      // Insert second hand into play_order right after current
      const newPlayOrder: PlayOrderEntry[] = [
        ...gameState.play_order.slice(0, gameState.current_player_index + 1),
        { player_id, hand_index: newHandIndex },
        ...gameState.play_order.slice(gameState.current_player_index + 1),
      ];

      const newChips = { ...gameState.player_chips };
      newChips[player_id] -= hand.bet;

      // If first split hand is blackjack, skip to second
      let nextPlayIdx = gameState.current_player_index;
      if (hand1.status === 'blackjack') {
        nextPlayIdx += 1;
      }

      await supabase.from('game_state').update({
        deck,
        player_hands: newPlayerHands,
        play_order: newPlayOrder,
        current_player_index: nextPlayIdx,
        player_chips: newChips,
        updated_at: new Date().toISOString(),
      }).eq('room_id', roomId);
    } finally {
      setActing(false);
    }
  }

  // ── Next round ──────────────────────────────────────────────────────────────
  async function handleNextRound() {
    if (!gameState) return;
    const chips = gameState.player_chips;

    // Deactivate players with 0 chips
    for (const p of players) {
      if ((chips[p.id] ?? 0) <= 0) {
        await supabase.from('players').update({ is_active: false }).eq('id', p.id);
      }
    }

    // Re-fetch active players fresh from DB so cashed-out players are excluded
    const { data: activePlayers } = await supabase
      .from('players')
      .select()
      .eq('room_id', roomId)
      .eq('is_active', true)
      .order('created_at');

    const remaining = (activePlayers ?? []) as Player[];
    const emptyHands = Object.fromEntries(remaining.map(p => [p.id, []]));

    await supabase.from('game_state').update({
      deck: [],
      dealer_hand: [],
      player_hands: emptyHands,
      play_order: [],
      current_player_index: 0,
      phase: 'betting',
      player_bets: {},
      player_chips: chips,
      updated_at: new Date().toISOString(),
    }).eq('room_id', roomId);

    setPlayers(remaining);
  }

  // ── Cashout ─────────────────────────────────────────────────────────────────
  async function handleCashout() {
    const chips = gameState?.player_chips[myPlayerId] ?? 0;
    await supabase.from('players').update({ is_active: false, chips }).eq('id', myPlayerId);
    localStorage.removeItem('playerId');
    localStorage.removeItem('roomCode');
    navigate('/');
  }

  // ── Derived values ──────────────────────────────────────────────────────────
  if (!gameState) {
    return <div className="game-table"><p style={{ textAlign: 'center', marginTop: '4rem' }}>Loading…</p></div>;
  }

  const currentEntry = gameState.play_order[gameState.current_player_index];
  const isMyTurn = currentEntry?.player_id === myPlayerId && gameState.phase === 'player_turns';
  const myChips = gameState.player_chips[myPlayerId] ?? 0;
  const myHasBet = myPlayerId in gameState.player_bets;
  const currentHand = currentEntry
    ? gameState.player_hands[currentEntry.player_id]?.[currentEntry.hand_index]
    : null;
  const canDouble = isMyTurn && currentHand?.cards.length === 2 && myChips >= (currentHand?.bet ?? 0);
  const canSplitHand = isMyTurn && currentHand !== null && currentHand !== undefined && canSplit(currentHand.cards) && myChips >= (currentHand?.bet ?? 0);

  const dealerVisibleCards = gameState.phase === 'player_turns'
    ? gameState.dealer_hand.filter(c => !c.faceDown)
    : gameState.dealer_hand;
  const dealerValue = calculateHand(dealerVisibleCards);
  const dealerBust = gameState.phase === 'finished' && calculateHand(gameState.dealer_hand) > 21;

  // ── Betting phase ────────────────────────────────────────────────────────────
  if (gameState.phase === 'betting') {
    const activePlayers = players.filter(p => (gameState.player_chips[p.id] ?? 0) > 0);

    if (myChips <= 0) {
      return (
        <div className="game-table">
          <div className="phase-banner" style={{ marginTop: '4rem' }}>You're out of chips!</div>
          <div className="action-bar">
            <button className="btn btn-danger" onClick={handleCashout}>Cashout</button>
          </div>
        </div>
      );
    }

    return (
      <div className="game-table">
        <div className="betting-area">
          <h2 className="betting-title">Place Your Bets</h2>

          <div className="players-bets-list">
            {activePlayers.map(p => {
              const pBet = gameState.player_bets[p.id];
              const pChips = gameState.player_chips[p.id] ?? 0;
              return (
                <div key={p.id} className={`bet-player-row${pBet !== undefined ? ' bet-placed' : ''}`}>
                  <span className="bet-player-name">{p.name}{p.id === myPlayerId ? ' (You)' : ''}</span>
                  <span className="chips-display">🪙 {fmt(pChips)}</span>
                  {pBet !== undefined
                    ? <span className="bet-amount-badge">Bet: {fmt(pBet)}</span>
                    : <span className="bet-waiting">thinking…</span>}
                </div>
              );
            })}
          </div>

          {!myHasBet ? (
            <div className="bet-input-area">
              <p className="my-chips-label">Your chips: <span className="chips-display">🪙 {fmt(myChips)}</span></p>
              <div className="bet-presets">
                {[0.25, 0.5, 0.75, 1].map(frac => {
                  const amount = Math.max(1, Math.floor(myChips * frac));
                  return (
                    <button key={frac} className="btn btn-secondary" onClick={() => setBetInput(amount)}>
                      {frac === 1 ? 'All in' : `${frac * 100}%`}
                    </button>
                  );
                })}
              </div>
              <div className="bet-slider-row">
                <input
                  type="range"
                  min={1}
                  max={myChips}
                  value={Math.min(betInput, myChips)}
                  onChange={e => setBetInput(Number(e.target.value))}
                  className="bet-slider"
                />
                <input
                  type="number"
                  min={1}
                  max={myChips}
                  value={Math.min(betInput, myChips)}
                  onChange={e => setBetInput(Math.max(1, Math.min(Number(e.target.value), myChips)))}
                  className="bet-number-input"
                />
              </div>
              <button className="btn btn-primary" onClick={handlePlaceBet} disabled={acting}>
                Place Bet — {fmt(Math.min(betInput, myChips))} chips
              </button>
            </div>
          ) : (
            <div className="bet-waiting-msg">
              <p>Bet placed: <strong style={{ color: '#f0d060' }}>{fmt(gameState.player_bets[myPlayerId])} chips</strong></p>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem' }}>Waiting for others…</p>
            </div>
          )}

          <button className="btn btn-secondary" style={{ marginTop: '1rem', fontSize: '0.85rem' }} onClick={handleCashout}>
            Cashout (🪙 {fmt(myChips)})
          </button>
        </div>
      </div>
    );
  }

  // ── Game table ───────────────────────────────────────────────────────────────
  return (
    <div className="game-table">
      {/* Dealer */}
      <div className="dealer-area">
        <h3>Dealer</h3>
        <div className="cards-row">
          {gameState.dealer_hand.map((card, i) => <CardComponent key={i} card={card} />)}
        </div>
        <div className={`hand-value${dealerBust ? ' bust' : ''}`}>
          {gameState.phase === 'player_turns' ? dealerValue : calculateHand(gameState.dealer_hand) > 21 ? 'BUST' : calculateHand(gameState.dealer_hand)}
        </div>
      </div>

      {gameState.phase === 'dealer_turn' && <div className="phase-banner">Dealer's Turn…</div>}
      {gameState.phase === 'finished' && <div className="phase-banner">Round Over!</div>}

      {/* Players */}
      <div className="players-row">
        {players.map(player => {
          const allHands = gameState.player_hands[player.id] ?? [];
          if (allHands.length === 0) return null;
          return (
            <div key={player.id} className="player-column">
              <span className="player-name">
                {player.name}{player.id === myPlayerId ? ' (You)' : ''}
              </span>
              <span className="chips-display small">🪙 {fmt(gameState.player_chips[player.id] ?? 0)}</span>
              <div className="player-hands-row">
                {allHands.map((hand, hIdx) => {
                  const isActiveHand =
                    currentEntry?.player_id === player.id &&
                    currentEntry?.hand_index === hIdx &&
                    gameState.phase === 'player_turns';
                  const areaClass = [
                    'player-area',
                    isActiveHand ? 'active' : '',
                    hand.status === 'bust' ? 'bust-area' : '',
                    (hand.status === 'stand' || hand.status === 'blackjack') ? 'stand-area' : '',
                  ].filter(Boolean).join(' ');

                  const hvClass = `hand-value${hand.status === 'bust' ? ' bust' : hand.status === 'blackjack' ? ' blackjack' : ''}`;
                  const handVal = hand.status === 'bust' ? 'BUST' : hand.status === 'blackjack' ? 'BJ!' : calculateHand(hand.cards);

                  return (
                    <div key={hIdx} className={areaClass}>
                      {allHands.length > 1 && <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)' }}>Hand {hIdx + 1}</span>}
                      <div className="cards-row">
                        {hand.cards.map((card, i) => <CardComponent key={i} card={card} />)}
                      </div>
                      <div className={hvClass}>{handVal}</div>
                      <span className={`player-status-badge status-${hand.status}`}>
                        {hand.status === 'playing' ? 'Playing' : hand.status === 'stand' ? 'Stand' : hand.status === 'bust' ? 'Bust' : hand.status === 'blackjack' ? 'Blackjack!' : 'Waiting'}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                        Bet: {fmt(hand.bet)}{hand.doubled ? ' (2×)' : ''}
                      </span>
                      {hand.result && (
                        <span className={`result-badge result-${hand.result}`}>
                          {hand.result === 'win' ? '▲ WIN' : hand.result === 'lose' ? '▼ LOSE' : '= PUSH'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action bar */}
      {isMyTurn && (
        <div className="action-bar">
          <button className="btn btn-primary" onClick={handleHit} disabled={acting}>HIT</button>
          <button className="btn btn-secondary" onClick={handleStand} disabled={acting}>STAND</button>
          <button className="btn btn-danger" onClick={handleDouble} disabled={acting || !canDouble}>
            DOUBLE
          </button>
          {canSplitHand && (
            <button className="btn btn-success" onClick={handleSplit} disabled={acting}>
              SPLIT
            </button>
          )}
        </div>
      )}

      {!isMyTurn && gameState.phase === 'player_turns' && currentEntry && (
        <div className="phase-banner">
          Waiting for {players.find(p => p.id === currentEntry.player_id)?.name ?? '…'}
          {gameState.play_order[gameState.current_player_index]?.hand_index !== undefined &&
           (gameState.player_hands[currentEntry.player_id]?.length ?? 0) > 1
            ? ` (Hand ${gameState.play_order[gameState.current_player_index].hand_index + 1})`
            : ''}
          …
        </div>
      )}

      {gameState.phase === 'finished' && (
        <div className="action-bar" style={{ flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-success" onClick={handleNextRound}>Next Round</button>
            <button className="btn btn-danger" onClick={handleCashout}>
              Cashout (🪙 {fmt(myChips)})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
