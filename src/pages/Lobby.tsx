import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Player, Room } from '../lib/supabase';
import { subscribeToPlayers, subscribeToRoom } from '../lib/realtime';
import type { RealtimeChannel } from '@supabase/supabase-js';

export default function Lobby() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [pvpMode, setPvpMode] = useState(false);
  const [selectedDealerId, setSelectedDealerId] = useState('');

  const myPlayerId = localStorage.getItem('playerId');

  // Auto-select first player as dealer when PvP mode activates
  useEffect(() => {
    if (pvpMode && !selectedDealerId && players.length > 0) {
      setSelectedDealerId(players[0].id);
    }
  }, [pvpMode, players, selectedDealerId]);

  useEffect(() => {
    if (!code) return;

    supabase
      .from('rooms')
      .select()
      .eq('code', code)
      .single()
      .then(({ data, error }) => {
        if (error || !data) { setError('Room not found'); return; }
        setRoom(data as Room);

        if (data.status === 'playing') {
          navigate(`/game/${code}`);
          return;
        }

        supabase
          .from('players')
          .select()
          .eq('room_id', data.id)
          .eq('is_active', true)
          .order('created_at')
          .then(({ data: p }) => {
            if (!p) return;
            setPlayers(p as Player[]);
            const myId = localStorage.getItem('playerId');
            if (myId && !p.some(pl => pl.id === myId)) {
              localStorage.removeItem('playerId');
              localStorage.removeItem('roomCode');
              navigate('/');
            }
          });
      });
  }, [code, navigate]);

  useEffect(() => {
    if (!room) return;
    const channels: RealtimeChannel[] = [];

    channels.push(
      subscribeToPlayers(room.id, setPlayers),
      subscribeToRoom(room.id, status => {
        if (status === 'playing') navigate(`/game/${code}`);
      })
    );

    return () => { channels.forEach(c => c.unsubscribe()); };
  }, [room, code, navigate]);

  async function handleStartGame() {
    if (!room || players.length < 2) return;
    setStarting(true);

    try {
      const pvpDealerId = pvpMode && selectedDealerId ? selectedDealerId : null;

      const playerChips: Record<string, number> = {};
      for (const p of players) {
        if (p.id === pvpDealerId) continue; // Dealer has no chips in PvP mode
        playerChips[p.id] = room.starting_chips;
        await supabase.from('players').update({ chips: room.starting_chips }).eq('id', p.id);
      }

      const emptyHands = Object.fromEntries(
        players
          .filter(p => p.id !== pvpDealerId)
          .map(p => [p.id, []])
      );

      await supabase.from('game_state').upsert({
        room_id: room.id,
        deck: [],
        dealer_hand: [],
        player_hands: emptyHands,
        play_order: [],
        current_player_index: 0,
        phase: 'betting',
        player_bets: {},
        player_chips: playerChips,
        pvp_dealer_id: pvpDealerId,
        updated_at: new Date().toISOString(),
      });

      await supabase.from('rooms').update({ status: 'playing' }).eq('id', room.id);
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to start game');
      setStarting(false);
    }
  }

  if (error) {
    return (
      <div className="lobby">
        <p className="error-msg">{error}</p>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>Go Home</button>
      </div>
    );
  }

  if (!room) return <div className="lobby"><p>Loading…</p></div>;

  return (
    <div className="lobby">
      <div className="lobby-header">
        <h1>Waiting Room</h1>
        <div className="room-code-display">{code}</div>
        <p className="lobby-subtitle">Share this code with friends</p>
        {room.starting_chips > 0 && (
          <p className="lobby-subtitle" style={{ marginTop: '0.25rem' }}>
            Starting chips: <strong style={{ color: '#f0d060' }}>{room.starting_chips.toLocaleString()}</strong>
            {' '}(€{room.starting_chips / 100})
          </p>
        )}
      </div>

      <div className="players-list">
        <h3>Players ({players.length})</h3>
        {players.map(p => (
          <div key={p.id} className="player-entry">
            <div className="player-dot" />
            <span>{p.name}</span>
            {p.id === myPlayerId && <span className="you-badge">You</span>}
            {pvpMode && p.id === selectedDealerId && (
              <span className="dealer-badge">🃏 Dealer</span>
            )}
          </div>
        ))}
        {players.length === 0 && (
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem' }}>Waiting for players…</p>
        )}
      </div>

      {/* PvP Mode Toggle */}
      {players.length >= 2 && (
        <div className="pvp-mode-section">
          <label className="pvp-toggle-label">
            <input
              type="checkbox"
              checked={pvpMode}
              onChange={e => setPvpMode(e.target.checked)}
              className="pvp-checkbox"
            />
            <span>PvP Mode — one player is the Dealer</span>
          </label>

          {pvpMode && (
            <div className="dealer-select-row">
              <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>Select Dealer:</label>
              <select
                value={selectedDealerId}
                onChange={e => setSelectedDealerId(e.target.value)}
                className="dealer-select"
              >
                {players.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {players.length >= 2 ? (
        <button className="btn btn-primary" onClick={handleStartGame} disabled={starting}>
          {starting ? 'Starting…' : 'Start Game →'}
        </button>
      ) : (
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem' }}>
          Need at least 2 players to start
        </p>
      )}
    </div>
  );
}
