# NuMind MAPS — PostgreSQL Migration: Deploy Runbook

## What was verified (live tests against PostgreSQL 16)
- `initSchema()` creates all 27 tables incl. CITEXT extension ✅
- Full student flow over HTTP: register → duplicate-email identity (case-insensitive)
  → save-section → save-report (transaction + derivations) ✅
- Counsellor: unlock gating, identity fallback (no SMTP), PIN set/verify,
  OTP single-use, session tokens, chat history, conversation titles, rate limits ✅
- Dashboard over HTTP: login, /me, token verify, scoped students, filters+search,
  stats, gender, trend, aggregate scores, wellbeing alerts, career distribution,
  queries list + PATCH, notes/tags, reminder log (school-scoped), audit,
  schools registry (case-insensitive dedupe), password reset, CSV import ✅
- Migration script on a real legacy SQLite file: 0/1→boolean, TEXT ts→TIMESTAMPTZ,
  permissions TEXT→JSONB, identity ids preserved (gap at 7 kept), sequences
  resynced (next id = 8), idempotent re-run inserts 0 ✅
- Fallback prose guard: real AI report overwrites fallback; later fallback
  re-save does NOT clobber real prose ✅
- New code reads migrated legacy rows, incl. the legacy-backfill derivation path ✅

## Files to deploy (all in outputs/)
| File | Action |
|---|---|
| `pg-core.js` | NEW — place at project root |
| `db.js` | REPLACE |
| `counsellor-db.js` | REPLACE |
| `dashboard-db.js` | REPLACE |
| `dashboard-api.js` | REPLACE |
| `server.js` | REPLACE |
| `package.json` | REPLACE (adds `pg`, bumps better-sqlite3 to ^11 for the migration script) |
| `migrate-sqlite-to-pg.js` | NEW — one-time tool, root |

Nothing in the frontend (`index.html`, dashboards, `main.js`, `router.js`,
`counsellor-ui.js`, charts, engine) changes — API contracts are preserved,
verified over HTTP.

## Environment (.env) — new/changed keys
```
# EITHER a single URL…
DATABASE_URL=postgres://numind:STRONG_PASSWORD@<host>:5432/numind
# …or discrete vars:
# PGHOST=127.0.0.1  PGPORT=5432  PGUSER=numind  PGPASSWORD=...  PGDATABASE=numind

PGSSL=disable          # 'disable' for localhost EC2; omit/require for managed PG with TLS
PG_POOL_MAX=10         # PER PM2 WORKER. workers × PG_POOL_MAX must stay
                       # comfortably under Postgres max_connections.
                       # ecosystem uses instances:'max' → on 4 vCPU = 4×10 = 40 conns.

# Unchanged: APP_TOKEN (≥16 chars!), OPENAI_API_KEY, OPENAI_MODEL,
# COUNSELLOR_MODEL, ALLOWED_ORIGIN, SMTP_USER/PASS, PORT, LOG_LEVEL
# Removed (dead): WQ_BATCH_SIZE, WQ_MAX
# SQLITE_PATH: keep temporarily — only the migration script reads it now.
```

## Postgres provisioning (EC2, once)
```bash
sudo apt install postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE USER numind WITH PASSWORD '<strong>';"
sudo -u postgres psql -c "CREATE DATABASE numind OWNER numind;"
# CITEXT needs one-time admin grant if the app role can't CREATE EXTENSION:
sudo -u postgres psql -d numind -c "CREATE EXTENSION IF NOT EXISTS citext;"
# max_connections check (must exceed workers × PG_POOL_MAX + ~10):
sudo -u postgres psql -c "SHOW max_connections;"
```

## Cutover sequence
1. `npm install` (pulls `pg` + better-sqlite3 v11)
2. Stop the app (or put in maintenance) — freeze SQLite writes
3. `npm run db:migrate:dry`   → verify per-table row counts look right
4. `npm run db:migrate`       → real load (idempotent; safe to re-run)
5. Start app: `pm2 start ecosystem.config.js --env production`
   - Boot order is: schema check → module init → seed check → listen.
   - First-boot credentials banner only fires if `dashboard_users` is EMPTY —
     after migration it won't (your existing staff accounts came across,
     passwords unchanged; scrypt hashes migrate as-is).
6. Smoke: `curl localhost:3000/health` → `{"ok":true,...}`
7. After a stable week: remove `better-sqlite3` from package.json,
   delete `migrate-sqlite-to-pg.js`, archive the old `numind.db`.

## Rollback
Old SQLite file is untouched (migration opens it read-only). To roll back:
redeploy the previous server/db files and restart. Anything written to PG
after cutover would need re-migration in reverse (manual) — so keep the
maintenance window until smoke tests pass.

## Notable behavior changes (intentional)
- Write queue removed → no more 503 Retry-After "server busy" on save
  endpoints under load; Postgres pool handles concurrency.
- `wqLength` in /health is now always 0 (kept for monitoring compat).
- Case-insensitive email/school/tag identity is enforced by CITEXT at the
  DB level (previously LOWER() indexes).
- BIGINT ids and NUMERIC aggregates are parsed to JS numbers in pg-core so
  all dashboard strict compares / .toFixed() calls behave exactly as before.
