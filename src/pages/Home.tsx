import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

function generateCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

function ChipsInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="chips-input-row">
      <label>Your starting chips</label>
      <div className="euro-input">
        <span className="euro-symbol">€</span>
        <input
          type="number"
          min="1"
          max="10000"
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ paddingLeft: '1.5rem' }}
        />
      </div>
      <span className="chips-preview">= {(parseInt(value) || 0) * 100} chips</span>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();

  const [createName, setCreateName] = useState(localStorage.getItem('playerName') || '');
  const [createEuros, setCreateEuros] = useState('10');
  const [joinName, setJoinName] = useState(localStorage.getItem('playerName') || '');
  const [joinEuros, setJoinEuros] = useState('10');
  const [joinCode, setJoinCode] = useState('');
  const [createError, setCreateError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  async function handleCreate() {
    if (!createName.trim()) { setCreateError('Enter your name'); return; }
    const euros = parseInt(createEuros, 10);
    if (isNaN(euros) || euros < 1) { setCreateError('Enter a valid amount'); return; }
    setCreating(true);
    setCreateError('');

    try {
      const code = generateCode();
      const chips = euros * 100;

      const { data: room, error: roomErr } = await supabase
        .from('rooms')
        .insert({ code, status: 'waiting', starting_chips: 0 })
        .select()
        .single();

      if (roomErr) throw roomErr;

      const { data: player, error: playerErr } = await supabase
        .from('players')
        .insert({ room_id: room.id, name: createName.trim(), is_active: true, chips })
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
    const euros = parseInt(joinEuros, 10);
    if (isNaN(euros) || euros < 1) { setJoinError('Enter a valid amount'); return; }
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
      if (room.status === 'finished') { setJoinError('This room is closed'); return; }

      const chips = euros * 100;

      const { data: player, error: playerErr } = await supabase
        .from('players')
        .insert({ room_id: room.id, name: joinName.trim(), is_active: true, chips })
        .select()
        .single();

      if (playerErr) throw playerErr;

      localStorage.setItem('playerName', joinName.trim());
      localStorage.setItem('playerId', player.id);
      localStorage.setItem('roomCode', code);

      navigate(room.status === 'playing' ? `/game/${code}` : `/room/${code}`);
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
          <ChipsInput value={createEuros} onChange={setCreateEuros} />
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
          <ChipsInput value={joinEuros} onChange={setJoinEuros} />
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
