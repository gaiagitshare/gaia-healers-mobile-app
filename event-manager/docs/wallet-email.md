# The wallet link in the confirmation e-mail

## The link

| URL | Who it is for | Needs |
|---|---|---|
| `https://api.gaiahealers.app/wallet` | anyone signed into the app | nothing — works today |
| `https://api.gaiahealers.app/wallet/<badge token>` | one person, no sign-in | the token in a GHL field |
| `…?store=google` / `…?store=apple` | an explicit button per store | — |

A confirmation e-mail carries no session, and a Google save link is signed for
one hour, so the address in the mail is **resolved when it is clicked** — it
stays good for months. The badge token is the one already printed on the badge
and already accepted by the door scanner, so a link carrying it gives away
nothing the badge in their hand does not.

## What happens on a tap

1. The proxy asks which stores can issue today.
2. None can → a branded page: *"phone passes are not switched on for this
   event yet, your badge QR in the app works at the door."* Never a 404.
3. Google → a `302` to the save-to-Google-Wallet link.
4. Apple → the `.pkpass` file streams straight down; iOS opens Wallet.
5. Anything else (unknown token, cancelled ticket) → the same branded page in
   plain English.

## Getting the token into GHL (only for the per-person link)

1. Admin panel → the event → **Attendees → Export CSV**.
2. Two new columns: `gaia_badge_token` and `gaia_wallet_link` (already
   assembled).
3. Import `gaia_badge_token` as a contact custom field in GHL.
4. In the e-mail use `https://api.gaiahealers.app/wallet/{{contact.gaia_badge_token}}`.

The export is permission-checked and written to the export audit trail, so who
took the list and how much of it is always recoverable.

## Switching a store on

```
python3 /root/event/backend/tools/wallet_setup.py google \
  --issuer <issuer id> --key /path/to/service-account.json --apply
```

It validates the key, writes `backend/.env`, restarts the API and prints a real
save link to check. The proxy notices within a minute. Apple needs three PEMs
(pass certificate, its key, the WWDR intermediate) and the same command with
`apple`.

## Tests

`python3 /root/event/backend/test_wallet_link.py` — 14 checks, incl. that no
badge token is shared by two different people and that a token held across two
years resolves to **2026**, not the archived 2025 conference.
