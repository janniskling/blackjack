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
import type { Card } from '../lib/blackjack';
import CardComponent from '../components/CardComponent';
import type { RealtimeChannel } from '@supabase/supabase-js';

function fmt(n: number) { return n.toLocaleString(); }

// ── Flying card animation element ───────────────────────────────────────────
interface FlyingCardData {
  id: string;
  startX: number; startY: number;
  endX: number;   endY: number;
  delay: number;
  cardKey: string;
}

function FlyingCardEl({
  startX, startY, endX, endY, delay, onLand,
}: { startX: number; startY: number; endX: number; endY: number; delay: number; onLand: () => void }) {
  const [flying, setFlying] = useState(false);
  const [gone, setGone]     = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setFlying(true);
      setTimeout(() => { setGone(true); onLand(); }, 420);
    }, delay);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line

  if (gone) return null;

  const dx = endX - startX;
  const dy = endY - startY;
  const rot = dx > 0 ? 6 : dx < -20 ? -6 : 0; // slight rotation based on direction

  return (
    <div style={{
      position: 'fixed',
      left: startX,
      top:  startY,
      width: 54,
      height: 78,
      borderRadius: 7,
      background: '#fff',
      border: '1px solid rgba(0,0,0,0.12)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      zIndex: 999,
      pointerEvents: 'none',
      opacity: flying ? 1 : 0,
      transform: flying
        ? `translate(${dx}px, ${dy}px) rotate(${rot}deg)`
        : 'translate(0,0) rotate(0deg)',
      transition: flying
        ? 'transform 0.42s cubic-bezier(0.2,0.8,0.3,1), opacity 0.06s'
        : 'opacity 0.06s',
    }} />
  );
}

