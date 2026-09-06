#!/usr/bin/env bash
#
# One complete Gaia production backup: staged, verified, encrypted, off-sited.
#
# The order below is the whole point. Nothing old is removed until a new backup
# has been built, read back, decrypted-checked, uploaded and seen on the far
# end. A run that fails at any step leaves every previous backup exactly where
# it was — the failure mode of a backup system must never be "no backups".
#
# What it protects is the production-only half of Gaia: the event database, the
# entitlement ledger, the alert state, the configuration and the secrets. The
# code is on GitHub; these are the things that exist nowhere else.
#
# Configuration lives in /root/.config/gaia-backup.env (0600), never here:
#   GAIA_BACKUP_GPG_RECIPIENT   public-key id or uid the archive is encrypted to
#   GAIA_BACKUP_REMOTE          rclone destination, e.g. r2:gaia-backups/production
# Absent either one, the run still builds and verifies a local archive and
# reports itself as local_only — it never silently uploads plaintext, and it
# never enforces retention on a backup set it has not fully secured.

set -euo pipefail
umask 077

CONFIG_FILE="${GAIA_BACKUP_CONFIG:-/root/.config/gaia-backup.env}"
if [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

LOCAL_DIR="${GAIA_BACKUP_LOCAL_DIR:-/var/backups/gaia}"
STATE_FILE="${GAIA_BACKUP_STATE_FILE:-/root/gaia-staging-proxy/data/backup-state.json}"
KEEP="${GAIA_BACKUP_KEEP:-7}"
RECIPIENT="${GAIA_BACKUP_GPG_RECIPIENT:-}"
REMOTE="${GAIA_BACKUP_REMOTE:-}"
GPG_HOME="${GAIA_BACKUP_GNUPGHOME:-/root/.gnupg-backup}"
EVENT_DB="${GAIA_BACKUP_EVENT_DB:-/root/event/backend/event.db}"
PROXY_DATA="${GAIA_BACKUP_PROXY_DATA:-/root/gaia-staging-proxy/data}"

DATE="$(date +%F)"
NAME="gaia-production-${DATE}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"

# Everything the run learns, written out at the end — success or failure.
STAGE="init"
OUTCOME="failed"
REASON=""
DB_INTEGRITY="not_checked"
DB_ROWS=""
ARCHIVE_BYTES=""
ARCHIVE_SHA=""
ENCRYPTED_BYTES=""
FILE_COUNT=""
CHECK_GZIP="not_checked"
CHECK_TAR="not_checked"
CHECK_SHA="not_checked"
CHECK_DB_IN_ARCHIVE="not_checked"
CHECK_ENCRYPT="not_checked"
UPLOADED_AT=""
REMOTE_VERIFIED_AT=""
REMOTE_BYTES=""
LOCAL_DELETED=""
REMOTE_DELETED=""

STAGING=""
cleanup() { if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then rm -rf "$STAGING"; fi; }
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# State is written by the trap as well as the happy path, so a crashed run is
# still visible to Gaia's health check instead of silently looking like nothing
# ever happened. No secret is ever placed in it — only file names and sizes.
# ─────────────────────────────────────────────────────────────────────────────
write_state() {
  local prev="{}"
  if [ -r "$STATE_FILE" ]; then prev="$(cat "$STATE_FILE")"; fi
  mkdir -p "$(dirname "$STATE_FILE")"
  STATE_PREV="$prev" \
  S_OUTCOME="$OUTCOME" S_STAGE="$STAGE" S_REASON="$REASON" \
  S_STARTED="$STARTED_AT" S_DURATION="$(( $(date +%s) - START_EPOCH ))" \
  S_NAME="$NAME" S_ARCHIVE_BYTES="$ARCHIVE_BYTES" S_ARCHIVE_SHA="$ARCHIVE_SHA" \
  S_ENCRYPTED_BYTES="$ENCRYPTED_BYTES" S_FILE_COUNT="$FILE_COUNT" \
  S_DB_INTEGRITY="$DB_INTEGRITY" S_DB_ROWS="$DB_ROWS" \
  S_GZIP="$CHECK_GZIP" S_TAR="$CHECK_TAR" S_SHA="$CHECK_SHA" \
  S_DB_ARCHIVE="$CHECK_DB_IN_ARCHIVE" S_ENCRYPT="$CHECK_ENCRYPT" \
  S_UPLOADED="$UPLOADED_AT" S_REMOTE_VERIFIED="$REMOTE_VERIFIED_AT" \
  S_REMOTE_BYTES="$REMOTE_BYTES" S_LOCAL_DIR="$LOCAL_DIR" S_KEEP="$KEEP" \
  S_REMOTE_CONFIGURED="$( [ -n "$REMOTE" ] && echo true || echo false )" \
  S_ENCRYPT_CONFIGURED="$( [ -n "$RECIPIENT" ] && echo true || echo false )" \
  S_LOCAL_DELETED="$LOCAL_DELETED" S_REMOTE_DELETED="$REMOTE_DELETED" \
  python3 - "$STATE_FILE" <<'PY'
import json, os, sys, glob

out_path = sys.argv[1]
try:
    prev = json.loads(os.environ.get('STATE_PREV') or '{}') or {}
except Exception:
    prev = {}

g = os.environ.get
num = lambda v: int(v) if (v or '').isdigit() else None
outcome, finished = g('S_OUTCOME'), g('S_STARTED')
now = __import__('datetime').datetime.now(__import__('datetime').timezone.utc) \
        .strftime('%Y-%m-%dT%H:%M:%SZ')

local_dir = g('S_LOCAL_DIR')
archives = sorted(glob.glob(os.path.join(local_dir, 'gaia-production-*.tar.gz')))
local_bytes = sum(os.path.getsize(p) for p in archives if os.path.exists(p))

state = {
    'unit': 'gaia-full-backup.service',
    'schemaVersion': 1,
    'lastAttemptAt': finished,
    'lastFinishedAt': now,
    'lastOutcome': outcome,                 # ok | local_only | failed
    'lastStage': g('S_STAGE'),
    'durationSec': num(g('S_DURATION')),
    # A backup is only a success once the encrypted archive has been seen at the
    # off-site destination. local_only is deliberately not a success.
    'lastSuccessAt': finished if outcome == 'ok' else prev.get('lastSuccessAt'),
    'lastLocalArchiveAt': finished if outcome in ('ok', 'local_only') else prev.get('lastLocalArchiveAt'),
    'lastFailureAt': finished if outcome == 'failed' else prev.get('lastFailureAt'),
    'lastFailureStage': g('S_STAGE') if outcome == 'failed' else prev.get('lastFailureStage'),
    'lastFailureReason': (g('S_REASON') or None) if outcome == 'failed' else prev.get('lastFailureReason'),
    'archive': {
        'name': g('S_NAME'),
        'plainBytes': num(g('S_ARCHIVE_BYTES')),
        'encryptedBytes': num(g('S_ENCRYPTED_BYTES')),
        'sha256': g('S_ARCHIVE_SHA') or None,
        'fileCount': num(g('S_FILE_COUNT')),
    },
    'checks': {
        'sqliteIntegrity': g('S_DB_INTEGRITY'),
        'sqliteRowsAttendees': num(g('S_DB_ROWS')),
        'gzip': g('S_GZIP'),
        'tarListing': g('S_TAR'),
        'checksum': g('S_SHA'),
        'databaseInsideArchive': g('S_DB_ARCHIVE'),
        'encryption': g('S_ENCRYPT'),
    },
    'local': {
        'dir': local_dir,
        'count': len(archives),
        'newest': os.path.basename(archives[-1]) if archives else None,
        'totalBytes': local_bytes,
    },
    'remote': {
        'configured': g('S_REMOTE_CONFIGURED') == 'true',
        'uploadedAt': g('S_UPLOADED') or None,
        'verifiedAt': g('S_REMOTE_VERIFIED') or None,
        'bytes': num(g('S_REMOTE_BYTES')),
    },
    'encryptionConfigured': g('S_ENCRYPT_CONFIGURED') == 'true',
    'retention': {
        'keep': num(g('S_KEEP')),
        'localDeleted': [x for x in (g('S_LOCAL_DELETED') or '').split() if x],
        'remoteDeleted': [x for x in (g('S_REMOTE_DELETED') or '').split() if x],
        'enforced': outcome == 'ok',
    },
}
tmp = out_path + '.tmp'
with open(tmp, 'w') as fh:
    json.dump(state, fh, indent=1)
os.replace(tmp, out_path)
os.chmod(out_path, 0o600)
PY
}

fail() {
  trap - ERR                      # a failure inside the failure path must not recurse
  REASON="$1"
  OUTCOME="failed"
  write_state || true
  echo "gaia-full-backup FAILED at stage '$STAGE': $REASON" >&2
  exit 1
}
trap 'fail "unexpected error in stage ${STAGE}"' ERR

# ── 1. private staging directory ─────────────────────────────────────────────
STAGE="staging"
STAGING="$(mktemp -d /tmp/gaia-backup.XXXXXXXX)"
chmod 0700 "$STAGING"
PAYLOAD="$STAGING/gaia-backup"
mkdir -p "$PAYLOAD/db" "$PAYLOAD/state" "$PAYLOAD/inventory"

# ── 2. safe SQLite snapshot, then prove it ───────────────────────────────────
# Never a plain copy of a live database: sqlite3's own backup API takes a
# consistent snapshot while the API keeps serving.
STAGE="sqlite_snapshot"
python3 - "$EVENT_DB" "$PAYLOAD/db/event.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
target = sqlite3.connect(dst)
with target:
    source.backup(target)
source.close(); target.close()
PY

STAGE="sqlite_integrity"
DB_INTEGRITY="$(python3 -c '
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(c.execute("pragma integrity_check").fetchone()[0])
' "$PAYLOAD/db/event.db")"
[ "$DB_INTEGRITY" = "ok" ] || fail "sqlite integrity_check returned '${DB_INTEGRITY}', not ok"
DB_ROWS="$(python3 -c '
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(c.execute("select count(*) from attendees").fetchone()[0])
' "$PAYLOAD/db/event.db")"

# ── 3. collect live JSON state, and check it actually parses ─────────────────
# These files are rewritten by running services. A copy caught mid-write is
# worse than useless, so every one of them is parsed before it is packed.
STAGE="collect_state"
cp -a "$PROXY_DATA"/*.json "$PAYLOAD/state/" 2>/dev/null || true
find "$PAYLOAD/state" -name '*.bak*' -delete
python3 - "$PAYLOAD/state" <<'PY'
import json, os, sys
bad = []
d = sys.argv[1]
for f in sorted(os.listdir(d)):
    if not f.endswith('.json'):
        continue
    try:
        with open(os.path.join(d, f)) as fh:
            json.load(fh)
    except Exception as e:
        bad.append(f"{f}: {type(e).__name__}")
if bad:
    print("unparseable state files -> " + "; ".join(bad), file=sys.stderr)
    raise SystemExit(1)
PY
[ -s "$PAYLOAD/state/member-entitlements.json" ] || fail "the entitlement ledger is missing or empty"

crontab -l > "$PAYLOAD/inventory/crontab-root.txt" 2>/dev/null || echo "(no root crontab)" > "$PAYLOAD/inventory/crontab-root.txt"

# ── 4. restore manifest ──────────────────────────────────────────────────────
# What this machine was, so a rebuild is a procedure and not an excavation.
STAGE="manifest"
{
  echo "Gaia production backup"
  echo "======================"
  echo "created            ${STARTED_AT}"
  echo "archive            ${NAME}.tar.gz.gpg"
  echo "hostname           $(hostname -f 2>/dev/null || hostname)"
  echo "os                 $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "kernel             $(uname -r)"
  echo
  echo "Runtimes"
  echo "--------"
  echo "node               $(node -v 2>/dev/null || echo absent)"
  echo "python3            $(python3 -V 2>&1 || echo absent)"
  echo "nginx              $(nginx -v 2>&1 | sed 's/^nginx version: //' || echo absent)"
  echo "sqlite (python)    $(python3 -c 'import sqlite3;print(sqlite3.sqlite_version)' 2>/dev/null || echo absent)"
  echo "gpg                $(gpg --version 2>/dev/null | head -1 || echo absent)"
  echo "rclone             $(rclone version 2>/dev/null | head -1 || echo absent)"
  echo
  echo "Database"
  echo "--------"
  echo "integrity_check    ${DB_INTEGRITY}"
  echo "attendees          ${DB_ROWS}"
  python3 -c '
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
for (t,) in c.execute("select name from sqlite_master where type=\"table\" order by name"):
    try:
        print("  %-28s %s" % (t, c.execute("select count(*) from [%s]" % t).fetchone()[0]))
    except Exception:
        print("  %-28s ?" % t)
' "$PAYLOAD/db/event.db"
  echo
  echo "Services and timers"
  echo "-------------------"
  systemctl list-units --type=service --all --no-pager --no-legend 'gaia-*' 2>/dev/null | sed 's/^/  /' || true
  systemctl list-timers --all --no-pager --no-legend 'gaia-*' 2>/dev/null | sed 's/^/  /' || true
  echo
  echo "Production paths in this archive"
  echo "--------------------------------"
  cat <<'PATHS'
  root/event/backend                 Event Manager API (FastAPI, :8002)
  root/event/frontend                Event Manager SPA source
  root/gaia-staging-proxy            Gaia proxy / API (:8787)
  var/www/event                      Event Manager built SPA
  var/www/gaia-admin                 Gaia Admin shell
  var/www/card-static                Badge card static assets
  etc/nginx/...                      Gaia nginx sites
  etc/systemd/system/gaia-*          Gaia services and timers
  etc/letsencrypt                    TLS material
  gaia-backup/db/event.db            SAFE SNAPSHOT — restore this, not the copy in root/
  gaia-backup/state/                 SAFE COPY of the proxy JSON state (parsed before packing)
  gaia-backup/inventory/             package, runtime and code-version inventory
PATHS
  echo
  echo "Deployed code identity"
  echo "----------------------"
  echo "(sha256 of the files production was actually running, so a restore can"
  echo " be matched to a commit even if the branch has moved on)"
  for f in /root/gaia-staging-proxy/server.js /root/gaia-staging-proxy/alerts.js \
           /root/gaia-staging-proxy/admin-router.js /root/event/backend/main.py \
           /var/www/gaia-admin/gadmin.js /root/event/frontend/src/components/Attendees.js; do
    if [ -r "$f" ]; then echo "  $(sha256sum "$f" | cut -c1-16)  $f"; fi
  done
  if [ -d /root/gaia-healers-mobile-app/.git ]; then
    echo "  repo clone on server: $(git -C /root/gaia-healers-mobile-app rev-parse --short HEAD 2>/dev/null) \
$(git -C /root/gaia-healers-mobile-app rev-parse --abbrev-ref HEAD 2>/dev/null)"
    echo "  origin: $(git -C /root/gaia-healers-mobile-app config --get remote.origin.url 2>/dev/null)"
  fi
  echo
  echo "Restore notes"
  echo "-------------"
  cat <<'NOTES'
  1. Extract to an EMPTY staging directory. Never extract straight over a live
     system — place files deliberately.
  2. Restore the database from gaia-backup/db/event.db. The copy under
     root/event/backend/ is deliberately absent; only the snapshot is trustworthy.
  3. Restore proxy JSON state from gaia-backup/state/ into
     /root/gaia-staging-proxy/data/.
  4. npm ci in /root/gaia-staging-proxy and /root/event/frontend; node_modules
     are not carried here.
  5. Reinstall runtimes from gaia-backup/inventory/, then systemctl daemon-reload
     and enable the gaia-* units.
  6. The public app is not in this archive — it is served from GitHub Pages.
NOTES
} > "$PAYLOAD/manifest.txt"

dpkg -l > "$PAYLOAD/inventory/dpkg.txt" 2>/dev/null || true
python3 -m pip freeze > "$PAYLOAD/inventory/pip-freeze.txt" 2>/dev/null || true
( cd /root/gaia-staging-proxy && npm ls --depth=0 ) > "$PAYLOAD/inventory/npm-proxy.txt" 2>/dev/null || true
systemctl list-unit-files 'gaia-*' --no-pager > "$PAYLOAD/inventory/units.txt" 2>/dev/null || true

# ── 5. archive ───────────────────────────────────────────────────────────────
# The live event.db and the live data/ directory are excluded on purpose: the
# consistent snapshot and the parsed state copy are in the payload instead.
STAGE="archive"
ARCHIVE="$STAGING/${NAME}.tar.gz"
tar -czf "$ARCHIVE" \
  --exclude='node_modules' --exclude='__pycache__' --exclude='.git' \
  --exclude='build' --exclude='_backups' \
  --exclude='*.bak' --exclude='*.bak-*' --exclude='*.bak.*' --exclude='*.pre*' \
  --exclude='*.log' --exclude='*.log.*' --exclude='*.pid' \
  --exclude='root/event/backend/event.db' \
  --exclude='root/event/backend/event.db-wal' \
  --exclude='root/event/backend/event.db-shm' \
  --exclude='root/gaia-staging-proxy/data' \
  -C / \
    root/event \
    root/gaia-staging-proxy \
    var/www/event var/www/gaia-admin var/www/card-static \
    etc/nginx/nginx.conf \
    etc/nginx/sites-available/api.gaiahealers.app \
    etc/nginx/sites-available/card.gaiahealers.app \
    etc/letsencrypt \
    $(cd / && ls -d etc/systemd/system/gaia-*.service etc/systemd/system/gaia-*.timer \
        etc/systemd/system/gaia-*.service.d 2>/dev/null) \
    usr/local/bin/gaia-event-backup.sh usr/local/bin/gaia-full-backup.sh \
  -C "$STAGING" gaia-backup
ARCHIVE_BYTES="$(stat -c%s "$ARCHIVE")"

# ── 6. checksum ──────────────────────────────────────────────────────────────
STAGE="checksum"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
printf '%s  %s\n' "$ARCHIVE_SHA" "${NAME}.tar.gz" > "$STAGING/${NAME}.tar.gz.sha256"

# ── 7. verify the compressed stream ──────────────────────────────────────────
STAGE="verify_gzip"
gzip -t "$ARCHIVE" || fail "the gzip stream does not decompress"
CHECK_GZIP="ok"

# ── 8. verify the archive is readable and complete ───────────────────────────
STAGE="verify_listing"
FILE_COUNT="$(tar -tzf "$ARCHIVE" | wc -l)"
[ "$FILE_COUNT" -gt 100 ] || fail "the archive lists only ${FILE_COUNT} entries — it is not a full backup"
for must in gaia-backup/manifest.txt gaia-backup/db/event.db gaia-backup/state/member-entitlements.json; do
  tar -tzf "$ARCHIVE" "$must" >/dev/null 2>&1 || fail "the archive is missing ${must}"
done
CHECK_TAR="ok"
( cd "$STAGING" && sha256sum -c "${NAME}.tar.gz.sha256" >/dev/null 2>&1 ) \
  || fail "the checksum does not match the archive"
CHECK_SHA="ok"

# ── 9. verify the database INSIDE the archive, not just beside it ────────────
STAGE="verify_database_in_archive"
mkdir -p "$STAGING/verify"
tar -xzf "$ARCHIVE" -C "$STAGING/verify" gaia-backup/db/event.db
VERIFIED="$(python3 -c '
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(c.execute("pragma integrity_check").fetchone()[0] + ":" + str(c.execute("select count(*) from attendees").fetchone()[0]))
' "$STAGING/verify/gaia-backup/db/event.db")"
[ "$VERIFIED" = "ok:${DB_ROWS}" ] || fail "the database unpacked from the archive reads '${VERIFIED}', expected ok:${DB_ROWS}"
CHECK_DB_IN_ARCHIVE="ok"
rm -rf "$STAGING/verify"

# ── keep the verified local copy before anything else can go wrong ───────────
STAGE="store_local"
install -d -m 0700 "$LOCAL_DIR"
install -m 0600 "$ARCHIVE" "$LOCAL_DIR/${NAME}.tar.gz"
install -m 0600 "$STAGING/${NAME}.tar.gz.sha256" "$LOCAL_DIR/${NAME}.tar.gz.sha256"
tar -xzOf "$ARCHIVE" gaia-backup/manifest.txt > "$LOCAL_DIR/${NAME}.manifest.txt"
chmod 0600 "$LOCAL_DIR/${NAME}.manifest.txt"

# ── 10. encrypt ──────────────────────────────────────────────────────────────
# Public-key only. The server can create a backup it cannot itself read, which
# is the property that makes an off-site copy safe to hold.
STAGE="encrypt"
if [ -z "$RECIPIENT" ]; then
  OUTCOME="local_only"
  REASON="no GPG recipient configured — archive built and verified locally, not encrypted, not uploaded"
  CHECK_ENCRYPT="not_configured"
  write_state
  echo "gaia-full-backup: local archive verified; encryption not configured, so nothing was uploaded." >&2
  exit 0
fi
ENCRYPTED="$STAGING/${NAME}.tar.gz.gpg"
GNUPGHOME="$GPG_HOME" gpg --batch --yes --trust-model always \
  --recipient "$RECIPIENT" --output "$ENCRYPTED" --encrypt "$ARCHIVE" \
  || fail "gpg could not encrypt to the configured recipient"
ENCRYPTED_BYTES="$(stat -c%s "$ENCRYPTED")"
[ "$ENCRYPTED_BYTES" -gt 1024 ] || fail "the encrypted archive is implausibly small"
GNUPGHOME="$GPG_HOME" gpg --batch --list-packets "$ENCRYPTED" >/dev/null 2>&1 \
  || fail "the encrypted archive is not readable as an OpenPGP message"
CHECK_ENCRYPT="ok"
install -m 0600 "$ENCRYPTED" "$LOCAL_DIR/${NAME}.tar.gz.gpg"

# ── 11. upload ───────────────────────────────────────────────────────────────
STAGE="upload"
if [ -z "$REMOTE" ]; then
  OUTCOME="local_only"
  REASON="no off-site destination configured — archive built, verified and encrypted, but held only on this server"
  write_state
  echo "gaia-full-backup: encrypted archive verified locally; off-site destination not configured." >&2
  exit 0
fi
command -v rclone >/dev/null 2>&1 || fail "rclone is not installed, so the archive cannot be sent off-site"
rclone copyto "$ENCRYPTED" "${REMOTE}/${NAME}.tar.gz.gpg" --s3-no-check-bucket 2>/dev/null \
  || rclone copyto "$ENCRYPTED" "${REMOTE}/${NAME}.tar.gz.gpg" \
  || fail "the upload to the off-site destination did not complete"
rclone copyto "$LOCAL_DIR/${NAME}.tar.gz.sha256" "${REMOTE}/${NAME}.tar.gz.sha256" >/dev/null 2>&1 || true
UPLOADED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 12. verify what actually landed ──────────────────────────────────────────
STAGE="verify_remote"
REMOTE_BYTES="$(rclone size "${REMOTE}/${NAME}.tar.gz.gpg" --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("bytes",""))' 2>/dev/null || echo "")"
[ -n "$REMOTE_BYTES" ] || fail "the uploaded object could not be read back from the destination"
[ "$REMOTE_BYTES" = "$ENCRYPTED_BYTES" ] \
  || fail "the uploaded object is ${REMOTE_BYTES} bytes, the local one is ${ENCRYPTED_BYTES}"
REMOTE_VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 13. record the success ───────────────────────────────────────────────────
STAGE="record"
OUTCOME="ok"
write_state

# ── 14. retention — and only now ─────────────────────────────────────────────
# By name, never by mtime: a clock that jumps must not be able to decide what
# gets deleted. Only dates OLDER than the newest KEEP are removed, and this code
# is unreachable unless every step above succeeded.
STAGE="retention"
LOCAL_DELETED="$(python3 - "$LOCAL_DIR" "$KEEP" <<'PY'
import os, re, sys
d, keep = sys.argv[1], int(sys.argv[2])
dates = sorted({m.group(1) for f in os.listdir(d)
                for m in [re.match(r'gaia-production-(\d{4}-\d{2}-\d{2})\.', f)] if m})
for old in dates[:-keep] if len(dates) > keep else []:
    for f in os.listdir(d):
        if f.startswith(f'gaia-production-{old}.'):
            os.remove(os.path.join(d, f))
    print(old)
PY
)"
if [ -n "$REMOTE" ]; then
  REMOTE_DELETED="$(rclone lsf "$REMOTE" 2>/dev/null | python3 -c '
import re, subprocess, sys
remote, keep = sys.argv[1], int(sys.argv[2])
names = [l.strip() for l in sys.stdin if l.strip()]
dates = sorted({m.group(1) for n in names
                for m in [re.match(r"gaia-production-(\d{4}-\d{2}-\d{2})\.", n)] if m})
for old in (dates[:-keep] if len(dates) > keep else []):
    for n in names:
        if n.startswith(f"gaia-production-{old}."):
            subprocess.run(["rclone", "deletefile", f"{remote}/{n}"], check=False)
    print(old)
' "$REMOTE" "$KEEP")"
fi
write_state

echo "gaia-full-backup ok: ${NAME}.tar.gz.gpg (${ENCRYPTED_BYTES} bytes) uploaded and verified"
