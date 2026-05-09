-- Track each player's initial buy-in so we can calculate profit/loss on cashout
ALTER TABLE players ADD COLUMN IF NOT EXISTS starting_chips integer NOT NULL DEFAULT 0;
