# NYCE FM — Production Readiness Assessment

**Date:** 2026-09-12
**Source inspected:** `NyceFM_v3_2_Dashboard.html` (1,774 lines, single static file)

## Current Architecture

There is no backend. The file is a self-contained HTML/CSS/JS document with:
- No server, no database, no build system, no package manager, no tests, no CI.
- All "state" lives in in-memory JS objects and `localStorage`.
- The only network call is a direct browser → `https://api.anthropic.com/v1/messages` fetch.

This is a **design prototype**, not a deployable application. It should become the
visual/interaction reference for the future `/studio` and `/listen` frontends — the
code underneath is not reusable.

## Confirmed Simulated / Unsafe Functionality (exact line references)

| Concern | Location | Finding |
|---|---|---|
| AI calls | line 471 | Browser calls the Anthropic API directly. Any API key present in this file is public. **Critical.** |
| Auth | lines 561–592 | Session object stored in `localStorage`; `Auth._login('admin')` grants admin role with no server check. **Critical.** |
| Authorization | line 1740 | `if(auth.isAdmin\|\|auth.isOperator)` gates admin UI client-side only — trivially bypassed via devtools. **Critical.** |
| Listener count | line 1486 | `Math.random()` walk, not real presence data. |
| Chat | lines 1494–1495 | Messages, usernames, and countries are randomly generated, not a real chat system. |
| Library upload | lines 1536, 1629 | Upload "processing" is a `setTimeout`; no storage, no transcoding, no validation. |
| Payments/tips | ~line 1105 | Tip "success" is a DOM update after a `setTimeout`; no payment processor involved. |
| Analytics | KPI panel | All dashboard metrics (DAU, completion %, conversion %, AI interaction %) are hard-coded or randomized. |

## Security Vulnerabilities (present in current file)

1. Client-authoritative authentication and authorization (both critical, OWASP A01/A07).
2. Any AI provider key embedded in client JS would be exfiltrable (OWASP A02, secrets exposure).
3. No CSRF protection, no rate limiting, no input validation anywhere.
4. No audit trail of any privileged action.

## What Phase 1 of this build actually delivers (verified, not assumed)

A real, running backend foundation, tested against a live PostgreSQL 16 + Redis instance in this session:

- PostgreSQL schema (migration `001_core_auth_rbac.sql`): `users`, `roles`,
  `permissions`, `role_permissions`, `user_roles`, `stations`, `station_settings`,
  `audit_events` (immutable, insert-only), `login_attempts`.
- Real password hashing (bcrypt, 12 rounds) — no plaintext, no client-side auth.
- Server-side sessions (Redis-backed via `connect-redis`), `httpOnly`, `sameSite=lax`,
  `secure` in production, session regenerated on login (session-fixation protection).
- Account lockout after 5 failed attempts (15-minute lockout), all attempts logged.
- RBAC middleware (`requirePermission`) that re-checks permissions from the database
  on every request — not a client flag, not a JWT claim trusted blindly.
- Immutable audit log: registration, login, account lockout, role grants all recorded
  with actor, resource, before/after state, and request correlation ID.
- Consistent JSON error shape (`{error:{code,message,request_id}}`), no stack traces
  leaked outside development.
- Helmet security headers + CSP (production), CORS allowlist (not `*`), per-route
  rate limiting on login/register.
- Health endpoints (`/health`, `/health/live`, `/health/ready`) that check real DB
  and Redis connectivity — verified returning `"database":"healthy","redis":"healthy"`.

### What was actually tested (this session, live HTTP against the running server)

| Test | Result |
|---|---|
| Register → session cookie issued | 201, cookie set `httpOnly` |
| `/api/auth/me` with valid session | 200, roles + permissions returned |
| Listener hits admin-only route | **403 FORBIDDEN** (correct denial) |
| 5x wrong password | Account locked, `423 ACCOUNT_LOCKED` on 6th attempt incl. correct password |
| Logout | Session destroyed server-side; subsequent `/me` → `401` |
| Grant `ADMIN` role, retry admin route needing `users.manage` | Still `403` — correctly reserved for `SUPER_ADMIN` only |
| Grant `SUPER_ADMIN` role, retry | `200`, real user list returned from Postgres |
| `audit_events` table after the above | Contains real rows: `USER_REGISTERED`, `ACCOUNT_LOCKED` |

This is the only part of the 100-section directive that has been implemented **and verified**
in this session. Everything below is scoped but not built.

## Explicitly Not Built Yet (do not assume otherwise)

- Broadcast engine, real audio streaming (Icecast/HLS/CDN), queue/scheduler.
- AI provider router, context engine, safety pipeline, prompt registry, TTS.
- Chat, requests, polls, reactions (realtime via WebSocket/SSE).
- Stripe integration, subscriptions, tips, webhook handling.
- Analytics event pipeline and rollups.
- Media upload/processing pipeline, object storage.
- CI/CD, load testing, deployment configuration, backups.
- The `/listen` and `/studio` frontends that consume this API (current HTML file is
  visual reference only, not wired to this backend yet).

## Recommended Sequence From Here

1. **Phase 2 — Broadcast core**: library/media storage, playlists, queue, an actual
   streaming target (Icecast is simplest to self-host; a hosted HLS/CDN service is
   simpler operationally). This phase needs a decision on where audio actually lives.
2. **Phase 3 — AI DJ**: provider router (Claude/OpenAI/Gemini with fallback), schema-
   validated structured actions, safety pipeline, prompt registry. This needs real
   API keys, which must never leave the server.
3. **Phase 4 — Audience**: realtime chat/requests/polls over WebSocket, moderation.
4. **Phase 5 — Monetization**: Stripe Checkout + webhooks (test mode first).
5. **Phase 6–8**: analytics pipeline, Studio operator console, hardening/deployment.

## Genuine External Blockers (not things I can implement myself)

- A destination to actually deploy to (Render/Fly/VPS) with persistent Postgres/Redis.
- Real Stripe account + API keys for payments (test mode keys are fine to start).
- A real audio streaming host (self-hosted Icecast box, or a managed HLS/CDN provider).
- AI provider API keys for Claude/OpenAI/Gemini, stored as server secrets.
- A domain + DNS + TLS certificate for production.

None of these can be fabricated; they require your decisions and credentials.
