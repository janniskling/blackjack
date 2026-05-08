-- Boxing feature: track boxing bets during betting phase
-- boxing_bets structure: { [target_player_id]: { [boxer_player_id]: amount } }
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS boxing_bets jsonb DEFAULT '{}'::jsonb;
