# NYCE FM — Phase 2 Implementation

Implemented against the Phase 1 backend snapshot.

## Delivered

- `002_broadcast_core.sql`
  - media asset catalog
  - playlists and ordered playlist items
  - broadcast queue
  - broadcast sessions
  - now-playing state with revision counter
  - default NYCE FM station bootstrap
- `GET/POST /api/library`
- `GET/POST /api/playlists`
- `GET/POST /api/playlists/:playlistId/items`
- `GET /api/broadcast/now-playing`
- `GET /api/broadcast/queue`
- `POST /api/broadcast/start`
- `POST /api/broadcast/stop`
- `POST /api/broadcast/queue`
- audit events for media, playlist, queue, and broadcast mutations
- server-side permission enforcement using the existing RBAC layer
- cross-station media validation
- concurrent-safe queue position allocation using a PostgreSQL transaction advisory lock
- Zod validation errors normalized to HTTP 400

## Permission model

- Library read: `library.read`
- Library mutation: `library.upload`
- Playlist read: `playlist.read`
- Playlist mutation: `playlist.modify`
- Queue mutation: `queue.modify`
- Broadcast control: `broadcast.control`

## Intentionally not claimed as complete

This phase does **not** yet provide a real audio transport. The database/API now models the broadcast control plane, but Icecast/HLS/FFmpeg/object-storage credentials and deployment infrastructure remain external integration steps.

## Apply

```bash
npm install
npm run migrate
npm run build
npm test
```

Then verify the API with an authenticated user that has the required permissions.
