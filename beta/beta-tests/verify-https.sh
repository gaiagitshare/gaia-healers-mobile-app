#!/bin/bash
# Gaia Healers Membership 2.0 beta: post-publication check of https://beta.gaiahealers.app
# Run AFTER the owner has enabled the nginx site and certbot. Read-only: it signs in once with the staff
# password (read from the beta env file, never printed, never on a command line) and changes nothing.
#
#   bash /root/gaia-membership-staging-app/beta-tests/verify-https.sh            # full run (needs root to read the env file)
#   NO_LOGIN=1 bash .../verify-https.sh                                          # skip the signed-in checks
#
# Exit code 0 = all PASS (WARN allowed), 1 = at least one FAIL.
set -u
HOST=beta.gaiahealers.app; B="https://$HOST"; API=https://api.gaiahealers.app
ENV_FILE=/root/.config/gaia-membership-beta.env
UA='gaia-beta-verify/1'
pass=0; fail=0; warn=0
ok()   { pass=$((pass+1)); printf 'PASS  %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf 'FAIL  %s\n' "$*"; }
note() { warn=$((warn+1)); printf 'WARN  %s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (expected $3, got $2)"; fi; }
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
# Test hook only (pre-publication rehearsal against a local TLS stand-in): SIMULATE_TLS_PORT=8443 routes $HOST:443 to
# 127.0.0.1:<port> and skips certificate verification for that rehearsal. Never set it for the real check.
EXTRA=(); [ -n "${SIMULATE_TLS_PORT:-}" ] && EXTRA=(--connect-to "$HOST:443:127.0.0.1:$SIMULATE_TLS_PORT" -k) && echo "REHEARSAL MODE: $HOST:443 -> 127.0.0.1:$SIMULATE_TLS_PORT (certificate checks will fail by design)"
curl() { command curl ${EXTRA[@]+"${EXTRA[@]}"} "$@"; }
code() { curl -sS -o /dev/null -w '%{http_code}' -A "$UA" --max-time 15 "$@" 2>/dev/null; }
hdrs() { curl -sS -D - -o /dev/null -A "$UA" --max-time 15 "$@" 2>/dev/null | tr -d '\r'; }

echo "== 1. DNS and redirect"
ip=$(getent ahostsv4 "$HOST" | awk 'NR==1{print $1}')
check "DNS A record for $HOST" "${ip:-none}" "80.241.220.129"
h=$(hdrs "http://$HOST/")
st=$(echo "$h" | awk 'NR==1{print $2}'); loc=$(echo "$h" | awk 'tolower($1)=="location:"{print $2}')
if [[ "$st" =~ ^30[178]$ ]] && [[ "$loc" == "https://$HOST/"* ]]; then ok "http:// redirects to https:// ($st -> $loc)"; else bad "http:// redirect (got $st -> ${loc:-none})"; fi

echo "== 2. Certificate"
if curl -sS -o /dev/null --max-time 15 "$B/" 2>"$TMP/tls"; then ok "TLS chain verifies for $HOST (curl, system CA store)"; else bad "TLS verification: $(head -c 200 "$TMP/tls")"; fi
TGT="$HOST:443"; [ -n "${SIMULATE_TLS_PORT:-}" ] && TGT="127.0.0.1:$SIMULATE_TLS_PORT"
cert=$(echo | openssl s_client -servername "$HOST" -connect "$TGT" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate -ext subjectAltName 2>/dev/null)
if echo "$cert" | grep -q "DNS:$HOST"; then ok "certificate names $HOST (subjectAltName)"; else bad "certificate does not name $HOST (served: $(echo "$cert" | sed -n 's/^subject=//p'); nginx site or certbot not done yet?)"; cert=""; fi
end=$(echo "$cert" | sed -n 's/^notAfter=//p'); days=$(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
if [ "$days" -ge 14 ]; then ok "certificate valid for $days more days (until $end)"; elif [ "$days" -gt 0 ]; then note "certificate expires in $days days"; else bad "certificate expired or unreadable"; fi
echo "$cert" | grep -q "Let's Encrypt" && ok "issuer: Let's Encrypt" || note "issuer: $(echo "$cert" | sed -n 's/^issuer=//p')"

echo "== 3. Landing page, security headers, noindex"
h=$(hdrs "$B/"); body=$(curl -sS -A "$UA" --max-time 15 "$B/")
check "GET / status" "$(echo "$h" | awk 'NR==1{print $2}')" "200"
echo "$body" | grep -q 'Gaia Healers Membership 2.0' && ok "landing page shows Gaia Healers Membership 2.0" || bad "landing page content"
echo "$body" | grep -q 'Coming after Elevate 2026' && ok "banner: Coming after Elevate 2026" || bad "banner text missing"
echo "$body" | grep -q 'href="https://gaiahealers.app"' && ok "Back to the current app link" || bad "back link missing"
echo "$body" | grep -qi '<meta name="robots" content="noindex' && ok "noindex meta tag" || bad "noindex meta tag missing"
for want in 'x-robots-tag: noindex' 'x-frame-options: deny' 'x-content-type-options: nosniff' 'referrer-policy: same-origin' 'content-security-policy:'; do
  echo "$h" | grep -qi "^$want" && ok "header $want" || bad "header $want missing"; done
if echo "$h" | grep -qi '^strict-transport-security:'; then ok "HSTS: $(echo "$h" | grep -i '^strict-transport-security:' | head -1 | cut -d' ' -f2-)"; else note "no HSTS header (optional line in the nginx site file is still commented)"; fi
echo "$h" | grep -qi '^server: .*[0-9]\.[0-9]' && note "Server header shows a version (consider server_tokens off)" || ok "Server header shows no version"
robots=$(curl -sS -A "$UA" --max-time 15 "$B/robots.txt"); echo "$robots" | grep -qx 'Disallow: /' && ok "robots.txt: Disallow: /" || bad "robots.txt"

echo "== 4. Gate: protected paths without the cookie"
for p in /choose /app/home.html /admin/ /api/membership2/me /api/membership2/plans /api/admin/membership2/status /api/admin/membership2/legacy /api/auth/session /api/member/profile; do
  check "GET $p without the beta cookie" "$(code -H 'Accept: application/json' "$B$p")" "401"; done
for p in /api/admin/login /api/admin/membership2/actions /api/membership2/checkout /enter/staff/owner; do
  check "POST $p without the beta cookie" "$(code -X POST -H "Origin: $B" -H 'Content-Type: application/json' -d '{}' "$B$p")" "401"; done
for p in /api/dev/fixture-session '/api/dev/fixture-session?fixture=fixture-free' /API/dev/fixture-session '/api/%64ev/fixture-session'; do
  st=$(code -X POST -H "Origin: $B" -H 'x-gaia-fixture-key: guess' "$B$p"); [[ "$st" =~ ^40[014]$ ]] && ok "POST $p refused ($st)" || bad "POST $p ($st)"; done
# (Host-header tricks are tested on loopback by beta-security.mjs: behind nginx another Host simply selects another site.)

echo "== 5. Wrong password"
h=$(curl -sS -D - -o /dev/null -A "$UA" --max-time 15 -H "Origin: $B" --data 'password=definitely-not-the-beta-password' "$B/login" | tr -d '\r')
check "wrong password status" "$(echo "$h" | awk 'NR==1{print $2}')" "401"
echo "$h" | grep -qi '^set-cookie: gaia_beta=' && bad "wrong password set a beta cookie" || ok "wrong password sets no cookie"
check "login from a foreign Origin" "$(code -H 'Origin: https://evil.example' --data 'password=x' "$B/login")" "403"

echo "== 6. Signed in (password read from $ENV_FILE, never printed)"
if [ -n "${NO_LOGIN:-}" ] || [ ! -r "$ENV_FILE" ]; then note "signed-in checks skipped (NO_LOGIN set or $ENV_FILE not readable)"; else
  # The password goes to curl on stdin (@-), so it never appears in argv, the environment of child processes or this output.
  grep '^BETA_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\n' | curl -sS -D "$TMP/h" -o /dev/null -A "$UA" --max-time 15 -H "Origin: $B" --data-urlencode 'password@-' "$B/login"
  tr -d '\r' < "$TMP/h" > "$TMP/h2"
  check "right password status" "$(awk 'NR==1{print $2}' "$TMP/h2")" "303"
  c=$(grep -i '^set-cookie: gaia_beta=' "$TMP/h2")
  for a in HttpOnly 'SameSite=Lax' Secure; do echo "$c" | grep -qi "; *$a" && ok "beta cookie has $a" || bad "beta cookie lacks $a"; done
  printf 'Cookie: %s\n' "$(echo "$c" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/')" > "$TMP/ck"; chmod 600 "$TMP/ck"
  check "GET /choose signed in" "$(code -H @"$TMP/ck" "$B/choose")" "200"
  check "POST /api/dev/fixture-session signed in" "$(code -X POST -H @"$TMP/ck" -H "Origin: $B" "$B/api/dev/fixture-session?fixture=fixture-free")" "404"
  st=$(curl -sS -D "$TMP/m" -o /dev/null -A "$UA" --max-time 20 -X POST -H @"$TMP/ck" -H "Origin: $B" "$B/enter/member/pilot"; awk 'NR==1{print $2}' "$TMP/m")
  check "choose the pilot member (fixture session minted by the beta server)" "$st" "303"
  grep -qi '^set-cookie: gaia_member_session=.*Secure' "$TMP/m" && ok "member cookie is Secure" || bad "member cookie not Secure"
  mc=$(tr -d '\r' < "$TMP/m" | grep -i '^set-cookie: gaia_member_session=' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/')
  printf 'Cookie: %s; %s\n' "$(sed 's/^Cookie: //' "$TMP/ck")" "$mc" > "$TMP/ck2"; chmod 600 "$TMP/ck2"
  check "member Membership 2.0 read" "$(code -H @"$TMP/ck2" "$B/api/membership2/me")" "200"
  r=$(curl -sS -A "$UA" --max-time 15 -X POST -H @"$TMP/ck2" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"planKey":"standard","interval":"month"}' "$B/api/membership2/checkout")
  echo "$r" | grep -q 'BETA_SIMULATED' && ok "member checkout is simulated by the beta" || bad "member checkout not simulated"
  curl -sS -A "$UA" --max-time 15 -H @"$TMP/ck2" "$B/app/gaia-app-urls.js" | grep -q "$B" && ok "app API base rewritten to $B" || bad "app API base not rewritten"
  curl -sS -o /dev/null -A "$UA" --max-time 15 -X POST -H @"$TMP/ck" -H "Origin: $B" "$B/logout"
fi

echo "== 7. Production API unchanged"
check "GET $API/health" "$(code "$API/health")" "200"
check "GET $API/api/membership2/plans (Membership 2.0 not live)" "$(code "$API/api/membership2/plans")" "404"
check "GET https://gaiahealers.app/" "$(code -L "https://gaiahealers.app/")" "200"

echo; echo "summary: $pass PASS, $warn WARN, $fail FAIL"
[ "$fail" -eq 0 ]