// ── Main Game component ──────────────────────────────────────────────────────
export default function Game() {
  const { code } = useParams<{ code: string }>();
  const navigate  = useNavigate();

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [players,   setPlayers]   = useState<Player[]>([]);
  const [roomId,    setRoomId]    = useState('');
  const [acting,    setActing]    = useState(false);
  const [betInput,  setBetInput]  = useState(100);
  const [easterEgg, setEasterEgg] = useState(false);

  // Flying card animation
  const [flyingCards,      setFlyingCards]      = useState<FlyingCardData[]>([]);
  const [visibleCardKeys,  setVisibleCardKeys]  = useState<Set<string> | null>(null); // null = show all

  const dealerRanRef      = useRef(false);
  const broadcastRef      = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const prevPhaseRef      = useRef<string | null>(null);
  const dealerAreaRef     = useRef<HTMLDivElement>(null);
  const playerColumnRefs  = useRef<Map<string, HTMLDivElement>>(new Map());

  function triggerEasterEgg() {
    setEasterEgg(true);
    setTimeout(() => setEasterEgg(false), 2000);
  }

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
      const myId = localStorage.getItem('playerId');
      if (myId && !updatedPlayers.some(p => p.id === myId)) {
        localStorage.removeItem('playerId');
        localStorage.removeItem('roomCode');
      }
    });
    const bcChannel = supabase
      .channel(`easter_egg:${roomId}`)
      .on('broadcast', { event: 'easter_egg' }, () => triggerEasterEgg())
      .subscribe();
    broadcastRef.current = bcChannel;
    return () => {
      gsChannel.unsubscribe();
      plChannel.unsubscribe();
      bcChannel.unsubscribe();
      broadcastRef.current = null;
    };
  }, [roomId]);

  // ── Flying card animation: trigger on betting → player_turns ───────────────
  useEffect(() => {
    if (!gameState) return;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = gameState.phase;

    if (prev !== 'betting' || gameState.phase !== 'player_turns') return;

    const snapshot = gameState;
    setVisibleCardKeys(new Set()); // hide all real cards

    // Wait one frame so player-column DOM elements exist
    setTimeout(() => {
      const dealerRect = dealerAreaRef.current?.getBoundingClientRect();
      if (!dealerRect) { setVisibleCardKeys(null); return; }

      const srcX = dealerRect.left + dealerRect.width / 2 - 27;
      const srcY = dealerRect.top  + dealerRect.height / 2 - 39;

      const uniquePlayerIds = [...new Set(snapshot.play_order.map(e => e.player_id))];
      const N = uniquePlayerIds.length;
      const cards: FlyingCardData[] = [];

      // Two rounds: first card to everyone, then second card to everyone
      for (let round = 0; round < 2; round++) {
        for (let pi = 0; pi <= N; pi++) {  // pi === N means dealer
          const isDealer = pi === N;
          const delay    = (round * (N + 1) + pi) * 420;

          let endX: number, endY: number, cardKey: string;

          if (isDealer) {
            // Dealer's card lands slightly below the source (in dealer area)
            endX    = srcX;
            endY    = srcY + (round === 1 ? 10 : 0);
            cardKey = `dealer_${round}`;
          } else {
            const playerId = uniquePlayerIds[pi];
            const colEl    = playerColumnRefs.current.get(playerId);
            const colRect  = colEl?.getBoundingClientRect();
            endX    = colRect ? colRect.left + colRect.width / 2 - 27 : srcX;
            endY    = colRect ? colRect.top  + 30                       : srcY + 180;
            cardKey = `${playerId}_${round}`;
          }

          cards.push({
            id: `${cardKey}_${Date.now()}`,
            startX: srcX, startY: srcY,
            endX, endY,
            delay,
            cardKey,
          });
        }
      }

      setFlyingCards(cards);

      // After all cards have landed, show everything and clear flying cards
      const totalMs = (N + 1) * 2 * 420 + 500;
      setTimeout(() => {
        setVisibleCardKeys(null);
        setFlyingCards([]);
      }, totalMs);
    }, 60);
  }, [gameState?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function isCardVisible(cardKey: string): boolean {
    return visibleCardKeys === null || visibleCardKeys.has(cardKey);
  }

  // ── Auto-run dealer phase (normal / non-PvP mode only) ─────────────────────
  useEffect(() => {
    if (!gameState) return;
    if (gameState.pvp_dealer_id) return;
    if (gameState.phase !== 'dealer_turn' || dealerRanRef.current) return;
    dealerRanRef.current = true;

    const gs = gameState;
    (async () => {
      const { finalHand, updatedDeck } = runDealerLogic(gs.dealer_hand, gs.deck);
      const dealerBJ  = isBlackjack(finalHand);
      const newHands: Record<string, PlayerHand[]> = {};
      const newChips  = { ...gs.player_chips };

      for (const [pid, hands] of Object.entries(gs.player_hands)) {
        newHands[pid] = hands.map(hand => {
          let result: 'win' | 'lose' | 'push';
          if      (hand.status === 'bust')      result = 'lose';
          else if (hand.status === 'blackjack') result = dealerBJ ? 'push' : 'win';
          else                                  result = determineWinner(hand.cards, finalHand);
          if      (result === 'win')  newChips[pid] += hand.status === 'blackjack' ? Math.floor(hand.bet * 2.5) : hand.bet * 2;
          else if (result === 'push') newChips[pid] += hand.bet;
          return { ...hand, result };
        });
      }

      const { error } = await supabase.from('game_state').update({
        dealer_hand: finalHand, deck: updatedDeck,
        player_hands: newHands, player_chips: newChips,
        phase: 'finished', updated_at: new Date().toISOString(),
      }).eq('room_id', roomId).eq('phase', 'dealer_turn');

      if (!error) {
        for (const [pid, chips] of Object.entries(newChips))
          await supabase.from('players').update({ chips }).eq('id', pid);
      }
    })();
  }, [gameState?.phase, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PvP: auto-finish if dealer enters dealer_turn already at 17+ ────────────
  useEffect(() => {
    if (!gameState) return;
    if (!gameState.pvp_dealer_id || myPlayerId !== gameState.pvp_dealer_id) return;
    if (gameState.phase !== 'dealer_turn' || dealerRanRef.current) return;

    const fullHand = gameState.dealer_hand.map(c => ({ ...c, faceDown: false }));
    if (calculateHand(fullHand) >= 17) {
      dealerRanRef.current = true;
      runPvpPayouts(gameState, fullHand, gameState.deck);
    }
  }, [gameState?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PvP: calculate payouts and finish ──────────────────────────────────────
  async function runPvpPayouts(gs: GameState, finalDealerHand: Card[], finalDeck: Card[]) {
    const dealerBJ = isBlackjack(finalDealerHand);
    const newHands: Record<string, PlayerHand[]> = {};
    const newChips = { ...gs.player_chips };

    for (const [pid, hands] of Object.entries(gs.player_hands)) {
      newHands[pid] = hands.map(hand => {
        let result: 'win' | 'lose' | 'push';
        if      (hand.status === 'bust')      result = 'lose';
        else if (hand.status === 'blackjack') result = dealerBJ ? 'push' : 'win';
        else                                  result = determineWinner(hand.cards, finalDealerHand);
        if      (result === 'win')  newChips[pid] += hand.status === 'blackjack' ? Math.floor(hand.bet * 2.5) : hand.bet * 2;
        else if (result === 'push') newChips[pid] += hand.bet;
        return { ...hand, result };
      });
    }

    const { error } = await supabase.from('game_state').update({
      dealer_hand: finalDealerHand, deck: finalDeck,
      player_hands: newHands, player_chips: newChips,
      phase: 'finished', updated_at: new Date().toISOString(),
    }).eq('room_id', roomId).eq('phase', 'dealer_turn');

    if (!error) {
      for (const [pid, chips] of Object.entries(newChips))
        await supabase.from('players').update({ chips }).eq('id', pid);
    }
  }

  // ── PvP: dealer hits a card ─────────────────────────────────────────────────
  async function handlePvpDealerHit() {
    if (!gameState || acting) return;
    setActing(true);
    try {
      const { card, deck } = dealCard(gameState.deck);
      const newHand = gameState.dealer_hand.map(c => ({ ...c, faceDown: false }));
      newHand.push({ ...card, faceDown: false });

      if (calculateHand(newHand) >= 17) {
        await runPvpPayouts(gameState, newHand, deck);
      } else {
        await supabase.from('game_state').update({
          dealer_hand: newHand, deck,
          updated_at: new Date().toISOString(),
        }).eq('room_id', roomId);
      }
    } finally {
      setActing(false);
    }
  }

  // ── Advance turn helper ─────────────────────────────────────────────────────
  async function advanceTurn(
    updatedHands: Record<string, PlayerHand[]>,
    updatedDeck: Card[],
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
      deck: updatedDeck, player_hands: updatedHands,
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

    if (bet === 400) {
      triggerEasterEgg();
      broadcastRef.current?.send({ type: 'broadcast', event: 'easter_egg', payload: {} });
    }

    try {
      const pvpDealerId    = gameState.pvp_dealer_id ?? null;
      const newBets        = { ...gameState.player_bets, [myPlayerId]: bet };
      const allActive      = players.filter(p => (gameState.player_chips[p.id] ?? 0) > 0);
      const bettingPlayers = pvpDealerId ? allActive.filter(p => p.id !== pvpDealerId) : allActive;
      const allBet         = bettingPlayers.length > 0 && bettingPlayers.every(p => newBets[p.id] !== undefined);

      if (!allBet) {
        await supabase.from('game_state').update({
          player_bets: newBets, updated_at: new Date().toISOString(),
        }).eq('room_id', roomId);
        return;
      }

      let deck = createDeck();
      const playerHandsMap: Record<string, PlayerHand[]> = {};

      for (const p of bettingPlayers) {
        const b = newBets[p.id];
        const { card: c1, deck: d1 } = dealCard(deck); deck = d1;
        const { card: c2, deck: d2 } = dealCard(deck); deck = d2;
        const cards  = [c1, c2];
        const status = isBlackjack(cards) ? 'blackjack' : 'playing';
        playerHandsMap[p.id] = [{ cards, status, bet: b, doubled: false }];
      }

      const { card: dc1, deck: d3 } = dealCard(deck); deck = d3;
      const { card: dc2, deck: d4 } = dealCard(deck); deck = d4;
      const dealerHand = [dc1, { ...dc2, faceDown: true }];

      const playOrder: PlayOrderEntry[] = [];
      for (const p of bettingPlayers) {
        if (playerHandsMap[p.id][0]?.status === 'playing')
          playOrder.push({ player_id: p.id, hand_index: 0 });
      }

      const newChips = { ...gameState.player_chips };
      for (const p of bettingPlayers) {
        if (!(p.id in newChips)) newChips[p.id] = p.chips;
        newChips[p.id] -= newBets[p.id];
      }

      const phase = playOrder.length === 0 ? 'dealer_turn' : 'player_turns';

      await supabase.from('game_state').update({
        deck, dealer_hand: dealerHand, player_hands: playerHandsMap,
        play_order: playOrder, current_player_index: 0,
        phase, player_bets: newBets, player_chips: newChips,
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
      const hands    = gameState.player_hands[entry.player_id];
      const hand     = hands[entry.hand_index];
      const newCards = [...hand.cards, card];
      const bust     = isBust(newCards);
      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...hands];
      newHands[entry.player_id][entry.hand_index] = { ...hand, cards: newCards, status: bust ? 'bust' : 'playing' };
      if (bust) await advanceTurn(newHands, deck, gameState.play_order, gameState.current_player_index);
      else await supabase.from('game_state').update({ deck, player_hands: newHands, updated_at: new Date().toISOString() }).eq('room_id', roomId);
    } finally { setActing(false); }
  }

  // ── Stand ───────────────────────────────────────────────────────────────────
  async function handleStand() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    setActing(true);
    try {
      const hands    = gameState.player_hands[entry.player_id];
      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...hands];
      newHands[entry.player_id][entry.hand_index] = { ...hands[entry.hand_index], status: 'stand' };
      await advanceTurn(newHands, gameState.deck, gameState.play_order, gameState.current_player_index);
    } finally { setActing(false); }
  }

  // ── Double ──────────────────────────────────────────────────────────────────
  async function handleDouble() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    const hand    = gameState.player_hands[entry.player_id][entry.hand_index];
    const myChips = gameState.player_chips[myPlayerId] ?? 0;
    if (myChips < hand.bet) return;
    setActing(true);
    try {
      const { card, deck } = dealCard(gameState.deck);
      const newCards = [...hand.cards, card];
      const bust     = isBust(newCards);
      const newHands = { ...gameState.player_hands };
      newHands[entry.player_id] = [...gameState.player_hands[entry.player_id]];
      newHands[entry.player_id][entry.hand_index] = { ...hand, cards: newCards, status: bust ? 'bust' : 'stand', bet: hand.bet * 2, doubled: true };
      const newChips = { ...gameState.player_chips };
      newChips[entry.player_id] -= hand.bet;
      await advanceTurn(newHands, deck, gameState.play_order, gameState.current_player_index, newChips);
    } finally { setActing(false); }
  }

  // ── Split ───────────────────────────────────────────────────────────────────
  async function handleSplit() {
    if (!gameState || acting) return;
    const entry = gameState.play_order[gameState.current_player_index];
    if (!entry) return;
    const { player_id, hand_index } = entry;
    const hand    = gameState.player_hands[player_id][hand_index];
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
      const playerHandArr  = [...newPlayerHands[player_id]];
      playerHandArr[hand_index] = hand1;
      playerHandArr.push(hand2);
      newPlayerHands[player_id] = playerHandArr;
      const newHandIndex   = playerHandArr.length - 1;
      const newPlayOrder: PlayOrderEntry[] = [
        ...gameState.play_order.slice(0, gameState.current_player_index + 1),
        { player_id, hand_index: newHandIndex },
        ...gameState.play_order.slice(gameState.current_player_index + 1),
      ];
      const newChips = { ...gameState.player_chips };
      newChips[player_id] -= hand.bet;
      let nextPlayIdx = gameState.current_player_index;
      if (hand1.status === 'blackjack') nextPlayIdx += 1;
      await supabase.from('game_state').update({
        deck, player_hands: newPlayerHands, play_order: newPlayOrder,
        current_player_index: nextPlayIdx, player_chips: newChips,
        updated_at: new Date().toISOString(),
      }).eq('room_id', roomId);
    } finally { setActing(false); }
  }

  // ── Next round ──────────────────────────────────────────────────────────────
  async function handleNextRound() {
    if (!gameState) return;
    const chips       = { ...gameState.player_chips };
    const pvpDealerId = gameState.pvp_dealer_id ?? null;

    for (const p of players) {
      if (p.id === pvpDealerId) continue;
      if ((chips[p.id] ?? p.chips) <= 0)
        await supabase.from('players').update({ is_active: false }).eq('id', p.id);
    }

    const { data: activePlayers } = await supabase
      .from('players').select().eq('room_id', roomId).eq('is_active', true).order('created_at');
    const remaining = (activePlayers ?? []) as Player[];

    for (const p of remaining) {
      if (p.id === pvpDealerId) continue;
      if (!(p.id in chips)) chips[p.id] = p.chips;
    }
    if (pvpDealerId) delete chips[pvpDealerId];

    const emptyHands = Object.fromEntries(
      remaining.filter(p => p.id !== pvpDealerId).map(p => [p.id, []])
    );

    await supabase.from('game_state').update({
      deck: [], dealer_hand: [], player_hands: emptyHands,
      play_order: [], current_player_index: 0,
      phase: 'betting', player_bets: {}, player_chips: chips,
      updated_at: new Date().toISOString(),
    }).eq('room_id', roomId);

    setPlayers(remaining);
  }

  // ── Cashout / dealer leave ──────────────────────────────────────────────────
  async function handleCashout() {
    const chips = gameState?.player_chips[myPlayerId] ?? 0;
    await supabase.from('players').update({ is_active: false, chips }).eq('id', myPlayerId);
    localStorage.removeItem('playerId');
    localStorage.removeItem('roomCode');
    navigate('/');
  }

  async function handleDealerLeave() {
    await supabase.from('players').update({ is_active: false }).eq('id', myPlayerId);
    // Mark room finished so no one can join
    const { data: room } = await supabase.from('rooms').select('id').eq('code', code ?? '').single();
    if (room) await supabase.from('rooms').update({ status: 'finished' }).eq('id', room.id);
    localStorage.removeItem('playerId');
    localStorage.removeItem('roomCode');
    navigate('/');
  }

  // ── Guard ───────────────────────────────────────────────────────────────────
  if (!gameState) {
    return <div className="game-table"><p style={{ textAlign: 'center', marginTop: '4rem' }}>Loading…</p></div>;
  }

  // ── Derived values ──────────────────────────────────────────────────────────
  const pvpDealerId       = gameState.pvp_dealer_id ?? null;
  const isPvpMode         = pvpDealerId !== null;
  const isDealer          = isPvpMode && myPlayerId === pvpDealerId;
  const pvpDealerPlayer   = isPvpMode ? players.find(p => p.id === pvpDealerId) : null;

  const nonDealerPlayers  = isPvpMode ? players.filter(p => p.id !== pvpDealerId) : players;
  const dealerAlone       = isPvpMode && isDealer && nonDealerPlayers.length === 0;

  const currentEntry      = gameState.play_order[gameState.current_player_index];
  const isMyTurn          = currentEntry?.player_id === myPlayerId && gameState.phase === 'player_turns';
  const myPlayer          = players.find(p => p.id === myPlayerId);
  const myChips           = gameState.player_chips[myPlayerId] ?? myPlayer?.chips ?? 0;
  const myHasBet          = myPlayerId in gameState.player_bets;
  const currentHand       = currentEntry ? gameState.player_hands[currentEntry.player_id]?.[currentEntry.hand_index] : null;
  const currentHandValue  = currentHand ? calculateHand(currentHand.cards) : 0;
  const canDouble         = isMyTurn && currentHand?.cards.length === 2 && myChips >= (currentHand?.bet ?? 0) && [9, 10, 11].includes(currentHandValue);
  const canSplitHand      = isMyTurn && currentHand !== null && currentHand !== undefined && canSplit(currentHand.cards) && myChips >= (currentHand?.bet ?? 0);

  // Dealer hand display: PvP dealer sees their own hole card
  const dealerHandForDisplay: Card[] = gameState.dealer_hand.map(c => {
    if (!c.faceDown) return c;
    if (isDealer) return { ...c, faceDown: false };
    if (gameState.phase === 'dealer_turn' || gameState.phase === 'finished') return { ...c, faceDown: false };
    return c;
  });

  const dealerVisibleForValue = gameState.phase === 'player_turns' && !isDealer
    ? gameState.dealer_hand.filter(c => !c.faceDown)
    : dealerHandForDisplay;
  const dealerDisplayValue  = calculateHand(dealerVisibleForValue);
  const dealerFullValue     = calculateHand(dealerHandForDisplay);
  const dealerBust          = gameState.phase === 'finished' && dealerFullValue > 21;
  const isPvpDealerTurn     = isPvpMode && gameState.phase === 'dealer_turn';
  const pvpDealerHandValue  = calculateHand(dealerHandForDisplay);
  const pvpDealerMustHit    = isPvpDealerTurn && pvpDealerHandValue < 17;

  // ── Betting phase ────────────────────────────────────────────────────────────
  if (gameState.phase === 'betting') {
    const allActive      = players.filter(p => (gameState.player_chips[p.id] ?? p.chips) > 0);
    const bettingPlayers = isPvpMode ? allActive.filter(p => p.id !== pvpDealerId) : allActive;

    if (isDealer) {
      return (
        <div className="game-table">
          <div className="betting-area">
            <h2 className="betting-title">You are the Dealer</h2>
            <div className="room-code-small">Room: <span>{code}</span></div>
            {dealerAlone ? (
              <div className="dealer-waiting-badge" style={{ color: '#ff9966' }}>
                All players have left.
              </div>
            ) : (
              <div className="dealer-waiting-badge">🃏 Waiting for players to place their bets…</div>
            )}
            <div className="players-bets-list">
              {bettingPlayers.map(p => {
                const pBet   = gameState.player_bets[p.id];
                const pChips = gameState.player_chips[p.id] ?? 0;
                return (
                  <div key={p.id} className={`bet-player-row${pBet !== undefined ? ' bet-placed' : ''}`}>
                    <span className="bet-player-name">{p.name}</span>
                    <span className="chips-display">🪙 {fmt(pChips)}</span>
                    {pBet !== undefined
                      ? <span className="bet-amount-badge">Bet: {fmt(pBet)}</span>
                      : <span className="bet-waiting">thinking…</span>}
                  </div>
                );
              })}
            </div>
            {dealerAlone && (
              <button className="btn btn-secondary" onClick={handleDealerLeave}>
                Leave Room
              </button>
            )}
          </div>
        </div>
      );
    }

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
          <div className="room-code-small">Room: <span>{code}</span></div>

          <div className="players-bets-list">
            {bettingPlayers.map(p => {
              const pBet   = gameState.player_bets[p.id];
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
            {isPvpMode && (
              <div className="bet-player-row">
                <span className="bet-player-name">{pvpDealerPlayer?.name ?? 'Dealer'}</span>
                <span className="dealer-role-badge">🃏 Dealer</span>
              </div>
            )}
          </div>

          {!myHasBet ? (
            <div className="bet-input-area">
              <p className="my-chips-label">Your chips: <span className="chips-display">🪙 {fmt(myChips)}</span></p>
              <div className="bet-presets">
                {[50, 100, 500].map(amount => (
                  <button key={amount} className="btn btn-secondary"
                    onClick={() => setBetInput(prev => Math.min(prev + amount, myChips))}>
                    +{amount}
                  </button>
                ))}
                <button className="btn btn-secondary" onClick={() => setBetInput(myChips)}>All in</button>
              </div>
              <div className="bet-slider-row">
                <input type="range" min={1} max={myChips} value={Math.min(betInput, myChips)}
                  onChange={e => setBetInput(Number(e.target.value))} className="bet-slider" />
                <input type="number" min={1} max={myChips} value={Math.min(betInput, myChips)}
                  onChange={e => setBetInput(Math.max(1, Math.min(Number(e.target.value), myChips)))}
                  className="bet-number-input" />
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
      {/* Dealer area */}
      <div
        className={`dealer-area${isPvpDealerTurn && isDealer ? ' dealer-area-active' : ''}`}
        ref={dealerAreaRef}
      >
        <h3>{isPvpMode ? `${pvpDealerPlayer?.name ?? 'Dealer'} — Dealer` : 'Dealer'}</h3>
        <div className="cards-row">
          {dealerHandForDisplay.map((card, i) =>
            isCardVisible(`dealer_${i}`)
              ? <CardComponent key={i} card={card} />
              : null
          )}
        </div>
        <div className={`hand-value${dealerBust ? ' bust' : ''}`}>
          {gameState.phase === 'player_turns' ? dealerDisplayValue : dealerBust ? 'BUST' : dealerFullValue}
        </div>
        {isDealer && gameState.phase === 'player_turns' && (
          <div className="dealer-peek-hint">Only you can see your face-down card</div>
        )}
      </div>

      {/* Dealer-alone notice */}
      {dealerAlone && (
        <div className="phase-banner" style={{ background: 'rgba(255,100,50,0.15)', color: '#ff9966' }}>
          All players have left.{' '}
          <button className="btn btn-secondary" style={{ marginLeft: '0.75rem', fontSize: '0.85rem' }} onClick={handleDealerLeave}>
            Leave Room
          </button>
        </div>
      )}

      {/* Phase banners */}
      {gameState.phase === 'dealer_turn' && !isPvpMode && <div className="phase-banner">Dealer's Turn…</div>}
      {isPvpDealerTurn && !isDealer && (
        <div className="phase-banner">{pvpDealerPlayer?.name ?? 'Dealer'}'s Turn…</div>
      )}
      {gameState.phase === 'finished' && <div className="phase-banner">Round Over!</div>}
      {gameState.phase !== 'finished' && !(myPlayerId in gameState.player_hands) && myPlayerId && !isDealer && (
        <div className="phase-banner" style={{ background: 'rgba(240,208,96,0.12)', color: '#f0d060' }}>
          You're joining next round — watching for now 👀
        </div>
      )}

      {/* Players */}
      <div className="players-row">
        {players.map(player => {
          if (player.id === pvpDealerId) return null;
          const allHands = gameState.player_hands[player.id] ?? [];
          if (allHands.length === 0) return null;
          return (
            <div
              key={player.id}
              className="player-column"
              ref={el => {
                if (el) playerColumnRefs.current.set(player.id, el);
                else    playerColumnRefs.current.delete(player.id);
              }}
            >
              <span className="player-name">{player.name}{player.id === myPlayerId ? ' (You)' : ''}</span>
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
                  const hvClass  = `hand-value${hand.status === 'bust' ? ' bust' : hand.status === 'blackjack' ? ' blackjack' : ''}`;
                  const handVal  = hand.status === 'bust' ? 'BUST' : hand.status === 'blackjack' ? 'BJ!' : calculateHand(hand.cards);

                  return (
                    <div key={hIdx} className={areaClass}>
                      {allHands.length > 1 && <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)' }}>Hand {hIdx + 1}</span>}
                      <div className="cards-row">
                        {hand.cards.map((card, i) =>
                          isCardVisible(`${player.id}_${i}`)
                            ? <CardComponent key={i} card={card} />
                            : null
                        )}
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

      {/* Player action bar */}
      {isMyTurn && (
        <div className="action-bar">
          <button className="btn btn-primary"   onClick={handleHit}    disabled={acting}>HIT</button>
          <button className="btn btn-secondary" onClick={handleStand}  disabled={acting}>STAND</button>
          <button className="btn btn-danger"    onClick={handleDouble} disabled={acting || !canDouble}>DOUBLE</button>
          {canSplitHand && (
            <button className="btn btn-success" onClick={handleSplit} disabled={acting}>SPLIT</button>
          )}
        </div>
      )}

      {!isMyTurn && gameState.phase === 'player_turns' && currentEntry && (
        <div className="phase-banner">
          Waiting for {players.find(p => p.id === currentEntry.player_id)?.name ?? '…'}
          {(gameState.player_hands[currentEntry.player_id]?.length ?? 0) > 1
            ? ` (Hand ${gameState.play_order[gameState.current_player_index].hand_index + 1})`
            : ''}…
        </div>
      )}

      {/* PvP Dealer action bar */}
      {isPvpDealerTurn && isDealer && (
        <div className="action-bar">
          {pvpDealerMustHit ? (
            <>
              <button className="btn btn-primary" onClick={handlePvpDealerHit} disabled={acting}>HIT</button>
              <button className="btn btn-secondary" disabled style={{ opacity: 0.3 }}>STAND (min. 17)</button>
            </>
          ) : (
            <div style={{ color: '#f0d060', fontWeight: 700 }}>
              {pvpDealerHandValue} — Standing automatically…
            </div>
          )}
        </div>
      )}

      {gameState.phase === 'finished' && (
        <div className="action-bar" style={{ flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-success" onClick={handleNextRound}>Next Round</button>
            {!isDealer && (
              <button className="btn btn-danger" onClick={handleCashout}>
                Cashout (🪙 {fmt(myChips)})
              </button>
            )}
            {isDealer && dealerAlone && (
              <button className="btn btn-secondary" onClick={handleDealerLeave}>Leave Room</button>
            )}
          </div>
        </div>
      )}

      {/* Flying card animation overlay */}
      {flyingCards.map(fc => (
        <FlyingCardEl
          key={fc.id}
          startX={fc.startX} startY={fc.startY}
          endX={fc.endX}     endY={fc.endY}
          delay={fc.delay}
          onLand={() => {
            setVisibleCardKeys(prev =>
              prev === null ? null : new Set([...prev, fc.cardKey])
            );
          }}
        />
      ))}

      {easterEgg && <div className="easter-egg-overlay">Lasst uns ownen 🃏</div>}
    </div>
  );
}
