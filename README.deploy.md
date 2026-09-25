# Disglobe — cloud backend

This repository contains the Disglobe Node.js backend for cloud deployment
(Render/Railway). It serves the chat client (`disglobe.html`), runs the API +
WebSocket realtime layer, and uses PostgreSQL when `DATABASE_URL` is set.

- `server.js` — the whole backend
- `disglobe.html` — the client the server serves
- `package.json` — production manifest (`npm start`, deps: `pg`, `ws`)
- `render.yaml` — Render blueprint: web service + free PostgreSQL

Deploy: Render → New + → Blueprint → pick this repo → Apply.
Health check: `/api/ping`
