-- Add PvP dealer column to game_state
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS pvp_dealer_id text DEFAULT NULL;
