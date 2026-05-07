import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

function generateCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

export default function Home() {
  const navigate = useNavigate();

  const [createName, setCreateName] = useState(localStorage.getItem('playerName') || '');
  const [startingEuros, setStartingEuros] = useState('10');
  const [joinName, setJoinName] = useState(localStorage.getItem('playerName') || '');
  const [joinCode, setJoinCode] = useState('');
  const [createError, setCreateError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  async function handleCreate() {
    if (!createName.trim()) { setCreateError('Enter your name'); return; }
    const euros = parseInt(startingEuros, 10);
    if (isNaN(euros) || euros < 1) { setCreateError('Enter a valid amount'); return; }
    setCreating(true);
    setCreateError('');

    try {
      const code = generateCode();
      const startingChips = euros * 100;

      const { data: room, error: roomErr } = await supabase
        .from('rooms')
        .insert({ code, status: 'waiting', starting_chips: startingChips })
        .select()
        .single();

      if (roomErr) throw roomErr;

      const { data: player, error: playerErr } = await supabase
        .from('players')
        .insert({ room_id: room.id, name: createName.trim(), is_active: true, chips: startingChips })
        .select()
        .single();

      if (playerErr) throw playerErr;

      localStorage.setItem('playerName', createName.trim());
      localStorage.setItem('playerId', player.id);
      localStorage.setItem('roomCode', code);

      navigate(`/room/${code}`);
    } catch (e: unknown) {
      setCreateError((e as Error).message || 'Failed to create room');
    } finally {
      setCreating(false);
    }
  }

  async function handleJoin() {
    if (!joinName.trim()) { setJoinError('Enter your name'); return; }
    if (!joinCode.trim()) { setJoinError('Enter a room code'); return; }
    setJoining(true);
    setJoinError('');

    try {
      const code = joinCode.trim().toUpperCase();
      const { data: room, error: roomErr } = await supabase
        .from('rooms')
        .select()
        .eq('code', code)
        .single();

      if (roomErr || !room) { setJoinError('Room not found'); return; }
      if (room.status !== 'waiting') { setJoinError('Game already in progress'); return; }

      const { data: player, error: playerErr } = await supabase
        .from('players')
        .insert({ room_id: room.id, name: joinName.trim(), is_active: true, chips: room.starting_chips })
        .select()
        .single();

      if (playerErr) throw playerErr;

      localStorage.setItem('playerName', joinName.trim());
      localStorage.setItem('playerId', player.id);
      localStorage.setItem('roomCode', code);

      navigate(`/room/${code}`);
    } catch (e: unknown) {
      setJoinError((e as Error).message || 'Failed to join room');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="home">
      <h1>♠ Blackjack ♥</h1>
      <div className="home-sections">
        <div className="home-card">
          <h2>Create Room</h2>
          <input
            placeholder="Your name"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            maxLength={20}
          />
          <div className="chips-input-row">
            <label>Starting money</label>
            <div className="euro-input">
              <span className="euro-symbol">€</span>
              <input
                type="number"
                min="1"
                max="10000"
                value={startingEuros}
                onChange={e => setStartingEuros(e.target.value)}
                style={{ paddingLeft: '1.5rem' }}
              />
            </div>
            <span className="chips-preview">= {(parseInt(startingEuros) || 0) * 100} chips</span>
          </div>
          {createError && <span className="error-msg">{createError}</span>}
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating…' : 'Create Room'}
          </button>
        </div>

        <div className="home-card">
          <h2>Join Room</h2>
          <input
            placeholder="Your name"
            value={joinName}
            onChange={e => setJoinName(e.target.value)}
            maxLength={20}
          />
          <input
            placeholder="Room code (e.g. ABCD)"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
            maxLength={4}
          />
          {joinError && <span className="error-msg">{joinError}</span>}
          <button className="btn btn-primary" onClick={handleJoin} disabled={joining}>
            {joining ? 'Joining…' : 'Join Room'}
          </button>
        </div>
      </div>
    </div>
  );
}
