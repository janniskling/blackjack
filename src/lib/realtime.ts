import { supabase } from './supabase';
import type { GameState, Player } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

export function subscribeToGameState(
  roomId: string,
  callback: (state: GameState) => void
): RealtimeChannel {
  return supabase
    .channel(`game_state:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'game_state',
        filter: `room_id=eq.${roomId}`,
      },
      payload => {
        if (payload.new) callback(payload.new as GameState);
      }
    )
    .subscribe();
}

export function subscribeToPlayers(
  roomId: string,
  callback: (players: Player[]) => void
): RealtimeChannel {
  return supabase
    .channel(`players:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'players',
        filter: `room_id=eq.${roomId}`,
      },
      async () => {
        const { data } = await supabase
          .from('players')
          .select('*')
          .eq('room_id', roomId)
          .eq('is_active', true)
          .order('created_at');
        if (data) callback(data as Player[]);
      }
    )
    .subscribe();
}

export function subscribeToRoom(
  roomId: string,
  callback: (status: string) => void
): RealtimeChannel {
  return supabase
    .channel(`rooms:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'rooms',
        filter: `id=eq.${roomId}`,
      },
      payload => {
        if (payload.new) callback((payload.new as { status: string }).status);
      }
    )
    .subscribe();
}

export async function broadcastPlayerAction(
  roomId: string,
  gameState: Partial<GameState>
): Promise<void> {
  const { error } = await supabase
    .from('game_state')
    .update({
      ...gameState,
      updated_at: new Date().toISOString(),
    })
    .eq('room_id', roomId);

  if (error) throw error;
}
