# NYCE FM — Phase 5C Integration

The backend now exposes a production dashboard contract:

- `GET /api/broadcast/state` — authenticated snapshot of now-playing, queue and control state.
- `GET /api/broadcast/control-stream` — authenticated SSE stream; emits only when the station state changes.
- `POST /api/broadcast/control` — optimistic-concurrency control using `expectedControlRevision`.
- `GET /api/auth/me` — session identity + server-resolved permissions.

## Browser integration

Use `public/nycefm-api.js` from the dashboard. It uses the existing httpOnly session cookie and never stores credentials/tokens in localStorage.

The existing v3.2 dashboard should remove its direct browser-to-Anthropic call and route privileged AI/broadcast operations through this API. The dashboard's visual design can remain intact; its simulated track/queue/listener state should be replaced incrementally with API state.

## Control fencing

Every control operation should send the most recently observed `nowPlaying.control_revision`. If the server returns `409 CONTROL_REVISION_CONFLICT`, refresh `/api/broadcast/state` and render the updated station state before allowing another destructive control.

## Production deployment

Run API and broadcast worker as the same container initially. For higher availability, split API and worker into separate processes/containers while keeping exactly one active broadcast worker per station. Use Redis for sessions and coordination, PostgreSQL/Supabase for authoritative state, and a private object/media store for source audio.

Never expose `SUPABASE_SERVICE_ROLE_KEY`, database passwords, session secrets, or AI provider credentials to the browser.
