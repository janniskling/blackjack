-- Schema update: chips, betting, split support

-- Add starting_chips to rooms (euros * 100 = chips)
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS starting_chips INT NOT NULL DEFAULT 1000;

-- Add chips to players
ALTER TABLE players ADD COLUMN IF NOT EXISTS chips INT NOT NULL DEFAULT 1000;

-- Add new columns to game_state
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS play_order JSONB NOT NULL DEFAULT '[]';
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS player_bets JSONB NOT NULL DEFAULT '{}';
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS player_chips JSONB NOT NULL DEFAULT '{}';

-- Update phase check constraint to include 'betting'
ALTER TABLE game_state DROP CONSTRAINT IF EXISTS game_state_phase_check;
ALTER TABLE game_state ADD CONSTRAINT game_state_phase_check
  CHECK (phase IN ('betting', 'dealing', 'player_turns', 'dealer_turn', 'finished'));
