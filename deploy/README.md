# Disglobe Cloud Backend — deploy folder

This folder contains **exactly the files** a cloud host needs. Nothing else —
no Electron, no node_modules, no local data.

## Contents

| File | Purpose |
|---|---|
| `server.js` | The whole backend (copy from the repo root — keep in sync!) |
| `disglobe.html` | The client, served by the server itself |
| `package.json` | Lean production manifest: `npm start` runs the server; `pg` + `ws` are real dependencies |
| `render.yaml` | Render blueprint: web service + free PostgreSQL |

## Deploy to Render (blueprint, easiest)

1. Push this folder's 4 files to a GitHub repo.
2. render.com → **New + → Blueprint** → pick the repo → **Apply**.
   That creates the web service **and** the PostgreSQL database, and wires
   `DATABASE_URL` automatically.
3. Your URL: `https://disglobe-xxxx.onrender.com` — share it. Done.

## Deploy to Railway

1. railway.app → **New Project → Deploy from GitHub repo**.
2. Add a **PostgreSQL** plugin (Railway injects `DATABASE_URL` automatically).
3. Settings → the start command is `npm start` (Railway assigns `PORT` — the
   server already honors it). Generate a public domain. Done.

## How configuration works

- **Port**: hosts set `PORT`; `server.js` uses it automatically (local default 3849).
- **Database**: set `DATABASE_URL` to a Postgres connection string and the server
  creates its tables (`kv`, `messages`) on first boot and stores everything there.
  Without it, the server falls back to the JSON file store (fine for dev, not
  recommended in the cloud since free hosts have ephemeral disks).
- **Realtime**: WebSocket at `wss://<your-host>/ws` — both Render and Railway
  support WebSockets with no extra config.

## Local test before deploying

```bash
npm install
npm start          # uses the JSON store on port 3849
DATABASE_URL=postgres://... npm start   # uses PostgreSQL
```
