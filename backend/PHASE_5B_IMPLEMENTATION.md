# NYCE FM — Phase 5B: Production Integration & Control Plane

Implemented against the live Supabase project and aligned with the API/worker architecture.

## Live database

Migration `010_broadcast_control_plane` adds authoritative primitives:

- `claim_next_queue_item(station_id)` — atomic `FOR UPDATE SKIP LOCKED` queue claim.
- `advance_now_playing(...)` — authoritative transition with monotonic revision/control revision.
- `heartbeat_now_playing(...)` — fenced worker heartbeat.
- `control_now_playing(...)` — optimistic-concurrency protected pause/resume/stop/skip/emergency-stop.
- `upsert_listener_presence(...)` — idempotent presence heartbeat.
- Realtime publication registration for `now_playing`, `broadcast_queue`, `listener_presence`, `audience_events`, and `ai_actions`.

## API/worker changes

- Broadcast controls accept `expectedControlRevision` to prevent stale Studio commands.
- Broadcast control state is committed in PostgreSQL before the worker is signalled.
- Worker queue claiming and Now Playing transitions use the authoritative database primitives.
- Supabase-compatible backend storage environment variables are documented; service credentials remain server-only.

## Production contract

Browser -> NYCE FM API -> PostgreSQL/Supabase + Redis -> Broadcast Worker -> FFmpeg -> HLS/Icecast.

Realtime is fan-out, not an authorization boundary. The existing API/RBAC layer remains authoritative.
