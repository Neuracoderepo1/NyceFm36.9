# NYCE FM — Backend (Phase 1: Foundation)

Real auth, RBAC, and audit logging replacing the client-side simulation in
`NyceFM_v3_2_Dashboard.html`. See `docs/PRODUCTION_READINESS.md` for the full
audit of what was found, what's built, and what's genuinely still missing.

## Stack

Node 20+, TypeScript, Express, PostgreSQL 16, Redis (sessions + rate limiting).

## Local setup

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, REDIS_URL, SESSION_SECRET
# SESSION_SECRET: openssl rand -base64 48

npm run migrate               # applies src/db/migrations/*.sql in order
npm run dev                   # http://localhost:3000
```

## Verifying it works

```bash
curl localhost:3000/health/ready
# {"status":"ready","checks":{"database":"healthy","redis":"healthy"}}

curl -c cookies.txt -X POST localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-strong-password","displayName":"You"}'

curl -b cookies.txt localhost:3000/api/auth/me
```

## What's here

```
src/
  app.ts               Express app: helmet, CORS, sessions, routing, error handler
  server.ts            Entrypoint
  db/
    pool.ts            pg Pool
    migrate.ts          Forward-only migration runner (tracks applied files)
    migrations/         Raw SQL, numbered
  services/
    auth.ts            Registration, login, lockout, password hashing (bcrypt)
    audit.ts           Immutable audit event writer
  middleware/
    rbac.ts            requireAuth / requirePermission — server-side, DB-checked
    requestId.ts        Correlation ID per request
  routes/
    auth.ts            /api/auth/register, /login, /logout, /me
    admin.ts           /api/admin/* — permission-gated example endpoints
    health.ts          /health, /health/live, /health/ready
```

## Roles & permissions (seeded by migration 001)

`LISTENER, DJ, PRODUCER, MODERATOR, EDITOR, ADMIN, SUPER_ADMIN` with 20 granular
permission codes (`broadcast.control`, `library.upload`, `payments.manage`, etc.).
`users.manage` is intentionally restricted to `SUPER_ADMIN` only — `ADMIN` cannot
grant roles to other users. Adjust in `001_core_auth_rbac.sql` if that's not the
model you want.

## Not in this phase

No broadcast/streaming, no AI provider integration, no Stripe, no chat/requests,
no analytics pipeline, no frontend. See `docs/PRODUCTION_READINESS.md` §"Recommended
Sequence" for the order I'd build those in, and §"Genuine External Blockers" for
what needs your credentials/decisions before I can go further.
