# Blackjack

A real-time multiplayer Blackjack game playable in the browser. Players create or join private rooms using a 4-letter code, buy chips with a simulated Euro amount, and play against each other live.

## Features

- **Multiplayer rooms** — Create a private room and share the 4-letter code with friends
- **Chip system** — Convert a simulated Euro amount into chips (€1 = 100 chips)
- **Real-time gameplay** — Live game state synced across all players via Supabase
- **PvP mode** — Player vs. player betting on top of the base game
- **Boxing mode** — Additional game variant
- **Lobby system** — Wait for all players before starting

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Backend / Realtime | Supabase (PostgreSQL + Realtime) |
| Deployment | Vercel |
| Routing | React Router |

## Run locally

```bash
npm install
cp .env.example .env  # add your Supabase project URL and anon key
npm run dev
```

## Database

Schema migrations are in the root as `supabase_schema*.sql` files, covering rooms, players, PvP, boxing, and chip management.
