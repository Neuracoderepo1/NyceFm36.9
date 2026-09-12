# NYCE FM Phase 5C — Broadcast Control Hardening

Implemented against the live Supabase production project.

## Changes
- Heartbeats now use the authoritative `heartbeat_now_playing` database primitive with a fenced `control_revision`.
- Pause/resume no longer double-increment `control_revision`; the database is the single authority and the worker only signals FFmpeg.
- Queue claiming now excludes media assets that are not `ready`.
- Invalid broadcast state/control-revision conflicts map to stable API error contracts (409/400).
- `/api/broadcast/control` accepts optimistic-concurrency `expectedControlRevision`.
- Override route no longer forwards an undeclared control-revision field.
- Added local migration mirror `011_broadcast_fencing_hardening.sql`.

## Verification
- Supabase migration `011_broadcast_fencing_hardening` applied successfully.
- Live migration chain contains 001 through 011.
- Supabase Realtime publication contains `now_playing`, `broadcast_queue`, `listener_presence`, `audience_events`, and `ai_actions`.
- TypeScript typecheck was attempted but the supplied environment has missing/incomplete `node_modules`/type definitions, so a clean compile cannot yet be claimed.
