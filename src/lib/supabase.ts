import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Room = {
  id: string;
  code: string;
  status: 'waiting' | 'playing' | 'finished';
  starting_chips: number;
  created_at: string;
};

export type Player = {
  id: string;
  room_id: string;
  name: string;
  is_active: boolean;
  chips: number;
  created_at: string;
};

export type PlayerHand = {
  cards: import('./blackjack').Card[];
  status: 'playing' | 'stand' | 'bust' | 'blackjack' | 'waiting';
  bet: number;
  doubled: boolean;
  result?: 'win' | 'lose' | 'push';
};

export type PlayOrderEntry = {
  player_id: string;
  hand_index: number;
};

export type GameState = {
  id: string;
  room_id: string;
  deck: import('./blackjack').Card[];
  dealer_hand: import('./blackjack').Card[];
  // Array per player to support splits
  player_hands: Record<string, PlayerHand[]>;
  play_order: PlayOrderEntry[];
  current_player_index: number;
  phase: 'betting' | 'player_turns' | 'dealer_turn' | 'finished';
  player_bets: Record<string, number>;
  player_chips: Record<string, number>;
  pvp_dealer_id?: string | null;
  updated_at: string;
};
