# Event Manager — deploy and rollback

Production runs on the VPS at `80.241.220.129`. From 2026-09-04 the source of
truth is **this repository**, not the server.

> **Stop editing `/root/event` directly.** The flow is
> `branch → change → tests → PR → merge → deploy`. Editing production first is
> how the previous drift happened, and on an event day it leaves nobody able to
> answer "what changed?" or "how do I undo it?".

## What runs where

| Piece | On the VPS | Served at |
|---|---|---|
| FastAPI backend | `/root/event/backend`, `gaia-event-manager.service`, uvicorn on `127.0.0.1:8002` | `/event-api/*` |
| Event Manager SPA | built from `/root/event/frontend`, deployed to `/var/www/event` | `/event/` |
| Admin shell | `admin/` in this repo → `/var/www/gaia-admin` | `/admin/` |
| Gaia proxy | `/root/gaia-staging-proxy`, `gaia-staging-proxy.service` | `api.gaiahealers.app` |

Python 3.12.3, system interpreter (no virtualenv). Node/CRA for the frontend.

## Runtime state that is NOT in Git, and must not be

`backend/.env` (JWT signing key, identity service token, VAPID), `event.db` and
its backups, `_backups/`, `backend/uploads/` (attendee photos — personal data),
`vapid_private.pem`, logs and pids, `node_modules/`, `frontend/build/`,
`__pycache__/`.

Losing the VPS means restoring those from backup, not from Git. Keep taking
`event.db` snapshots.

## Deploy

```bash
# 1. On the VPS, note where you are coming from — this is your rollback point.
cd /root/gaia-healers-mobile-app && git rev-parse --short HEAD

# 2. Fetch the merged code.
git fetch origin && git checkout main && git pull

# 3. Backend: copy source, keep runtime files untouched.
rsync -a --delete \
  --exclude '.env' --exclude '*.db' --exclude '*.db.*' \
  --exclude 'uploads/' --exclude '__pycache__/' --exclude '*.log*' --exclude '*.pid' \
  event-manager/backend/ /root/event/backend/
systemctl restart gaia-event-manager && sleep 5 && systemctl is-active gaia-event-manager

# 4. Backend tests, against the running service.
cd /root/event/backend && for t in test_badge_card test_card_permanence \
  test_walkin_lifecycle test_walkin_reconcile test_door_lifecycle \
  test_qr_permanence test_ledger_integrity; do python3 $t.py | tail -1; done

# 5. Frontend: sync source, rebuild, publish.
rsync -a --delete --exclude 'node_modules/' --exclude 'build/' \
  event-manager/frontend/src/ /root/event/frontend/src/
cd /root/event/frontend && CI=false npm run build
rsync -a --delete build/ /var/www/event/

# 6. Admin shell (only when admin/ changed).
cp admin/gadmin.js admin/gadmin.css /var/www/gaia-admin/ && chown www-data:www-data /var/www/gaia-admin/*

# 7. Proxy (only when staging-proxy/ changed).
rsync -a --exclude '.env' --exclude 'node_modules/' --exclude 'data/' \
  staging-proxy/ /root/gaia-staging-proxy/
systemctl restart gaia-staging-proxy
```

## Rollback

The database is never rolled back by this procedure — only code.

```bash
cd /root/gaia-healers-mobile-app
git checkout <last-known-good-sha>          # e.g. the tag below
# then repeat deploy steps 3, 5 (and 6/7 if those changed)
```

If a migration has already added columns, rolling the code back is still safe:
every column added by this system is additive and nullable, and older code
ignores columns it does not know about. **Rolling back the database is a
separate, deliberate act** — restore from `/root/event/backend/event.db.pre-*`
or `_backups/`, and only with the owner's say-so.

Fastest possible door recovery, if the Admin shell is the problem: staff use
`https://api.gaiahealers.app/event/` directly. It is the same application.

## Production baseline

Tagged `event-manager-baseline-2026-09-04`. At that tag the checked-in source
was byte-identical to the running VPS source (`diff -r` across all 72 files:
zero differences), and the deployed SPA bundle was `main.4cb931c6.js`.

## Architecture

One Event Manager. `/admin/ → Events` embeds `/event/` in an iframe. Never build
event features in the Admin shell — see
[`design-reference/EVENT-ADMIN-ARCHITECTURE.md`](../design-reference/EVENT-ADMIN-ARCHITECTURE.md),
enforced by `tests/event-admin-boundary.test.cjs`.
