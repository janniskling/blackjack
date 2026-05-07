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

  const myPlayerId = localStorage.getItem('playerId');

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
            // If current player is no longer active (cashed out), redirect home
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
      // Initialize chips for all players from room.starting_chips
      const playerChips: Record<string, number> = {};
      for (const p of players) {
        playerChips[p.id] = room.starting_chips;
        // Sync to players table too
        await supabase.from('players').update({ chips: room.starting_chips }).eq('id', p.id);
      }

      // Start in betting phase — no dealing yet
      await supabase.from('game_state').upsert({
        room_id: room.id,
        deck: [],
        dealer_hand: [],
        player_hands: Object.fromEntries(players.map(p => [p.id, []])),
        play_order: [],
        current_player_index: 0,
        phase: 'betting',
        player_bets: {},
        player_chips: playerChips,
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
          </div>
        ))}
        {players.length === 0 && (
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem' }}>Waiting for players…</p>
        )}
      </div>

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
