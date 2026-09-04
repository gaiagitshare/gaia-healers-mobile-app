from fastapi import FastAPI, Depends, HTTPException, status, File, Form, UploadFile, Body
from fastapi import Request as FastAPIRequest  # urllib.request.Request is imported below and would shadow this
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import List, Optional
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from jose import JWTError, jwt
from passlib.context import CryptContext
from html import unescape
from urllib.request import Request, urlopen
import csv
import threading
import time
import qrcode
import io
import base64
import os
import re
import json
import uuid
import secrets
from dotenv import load_dotenv

from database import engine, SessionLocal, get_db, Base
import models
import schemas
import identity as identity_lib
import authz
import schedule as schedule_lib
import workshops as workshops_lib
import networking as networking_lib
import push as push_lib
import badge_card
from fastapi import Response
from fastapi.responses import HTMLResponse, PlainTextResponse

# Load environment variables
load_dotenv()

# Production scanners must use the venue's actual local date. A time override
# is useful in isolated test environments, but a client-supplied date must not
# be able to turn a one-day pass into access on another day.
ALLOW_SCAN_TIME_OVERRIDE = os.getenv("ALLOW_SCAN_TIME_OVERRIDE", "").strip() == "1"

# Create database tables
Base.metadata.create_all(bind=engine)


def _ensure_event_columns():
    """Lightweight migration: add columns introduced after the DB was first created.
    create_all() only creates missing tables, never missing columns."""
    from sqlalchemy import inspect, text
    try:
        inspector = inspect(engine)
        cols = {c["name"] for c in inspector.get_columns("events")}
        exhibitor_cols = {c["name"] for c in inspector.get_columns("exhibitors")}
    except Exception:
        return
    try:
        _us = {c["name"] for c in inspector.get_columns("unmapped_sales")}
    except Exception:
        _us = set()
    stmts = []
    if _us and "relevance" not in _us:
        stmts.append("ALTER TABLE unmapped_sales ADD COLUMN relevance VARCHAR DEFAULT 'event_like'")
    if _us and "relevance_reason" not in _us:
        stmts.append("ALTER TABLE unmapped_sales ADD COLUMN relevance_reason VARCHAR")
    if "source_url" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN source_url VARCHAR")
    if "locked_fields" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN locked_fields JSON")
    if "timezone" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN timezone VARCHAR")
    if "is_published" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN is_published BOOLEAN")
    if "live_enabled" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN live_enabled BOOLEAN")
    if "live_message" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN live_message TEXT")
    if "hero_image_url" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN hero_image_url VARCHAR")
    if "registration_url" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN registration_url VARCHAR")
    if "registration_label" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN registration_label VARCHAR")
    if "public_counters" not in cols:
        # Defaults to off. An existing event does not start publishing its
        # attendance the moment this ships — the organiser opts in.
        stmts.append("ALTER TABLE events ADD COLUMN public_counters BOOLEAN DEFAULT 0")
    for column, ddl in (
        ("description", "ALTER TABLE exhibitors ADD COLUMN description TEXT"),
        ("logo_url", "ALTER TABLE exhibitors ADD COLUMN logo_url VARCHAR"),
        ("website", "ALTER TABLE exhibitors ADD COLUMN website VARCHAR"),
        ("category", "ALTER TABLE exhibitors ADD COLUMN category VARCHAR"),
        ("sort_order", "ALTER TABLE exhibitors ADD COLUMN sort_order INTEGER"),
        ("is_published", "ALTER TABLE exhibitors ADD COLUMN is_published BOOLEAN"),
    ):
        if column not in exhibitor_cols:
            stmts.append(ddl)
    try:
        attendee_cols = {c["name"] for c in inspector.get_columns("attendees")}
    except Exception:
        attendee_cols = set()
    if "ticket_type_id" not in attendee_cols:
        stmts.append("ALTER TABLE attendees ADD COLUMN ticket_type_id INTEGER")
    # Consent defaults to 0 — an existing attendee does not retroactively agree
    # to have their contact details shared because a column appeared.
    if "share_email_with_exhibitors" not in attendee_cols:
        stmts.append("ALTER TABLE attendees ADD COLUMN share_email_with_exhibitors BOOLEAN DEFAULT 0")
    if "share_phone_with_exhibitors" not in attendee_cols:
        stmts.append("ALTER TABLE attendees ADD COLUMN share_phone_with_exhibitors BOOLEAN DEFAULT 0")
    if "consent_updated_at" not in attendee_cols:
        stmts.append("ALTER TABLE attendees ADD COLUMN consent_updated_at DATETIME")
    if "can_scan_leads" not in exhibitor_cols:
        # Also 0: scanning becomes something an organiser grants, not something
        # every exhibitor row silently acquires by existing.
        stmts.append("ALTER TABLE exhibitors ADD COLUMN can_scan_leads BOOLEAN DEFAULT 0")
    try:
        lead_cols = {c["name"] for c in inspector.get_columns("leads")}
    except Exception:
        lead_cols = set()
    if "status" not in lead_cols:
        stmts.append("ALTER TABLE leads ADD COLUMN status VARCHAR")
    if "consent_snapshot" not in lead_cols:
        stmts.append("ALTER TABLE leads ADD COLUMN consent_snapshot JSON")
    try:
        session_cols = {c["name"] for c in inspector.get_columns("sessions")}
    except Exception:
        session_cols = set()
    if "requires_registration" not in session_cols:
        stmts.append("ALTER TABLE sessions ADD COLUMN requires_registration BOOLEAN DEFAULT 0")
    if "needs_workshop_pass" not in session_cols:
        stmts.append("ALTER TABLE sessions ADD COLUMN needs_workshop_pass BOOLEAN DEFAULT 0")
    try:
        announcement_cols = {c["name"] for c in inspector.get_columns("event_announcements")}
    except Exception:
        announcement_cols = set()
    if "scheduled_for" not in announcement_cols:
        stmts.append("ALTER TABLE event_announcements ADD COLUMN scheduled_for DATETIME")
    if "audience" not in announcement_cols:
        stmts.append("ALTER TABLE event_announcements ADD COLUMN audience JSON")
    if "map_image_url" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN map_image_url VARCHAR")
    if "networking_enabled" not in cols:
        stmts.append("ALTER TABLE events ADD COLUMN networking_enabled BOOLEAN DEFAULT 0")

    # Columns added to other tables after their first creation.
    for table, column, ddl in (
        ("speakers", "is_featured", "ALTER TABLE speakers ADD COLUMN is_featured BOOLEAN"),
        ("sessions", "is_featured", "ALTER TABLE sessions ADD COLUMN is_featured BOOLEAN"),
    ):
        try:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                stmts.append(ddl)
        except Exception:
            pass

    if not stmts:
        return
    with engine.begin() as conn:
        for stmt in stmts:
            try:
                conn.execute(text(stmt))
            except Exception as exc:
                print(f"Event column migration skipped ({stmt}): {exc}")
        # Backfill so existing rows never read back as NULL.
        for backfill in (
            "UPDATE events SET locked_fields = '[]' WHERE locked_fields IS NULL",
            "UPDATE events SET timezone = 'UTC' WHERE timezone IS NULL OR timezone = ''",
            # Events that predate the publish flag are already visible in the app;
            # defaulting them to 0 would silently pull them from members' view.
            "UPDATE events SET is_published = 1 WHERE is_published IS NULL",
            "UPDATE exhibitors SET sort_order = 0 WHERE sort_order IS NULL",
            "UPDATE exhibitors SET is_published = 0 WHERE is_published IS NULL",
            "UPDATE events SET live_enabled = 0 WHERE live_enabled IS NULL",
            "UPDATE speakers SET is_featured = 0 WHERE is_featured IS NULL",
            "UPDATE sessions SET is_featured = 0 WHERE is_featured IS NULL",
        ):
            try:
                conn.execute(text(backfill))
            except Exception:
                pass


_ensure_event_columns()


def _ensure_badge_columns():
    """Badge card + print state columns. Same lightweight pattern as above."""
    from sqlalchemy import inspect, text
    try:
        inspector = inspect(engine)
        att = {c["name"] for c in inspector.get_columns("attendees")}
        prof = {c["name"] for c in inspector.get_columns("networking_profiles")}
    except Exception:
        return
    stmts = []
    for col, ddl in (
        ("public_token", "ALTER TABLE attendees ADD COLUMN public_token VARCHAR"),
        ("registration_source", "ALTER TABLE attendees ADD COLUMN registration_source VARCHAR"),
        ("attendance_type", "ALTER TABLE attendees ADD COLUMN attendance_type VARCHAR"),
        ("ghl_linked_at", "ALTER TABLE attendees ADD COLUMN ghl_linked_at DATETIME"),
        ("door_payment_status", "ALTER TABLE attendees ADD COLUMN door_payment_status VARCHAR"),
        ("door_payment_method", "ALTER TABLE attendees ADD COLUMN door_payment_method VARCHAR"),
        ("door_payment_amount", "ALTER TABLE attendees ADD COLUMN door_payment_amount FLOAT"),
        ("door_payment_currency", "ALTER TABLE attendees ADD COLUMN door_payment_currency VARCHAR"),
        ("door_payment_reference", "ALTER TABLE attendees ADD COLUMN door_payment_reference VARCHAR"),
        ("door_payment_by", "ALTER TABLE attendees ADD COLUMN door_payment_by INTEGER"),
        ("door_payment_at", "ALTER TABLE attendees ADD COLUMN door_payment_at DATETIME"),
        ("door_payment_note", "ALTER TABLE attendees ADD COLUMN door_payment_note VARCHAR"),
        ("badge_printed_at", "ALTER TABLE attendees ADD COLUMN badge_printed_at DATETIME"),
        ("badge_print_count", "ALTER TABLE attendees ADD COLUMN badge_print_count INTEGER DEFAULT 0"),
        ("badge_last_station", "ALTER TABLE attendees ADD COLUMN badge_last_station VARCHAR"),
        ("badge_last_result", "ALTER TABLE attendees ADD COLUMN badge_last_result VARCHAR"),
        ("badge_last_error", "ALTER TABLE attendees ADD COLUMN badge_last_error VARCHAR"),
    ):
        if col not in att:
            stmts.append(ddl)
    for col, ddl in (
        ("card_public", "ALTER TABLE networking_profiles ADD COLUMN card_public BOOLEAN DEFAULT 0"),
        ("card", "ALTER TABLE networking_profiles ADD COLUMN card JSON"),
        ("card_claimed_at", "ALTER TABLE networking_profiles ADD COLUMN card_claimed_at DATETIME"),
        ("card_updated_at", "ALTER TABLE networking_profiles ADD COLUMN card_updated_at DATETIME"),
        ("card_views", "ALTER TABLE networking_profiles ADD COLUMN card_views INTEGER DEFAULT 0"),
        ("card_last_viewed_at", "ALTER TABLE networking_profiles ADD COLUMN card_last_viewed_at DATETIME"),
    ):
        if col not in prof:
            stmts.append(ddl)
    try:
        if "valid_day" not in {c["name"] for c in inspector.get_columns("ticket_types")}:
            stmts.append("ALTER TABLE ticket_types ADD COLUMN valid_day VARCHAR")
    except Exception:
        pass
    stmts.append("CREATE INDEX IF NOT EXISTS ix_attendees_public_token ON attendees (public_token)")
    stmts.append("CREATE INDEX IF NOT EXISTS ix_attendees_registration_source ON attendees (registration_source)")
    stmts.append("CREATE INDEX IF NOT EXISTS ix_attendees_attendance_type ON attendees (attendance_type)")
    with engine.begin() as conn:
        for stmt in stmts:
            try:
                conn.execute(text(stmt))
            except Exception as exc:
                print(f"Badge column migration skipped ({stmt}): {exc}")
        for backfill in ("UPDATE attendees SET badge_print_count = 0 WHERE badge_print_count IS NULL",
                         "UPDATE networking_profiles SET card_public = 0 WHERE card_public IS NULL",
                         "UPDATE networking_profiles SET card_views = 0 WHERE card_views IS NULL"):
            try:
                conn.execute(text(backfill))
            except Exception:
                pass


_ensure_badge_columns()


def _ensure_public_tokens():
    """Every attendee row carries the person's token, from the first start-up
    after this shipped. Idempotent: rows that have one are left alone, and a
    person's second row reuses their first."""
    db = SessionLocal()
    try:
        rows = db.query(models.Attendee).filter(models.Attendee.public_token.is_(None)).all()
        # Oldest first, so a returning person's token is the one from their
        # earliest event and every later row inherits it.
        rows.sort(key=lambda a: (a.id))
        for a in rows:
            badge_card.ensure_public_token(db, models, a, commit=False)
        if rows:
            db.commit()
            print(f"Public badge tokens assigned: {len(rows)}")
    except Exception as exc:
        db.rollback()
        print(f"Public token backfill skipped: {exc}")
    finally:
        db.close()


_ensure_public_tokens()

# Security setup
SECRET_KEY = os.getenv("SECRET_KEY", "your-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
# No default source page: auto-sync only runs for URLs an operator configures.
DEFAULT_EVENT_SOURCE_URL = ""
EVENT_AUTO_SYNC_INTERVAL_SECONDS = int(os.getenv("EVENT_AUTO_SYNC_INTERVAL_SECONDS", "21600"))
EVENT_AUTO_SYNC_URLS = [
    url.strip()
    for url in os.getenv("EVENT_AUTO_SYNC_URLS", DEFAULT_EVENT_SOURCE_URL).split(",")
    if url.strip()
]

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

app = FastAPI(title="Event Management API", version="1.0.0", root_path="/event-api")

# CORS — an explicit allow-list. "*" cannot be combined with credentials: browsers
# reject the pair, and it would expose authenticated endpoints to any origin.
# Override per deployment with EVENT_ALLOWED_ORIGINS (comma-separated).
DEFAULT_ALLOWED_ORIGINS = [
    "https://api.gaiahealers.app",   # serves the admin SPA at /event/
    "https://gaiahealers.app",       # the Gaia member app
    "https://www.gaiahealers.app",
]
ALLOWED_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv("EVENT_ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

@app.on_event("startup")
def start_event_auto_sync():
    if EVENT_AUTO_SYNC_URLS:
        thread = threading.Thread(target=auto_sync_event_sources_loop, daemon=True)
        thread.start()

# Helper functions
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user = db.query(models.User).filter(models.User.id == int(user_id)).first()
    if user is None:
        raise credentials_exception
    return user

def _stamp_card_state(db, attendees):
    """Give Admin what it needs to say "Badge card: <link> · Unclaimed/Public/Private"
    next to a person, without ever loading the card's contents."""
    rows = list(attendees)
    if not rows:
        return rows
    ids = [a.id for a in rows]
    profs = {p.attendee_id: p for p in db.query(models.NetworkingProfile).filter(
        models.NetworkingProfile.attendee_id.in_(ids)).all()}
    for a in rows:
        p = profs.get(a.id)
        if p and p.card_public:
            state = "public"
        elif p and (p.card_claimed_at or (p.card and any(v for k, v in (p.card or {}).items() if k != "tags")) or (p.card or {}).get("tags")):
            state = "private"
        else:
            state = "unclaimed"
        a.card_state = state
        a.card_url = badge_card.card_url(a.public_token) if a.public_token else None
    return rows


def _attendee_from_scan(db, text, event_id=None):
    """Resolve whatever was scanned or typed to ONE attendee row.

    Accepts the raw ticket code (ATT-...), a bare public token, or the printed
    card URL. Returns (attendee | None, parsed | None). When an event is given
    the row must belong to it — the same rule the old exact-match lookup had.
    Without an event (the legacy global /checkin) a token is accepted only if
    the person holds exactly one row in a live event; anything ambiguous is a
    refusal, never a guess.
    """
    parsed = badge_card.parse_scan(text)
    if not parsed:
        return None, None
    kind, value = parsed
    q = db.query(models.Attendee)
    q = q.filter(models.Attendee.qr_code == value) if kind == "qr" else q.filter(models.Attendee.public_token == value)
    if event_id is not None:
        return q.filter(models.Attendee.event_id == event_id).first(), parsed
    rows = q.all()
    if kind == "qr":
        return (rows[0] if rows else None), parsed
    live = []
    for a in rows:
        ev = db.query(models.Event).filter(models.Event.id == a.event_id).first()
        if ev and not ev.is_archived:
            live.append(a)
    return (live[0] if len(live) == 1 else None), parsed


def generate_qr_code(data: str) -> str:
    """Generate QR code and return as base64 string"""
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return f"data:image/png;base64,{img_str}"

def clean_page_text(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", unescape(text)).strip()

MONTH_NUMBERS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH = (
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?"
    r"|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_DAY = r"(\d{1,2})(?:st|nd|rd|th)?"          # tolerate ordinals (20th)
_YEAR = r"(\d{4})"
_DASH = r"(?:\s*(?:[-–—]|to|through|thru|until|–|—)\s*)"  # hyphen/en/em dash or word


def _mnum(month_str: str) -> int:
    return MONTH_NUMBERS[month_str[:3].lower()]


def parse_event_dates(text: str):
    """Parse a date range from free page text. Returns (start, end) datetimes or
    (None, None) if nothing recognizable is found — callers must NOT destroy an
    existing date when this returns None. Tries most-specific patterns first."""
    patterns = [
        # Month D, YYYY <dash> Month D, YYYY  (both years spelled out)
        (_MONTH + r"\s+" + _DAY + r",?\s*" + _YEAR + _DASH + _MONTH + r"\s+" + _DAY + r",?\s*" + _YEAR,
         lambda m: (datetime(int(m.group(3)), _mnum(m.group(1)), int(m.group(2)), 9, 0),
                    datetime(int(m.group(6)), _mnum(m.group(4)), int(m.group(5)), 18, 0))),
        # Month D <dash> Month D, YYYY  (cross-month, single trailing year)
        (_MONTH + r"\s+" + _DAY + _DASH + _MONTH + r"\s+" + _DAY + r",?\s*" + _YEAR,
         lambda m: (datetime(int(m.group(5)), _mnum(m.group(1)), int(m.group(2)), 9, 0),
                    datetime(int(m.group(5)), _mnum(m.group(3)), int(m.group(4)), 18, 0))),
        # Month D <dash> D, YYYY  (same-month range)
        (_MONTH + r"\s+" + _DAY + _DASH + _DAY + r",?\s*" + _YEAR,
         lambda m: (datetime(int(m.group(4)), _mnum(m.group(1)), int(m.group(2)), 9, 0),
                    datetime(int(m.group(4)), _mnum(m.group(1)), int(m.group(3)), 18, 0))),
        # Month D, YYYY  (single day)
        (_MONTH + r"\s+" + _DAY + r",?\s*" + _YEAR,
         lambda m: (datetime(int(m.group(3)), _mnum(m.group(1)), int(m.group(2)), 9, 0),
                    datetime(int(m.group(3)), _mnum(m.group(1)), int(m.group(2)), 18, 0))),
    ]
    for pattern, build in patterns:
        for m in re.finditer(pattern, text, flags=re.IGNORECASE):
            try:
                return build(m)
            except ValueError:
                continue  # impossible date (e.g. Feb 30) → try the next match/pattern
    return (None, None)


def merge_pass_options(existing_fields, new_fields):
    """Union the pass_type select options from existing + freshly-scraped custom
    fields so a pass that is momentarily absent from the page never disappears."""
    def opts(fields):
        for f in (fields or []):
            if f.get("name") == "pass_type":
                return list(f.get("options") or [])
        return []
    existing_opts = opts(existing_fields)
    merged = list(existing_opts)
    for opt in opts(new_fields):
        if opt not in merged:
            merged.append(opt)
    result = [dict(f) for f in (new_fields or [])]
    for f in result:
        if f.get("name") == "pass_type" and merged:
            f["options"] = merged
    return result


def _jsonld_events(html: str):
    """Every schema.org Event object in the page, including ones nested in
    @graph or returned as a list."""
    found = []
    for block in re.findall(r"(?is)<script[^>]+application/ld\+json[^>]*>(.*?)</script>", html):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        queue = data if isinstance(data, list) else [data]
        while queue:
            node = queue.pop(0)
            if not isinstance(node, dict):
                continue
            if isinstance(node.get("@graph"), list):
                queue.extend(node["@graph"])
            node_type = node.get("@type")
            types = node_type if isinstance(node_type, list) else [node_type]
            if any(isinstance(t, str) and t.lower().endswith("event") for t in types):
                found.append(node)
    return found


def _jsonld_location(node: dict) -> str:
    """Venue as a human-readable line: place name first, then locality."""
    place = node.get("location")
    if isinstance(place, list):
        place = place[0] if place else None
    if isinstance(place, str):
        return place.strip()
    if not isinstance(place, dict):
        return ""
    parts = []
    name = place.get("name")
    if isinstance(name, str) and name.strip():
        parts.append(name.strip())
    address = place.get("address")
    if isinstance(address, str) and address.strip():
        parts.append(address.strip())
    elif isinstance(address, dict):
        for key in ("streetAddress", "addressLocality", "addressRegion"):
            value = address.get(key)
            if isinstance(value, str) and value.strip() and value.strip() not in parts:
                parts.append(value.strip())
    return ", ".join(parts)


def _jsonld_offers(node: dict):
    """Ticket names from offers — the page's own words, not a fixed list."""
    offers = node.get("offers")
    if isinstance(offers, dict):
        offers = [offers]
    names = []
    for offer in offers or []:
        if not isinstance(offer, dict):
            continue
        label = offer.get("name") or offer.get("category")
        if isinstance(label, str) and label.strip() and label.strip() not in names:
            names.append(label.strip())
    return names


def _first_image(node: dict) -> str:
    image = node.get("image")
    if isinstance(image, list):
        image = image[0] if image else None
    if isinstance(image, dict):
        image = image.get("url")
    return image.strip() if isinstance(image, str) else ""


def _meta(html: str, attr: str, key: str) -> str:
    match = re.search(
        r'<meta[^>]+%s=["\']%s["\'][^>]+content=["\']([^"\']*)["\']' % (attr, re.escape(key)),
        html, flags=re.IGNORECASE)
    if not match:
        match = re.search(
            r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+%s=["\']%s["\']' % (attr, re.escape(key)),
            html, flags=re.IGNORECASE)
    return unescape(match.group(1)).strip() if match else ""


def _parse_iso(value):
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    # Stored naive: event times mean local time at the venue.
    return parsed.replace(tzinfo=None)


def fetch_page(url: str) -> str:
    request = Request(url, headers={"User-Agent": "GaiaEventManager/1.0"})
    with urlopen(request, timeout=15) as response:
        return response.read().decode("utf-8", errors="ignore")


def grab_event_from_url(url: str, html: Optional[str] = None) -> dict:
    """Read an event page into event fields.

    Nothing here knows about any particular event. Three layers, best first:
    schema.org/Event JSON-LD, then OpenGraph, then the page's own title and
    whatever dates the text yields. Anything that cannot be read is left empty
    for an operator to fill rather than guessed at.
    """
    html = html if html is not None else fetch_page(url)
    text = clean_page_text(html)

    name = description = location = image_url = ""
    start_date = end_date = None
    ticket_names = []

    # 1. schema.org/Event — the only layer that can state venue and tickets as fact.
    events = _jsonld_events(html)
    if events:
        node = events[0]
        if isinstance(node.get("name"), str):
            name = node["name"].strip()
        if isinstance(node.get("description"), str):
            description = node["description"].strip()
        location = _jsonld_location(node)
        image_url = _first_image(node)
        start_date = _parse_iso(node.get("startDate"))
        end_date = _parse_iso(node.get("endDate"))
        ticket_names = _jsonld_offers(node)

    # 2. OpenGraph.
    if not name:
        name = _meta(html, "property", "og:title") or _meta(html, "name", "og:title")
    if not description:
        description = _meta(html, "property", "og:description") or _meta(html, "name", "description")
    if not image_url:
        image_url = _meta(html, "property", "og:image")

    # 3. The page's own title, and generic date parsing over the visible text.
    if not name:
        match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
        name = unescape(match.group(1)).strip() if match else "Imported Event"
    if start_date is None and end_date is None:
        start_date, end_date = parse_event_dates(text)
    if not description and len(text) > 200:
        description = text[:700]

    custom_fields = [
        {"name": "paid_member", "label": "Paid member", "type": "boolean"},
        {"name": "source", "label": "Registration source", "type": "text"},
        {"name": "source_url", "label": "Source URL", "type": "hidden", "value": url},
    ]
    if ticket_names:
        custom_fields.insert(0, {"name": "pass_type", "label": "Access type",
                                 "type": "select", "options": ticket_names})

    return {
        "name": name,
        "description": description,
        # start_date / end_date may be None when the page states no parseable
        # date; the sync layer preserves any existing dates rather than clearing.
        "start_date": start_date,
        "end_date": end_date,
        "location": location,
        "hero_image_url": image_url,
        "is_active": True,
        # Never published by a scrape. An operator reviews what was read off the
        # page and publishes deliberately.
        "is_published": False,
        "source_url": url,
        "custom_fields": custom_fields,
    }


# Fields that carry parsed/free-form content; if a scrape yields an empty/None
# value for these we keep the existing value instead of wiping it.
_PRESERVE_IF_EMPTY = {"start_date", "end_date", "description", "location", "hero_image_url"}
# The scraper never writes these: where to buy is an operator decision.
_SCRAPER_NEVER_WRITES = {"registration_url", "registration_label"}


def _people_from_jsonld(node: dict):
    """Speakers from schema.org performer/performers. Names only if present."""
    people = node.get("performer") or node.get("performers") or []
    if isinstance(people, dict):
        people = [people]
    out = []
    for person in people:
        if isinstance(person, str) and person.strip():
            out.append({"name": person.strip(), "role": "", "bio": "", "photo_url": ""})
        elif isinstance(person, dict):
            name = person.get("name")
            if isinstance(name, str) and name.strip():
                out.append({
                    "name": name.strip(),
                    "role": (person.get("jobTitle") or "") if isinstance(person.get("jobTitle"), str) else "",
                    "bio": (person.get("description") or "") if isinstance(person.get("description"), str) else "",
                    "photo_url": _first_image(person),
                })
    return out


def _sub_sessions_from_jsonld(node: dict):
    """Sessions from schema.org subEvent."""
    subs = node.get("subEvent") or node.get("subEvents") or []
    if isinstance(subs, dict):
        subs = [subs]
    out = []
    for sub in subs:
        if not isinstance(sub, dict):
            continue
        title = sub.get("name")
        if not isinstance(title, str) or not title.strip():
            continue
        out.append({
            "title": title.strip(),
            "description": sub.get("description") if isinstance(sub.get("description"), str) else "",
            "start_time": _parse_iso(sub.get("startDate")),
            "end_time": _parse_iso(sub.get("endDate")),
            "room": _jsonld_location(sub),
            "speakers": [p["name"] for p in _people_from_jsonld(sub)],
        })
    return out


def _sponsors_from_jsonld(node: dict):
    """Sponsors from schema.org sponsor. Tier is never guessed — an operator
    assigns it, because it is a commercial relationship."""
    sponsors = node.get("sponsor") or node.get("sponsors") or []
    if isinstance(sponsors, dict):
        sponsors = [sponsors]
    out = []
    for sponsor in sponsors:
        if isinstance(sponsor, str) and sponsor.strip():
            out.append({"name": sponsor.strip(), "logo_url": "", "website": ""})
        elif isinstance(sponsor, dict):
            name = sponsor.get("name")
            if isinstance(name, str) and name.strip():
                out.append({
                    "name": name.strip(),
                    "logo_url": _first_image(sponsor),
                    "website": sponsor.get("url") if isinstance(sponsor.get("url"), str) else "",
                })
    return out


def import_related_records(event: models.Event, html: str, db: Session) -> dict:
    """Create/update speakers, sessions and sponsors from a page's structured data.

    Generic by construction: it reads schema.org fields, never a particular
    site's markup. Everything arrives unpublished for review, and matching is on
    (event_id, name/title) so a re-import updates rather than duplicates. If the
    page says nothing, nothing is created — no guessing.
    """
    summary = {"speakers": 0, "sessions": 0, "sponsors": 0}
    events = _jsonld_events(html)
    if not events:
        return summary
    node = events[0]

    for index, person in enumerate(_people_from_jsonld(node)):
        existing = db.query(models.Speaker).filter(
            models.Speaker.event_id == event.id, models.Speaker.name == person["name"]).first()
        if existing:
            for field in ("role", "bio", "photo_url"):
                if person[field]:
                    setattr(existing, field, person[field])
        else:
            db.add(models.Speaker(event_id=event.id, name=person["name"], role=person["role"],
                                  bio=person["bio"], photo_url=person["photo_url"],
                                  sort_order=index, is_published=False))
            summary["speakers"] += 1

    for index, sponsor in enumerate(_sponsors_from_jsonld(node)):
        existing = db.query(models.Sponsor).filter(
            models.Sponsor.event_id == event.id, models.Sponsor.name == sponsor["name"]).first()
        if existing:
            for field in ("logo_url", "website"):
                if sponsor[field]:
                    setattr(existing, field, sponsor[field])
        else:
            # tier defaults to partner; an operator decides the real tier.
            db.add(models.Sponsor(event_id=event.id, name=sponsor["name"], tier="partner",
                                  logo_url=sponsor["logo_url"], website=sponsor["website"],
                                  sort_order=index, is_published=False))
            summary["sponsors"] += 1

    db.flush()
    for index, item in enumerate(_sub_sessions_from_jsonld(node)):
        existing = db.query(models.Session).filter(
            models.Session.event_id == event.id, models.Session.title == item["title"]).first()
        session = existing or models.Session(event_id=event.id, title=item["title"],
                                             sort_order=index, is_published=False)
        for field in ("description", "start_time", "end_time", "room"):
            if item[field]:
                setattr(session, field, item[field])
        if not existing:
            db.add(session)
            summary["sessions"] += 1
        if item["speakers"]:
            people = db.query(models.Speaker).filter(
                models.Speaker.event_id == event.id, models.Speaker.name.in_(item["speakers"])).all()
            session.speakers = people

    db.commit()
    return summary


def sync_event_source(url: str, db: Session, event_id: Optional[int] = None) -> models.Event:
    page_html = fetch_page(url)
    event_data = grab_event_from_url(url, page_html)

    # Match priority: explicit id → same source_url (stable) → legacy name match.
    # Matching on source_url (not the scraped title) is what prevents the auto-sync
    # loop from spawning duplicate events whenever the page title changes.
    db_event = None
    if event_id:
        db_event = db.query(models.Event).filter(models.Event.id == event_id).first()
        if not db_event:
            raise HTTPException(status_code=404, detail="Event not found")
    if db_event is None:
        db_event = db.query(models.Event).filter(models.Event.source_url == url).first()
    if db_event is None:
        db_event = db.query(models.Event).filter(models.Event.name == event_data["name"]).first()

    if db_event:
        locked = set(db_event.locked_fields or [])
        # Publishing is an operator decision, never a scrape's: a re-sync must not
        # unpublish a live event, nor publish one being drafted.
        event_data.pop("is_published", None)
        for field in _SCRAPER_NEVER_WRITES:
            event_data.pop(field, None)
        # union pass options so a momentarily-missing pass isn't dropped
        event_data["custom_fields"] = merge_pass_options(db_event.custom_fields, event_data["custom_fields"])
        for key, value in event_data.items():
            if key in locked:
                continue  # admin edited this field — never overwrite from the scrape
            if key in _PRESERVE_IF_EMPTY and value in (None, "", []):
                continue  # nothing parsed — keep what we already have
            setattr(db_event, key, value)
        db_event.source_url = url
    else:
        db_event = models.Event(**event_data)
        db.add(db_event)

    db.commit()
    db.refresh(db_event)
    # Related records come from the same page, scoped to this event only.
    import_related_records(db_event, page_html, db)
    db.refresh(db_event)
    return db_event

def auto_sync_event_sources_once() -> None:
    db = SessionLocal()
    try:
        for url in EVENT_AUTO_SYNC_URLS:
            try:
                sync_event_source(url, db)
            except Exception as exc:
                print(f"Event auto-sync failed for {url}: {exc}")
    finally:
        db.close()

def auto_sync_event_sources_loop() -> None:
    time.sleep(10)
    while True:
        auto_sync_event_sources_once()
        time.sleep(EVENT_AUTO_SYNC_INTERVAL_SECONDS)

def row_value(row: dict, *keys: str) -> str:
    normalized = {re.sub(r"[^a-z0-9]", "", key.lower()): value for key, value in row.items()}
    for key in keys:
        value = normalized.get(re.sub(r"[^a-z0-9]", "", key.lower()))
        if value:
            return str(value).strip()
    return ""

def truthy(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "paid", "active", "member"}

# Auth endpoints
@app.post("/auth/register", response_model=schemas.User)
def register(user: schemas.UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(models.User).filter(models.User.email == user.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    is_first_user = db.query(models.User).count() == 0
    if not is_first_user:
        raise HTTPException(status_code=403, detail="Account creation is restricted. Ask the event administrator for access.")
    
    hashed_password = get_password_hash(user.password)
    db_user = models.User(
        email=user.email,
        hashed_password=hashed_password,
        full_name=user.full_name,
        is_admin=True
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user

@app.post("/auth/login")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer", "user": user}


@app.post("/auth/change-password")
def change_password(payload: schemas.ChangePassword, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Self-service password rotation for the signed-in admin/staff. Requires the
    current password (so a stolen session cannot silently change it) and a
    minimum-strength new one. Stored only as a bcrypt hash."""
    if not verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    new = payload.new_password or ""
    if len(new) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    if new == payload.current_password:
        raise HTTPException(status_code=400, detail="New password must be different from the current one")
    current_user.hashed_password = get_password_hash(new)
    db.commit()
    return {"ok": True}


@app.post("/auth/set-password")
def set_password(payload: dict = Body(default={}), db: Session = Depends(get_db)):
    """One-time-link password set (no current password needed). The signed token
    carries purpose=setpw + pv (bound to the account's current password hash), so
    the link is single-use: once the password changes, pv changes and the link dies."""
    import hashlib as _hl
    token = (payload or {}).get("token") or ""
    new = (payload or {}).get("new_password") or ""
    try:
        data = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired")
    if data.get("purpose") != "setpw":
        raise HTTPException(status_code=400, detail="Invalid link")
    user = db.query(models.User).filter(models.User.id == int(data.get("sub", 0))).first()
    if not user:
        raise HTTPException(status_code=400, detail="Account not found")
    pv = _hl.sha256((user.hashed_password or "").encode()).hexdigest()[:12]
    if data.get("pv") != pv:
        raise HTTPException(status_code=400, detail="This link has already been used — ask for a fresh one")
    if len(new) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    user.hashed_password = get_password_hash(new)
    db.commit()
    return {"ok": True, "email": user.email}

# Event endpoints
@app.get("/events", response_model=List[schemas.Event])
def get_events(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    query = db.query(models.Event)
    if not current_user.is_admin:
        query = query.join(models.EventRole, models.EventRole.event_id == models.Event.id).filter(
            models.EventRole.user_id == current_user.id
        ).distinct()
    events = query.offset(skip).limit(limit).all()
    
    # Add counts
    for event in events:
        event.attendee_count = db.query(models.Attendee).filter(
            models.Attendee.event_id == event.id
        ).count()
        event.checked_in_count = db.query(models.Attendee).filter(
            models.Attendee.event_id == event.id,
            models.Attendee.is_checked_in == True
        ).count()
    
    return events

@app.post("/events", response_model=schemas.Event)
def create_event(
    event: schemas.EventCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_admin(current_user)
    db_event = models.Event(**event.dict())
    db.add(db_event)
    db.commit()
    db.refresh(db_event)
    return db_event

@app.post("/events/grab", response_model=schemas.Event)
def grab_event(
    grab: schemas.EventGrabRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Import or refresh an event from a public event landing page."""
    if grab.event_id:
        authz.require_cap(db, current_user, grab.event_id, "event.write")
    else:
        authz.require_admin(current_user)
    try:
        return sync_event_source(grab.url, db, grab.event_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read event page: {exc}")

@app.post("/events/auto-sync")
def auto_sync_events(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_admin(current_user)
    synced = []
    errors = []
    for url in EVENT_AUTO_SYNC_URLS:
        try:
            event = sync_event_source(url, db)
            synced.append({"id": event.id, "name": event.name, "url": url})
        except Exception as exc:
            errors.append({"url": url, "error": str(exc)})

    return {"synced": synced, "errors": errors, "source_count": len(EVENT_AUTO_SYNC_URLS)}

@app.get("/events/{event_id}", response_model=schemas.Event)
def get_event(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event_id, "event.read")
    
    event.attendee_count = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id
    ).count()
    event.checked_in_count = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        models.Attendee.is_checked_in == True
    ).count()
    
    return event

@app.get("/public/events/next", response_model=schemas.Event)
def get_next_public_event(db: Session = Depends(get_db)):
    """Return the nearest active, published event that has not ended yet.

    Published matters: without it a draft with a nearer date becomes the app's
    featured event the moment it is created."""
    event = db.query(models.Event).filter(
        models.Event.is_active == True,
        models.Event.is_published == True,
        models.Event.end_date >= datetime.utcnow(),
    ).order_by(models.Event.start_date.asc()).first()
    if not event:
        raise HTTPException(status_code=404, detail="No upcoming active event")

    return attach_event_counts(event, db)

@app.get("/public/events/{event_id}", response_model=schemas.Event)
def get_public_event(
    event_id: int,
    db: Session = Depends(get_db)
):
    """One event, by id, for the app.

    This has to apply the same publish gate as every other public route. Ids are
    sequential, so filtering on is_active alone left a draft event readable by
    anyone who guessed its id — name, dates, venue and registration link
    included — and the app renders a full event page from exactly this payload.
    """
    event = _published_event_or_404(event_id, db)

    attach_event_counts(event, db)

    return event

@app.put("/events/{event_id}", response_model=schemas.Event)
def update_event(
    event_id: int,
    event_update: schemas.EventUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event_id, "event.write")

    changes = event_update.dict(exclude_unset=True)
    # `locked_fields` can be set explicitly to reset which fields the scraper may
    # touch; otherwise every content field the admin edits here is auto-locked so
    # the 6-hour auto-sync never overwrites a manual edit.
    explicit_locks = changes.pop("locked_fields", None)
    for key, value in changes.items():
        setattr(event, key, value)

    if explicit_locks is not None:
        event.locked_fields = list(dict.fromkeys(explicit_locks))
    else:
        auto_lockable = {"name", "description", "start_date", "end_date", "location", "custom_fields"}
        locked = set(event.locked_fields or [])
        locked.update(k for k in changes if k in auto_lockable)
        event.locked_fields = sorted(locked)

    db.commit()
    db.refresh(event)
    return event

@app.delete("/events/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event_id, "event.write")

    # Deleting an event used to leave its rows behind: attendees kept a NULL
    # event_id (still counted in global dashboard totals, still flagged
    # checked-in), and scan logs / ticket mappings kept pointing at an event id
    # that no longer existed. That is how a deleted demo event went on
    # reporting a phantom check-in against the real conference. Remove the
    # dependent rows explicitly, in FK-safe order, inside the same transaction.
    _dependents = [
        ("leads", "attendee_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        # Personal rows hanging off an attendee. The permanent member card is
        # NOT here on purpose: it belongs to the person, not to this event, and
        # the badge they were given has to keep working.
        ("networking_profiles", "attendee_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        ("saved_sessions", "attendee_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        ("connections", "requester_id IN (SELECT id FROM attendees WHERE event_id = :eid) OR target_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        ("feedback", "attendee_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        ("push_subscriptions", "attendee_id IN (SELECT id FROM attendees WHERE event_id = :eid)"),
        ("scan_logs", "event_id = :eid"),
        ("session_attendance", "session_id IN (SELECT id FROM sessions WHERE event_id = :eid)"),
        ("session_registrations", "session_id IN (SELECT id FROM sessions WHERE event_id = :eid)"),
        ("session_speakers", "session_id IN (SELECT id FROM sessions WHERE event_id = :eid)"),
        ("attendees", "event_id = :eid"),
        ("ticket_mappings", "event_id = :eid"),
        ("sessions", "event_id = :eid"),
        ("speakers", "event_id = :eid"),
        ("sponsors", "event_id = :eid"),
        ("exhibitors", "event_id = :eid"),
        ("event_announcements", "event_id = :eid"),
        ("event_roles", "event_id = :eid"),
    ]
    for _table, _where in _dependents:
        try:
            db.execute(text("DELETE FROM %s WHERE %s" % (_table, _where)), {"eid": event_id})
        except Exception:
            # A table absent in this schema version must not block the delete;
            # the point is to leave nothing dangling that does exist.
            pass

    db.delete(event)
    db.commit()
    return {"message": "Event deleted"}

# Attendee endpoints
@app.get("/events/{event_id}/attendees", response_model=List[schemas.Attendee])
def get_attendees(
    event_id: int,
    skip: int = 0,
    limit: int = 10000,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_cap(db, current_user, event_id, "attendee.read")
    attendees = db.query(models.Attendee).filter(
        models.Attendee.event_id == event_id
    ).offset(skip).limit(limit).all()
    for _a in attendees:
        _a.effective_access = _effective_access(db, _a)
    _stamp_card_state(db, attendees)
    return attendees

@app.post("/events/{event_id}/attendees/import", response_model=schemas.AttendeeImportResponse)
async def import_attendees(
    event_id: int,
    file: UploadFile = File(...),
    mark_paid_member: bool = Form(False),
    source: str = Form("admin_csv"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_cap(db, current_user, event_id, "attendee.write")
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    _assert_event_writable(db, event, "import attendees into it")
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a CSV file")

    content = await file.read()
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV is empty or missing headers")

    imported = 0
    skipped = 0
    errors = []
    known_fields = {
        "first name", "firstname", "first_name",
        "last name", "lastname", "last_name",
        "email", "phone", "company",
        "job title", "jobtitle", "job_title", "title",
    }

    for index, row in enumerate(reader, start=2):
        email = row_value(row, "Email", "email", "Email Address")
        first_name = row_value(row, "First Name", "first_name", "firstname", "First")
        last_name = row_value(row, "Last Name", "last_name", "lastname", "Last")
        if not email:
            skipped += 1
            errors.append(f"Row {index}: missing email")
            continue
        if not first_name and not last_name:
            skipped += 1
            errors.append(f"Row {index}: missing attendee name")
            continue

        existing = db.query(models.Attendee).filter(
            models.Attendee.event_id == event_id,
            models.Attendee.email == email
        ).first()
        if existing:
            skipped += 1
            continue

        custom_data = {}
        for key, value in row.items():
            if value is None or not str(value).strip():
                continue
            normalized_key = key.strip()
            if normalized_key.lower() not in known_fields:
                custom_data[normalized_key] = str(value).strip()

        row_paid_member = mark_paid_member or truthy(row_value(
            row,
            "Paid Member",
            "paid_member",
            "Membership Status",
            "Member Status",
            "Payment Status",
        ))
        custom_data["paid_member"] = row_paid_member
        custom_data["source"] = source

        attendee = models.Attendee(
            event_id=event_id,
            email=email,
            first_name=first_name or "Guest",
            last_name=last_name or "",
            company=row_value(row, "Company", "company"),
            job_title=row_value(row, "Job Title", "job_title", "Title"),
            phone=row_value(row, "Phone", "phone", "Mobile"),
            custom_data=custom_data,
            registration_status="registered",
            qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}",
        )
        db.add(attendee)
        db.flush()
        stamp_registration(attendee, "import")
        attach_member_identity(db, attendee)
        imported += 1

    db.commit()
    return schemas.AttendeeImportResponse(imported=imported, skipped=skipped, errors=errors[:50])

@app.post("/attendees", response_model=schemas.Attendee)
def create_attendee(
    attendee: schemas.AttendeeCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    # AUTHZ: manual attendee creation is an organizer action. A signed-in member
    # must never be able to add themselves (or anyone) to an arbitrary event.
    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event.id, "attendee.write")
    # Generate unique QR code
    qr_code = f"ATT-{uuid.uuid4().hex[:12].upper()}"
    
    db_attendee = models.Attendee(
        **attendee.dict(),
        qr_code=qr_code
    )
    db.add(db_attendee)
    db.flush()
    stamp_registration(db_attendee, "admin")
    attach_member_identity(db, db_attendee)
    db.commit()
    db.refresh(db_attendee)
    return db_attendee

@app.post("/register", response_model=schemas.Attendee)
def public_register(
    registration: schemas.RegistrationForm,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Staff-only attendee creation.

    Registration is owned by GHL; this system imports. This endpoint used to be
    anonymous and returned a working QR badge to any caller, which let anyone
    mint badges or block a real import by pre-claiming an email. It now requires
    a signed-in user with attendee.write for the target event.
    """
    event = db.query(models.Event).filter(
        models.Event.id == registration.event_id,
        models.Event.is_active == True
    ).first()
    if event:
        authz.require_cap(db, current_user, event.id, "attendee.write")
    
    if not event:
        raise HTTPException(status_code=404, detail="Event not found or inactive")
    
    # Check if email already registered for this event
    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == registration.event_id,
        models.Attendee.email == registration.email
    ).first()
    
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered for this event")
    
    qr_code = f"ATT-{uuid.uuid4().hex[:12].upper()}"
    
    attendee_data = registration.dict()
    attendee_data['custom_data'] = attendee_data.pop('custom_data', {})
    
    db_attendee = models.Attendee(
        **attendee_data,
        qr_code=qr_code
    )
    db.add(db_attendee)
    db.flush()
    stamp_registration(db_attendee, "admin")
    attach_member_identity(db, db_attendee)
    db.commit()
    db.refresh(db_attendee)
    return db_attendee

@app.post("/events/{event_id}/authorize")
def authorize_scan(event_id: int, payload: schemas.AuthorizeRequest,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Access-control decision for one scan at one zone. The BACKEND decides;
    the scanner only shows the result. Only a successful EVENT_ENTRY marks global
    check-in; a denied conference/zone scan never corrupts attendance."""
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "checkin.perform")
    att, _parsed = _attendee_from_scan(db, payload.qr_code, event_id)
    if not att:
        db.add(models.ScanLog(event_id=event_id, attendee_id=None, qr_code=(payload.qr_code or "")[:120],
                              access_type=(payload.access_type or "EVENT_ENTRY").upper(),
                              result="DENIED", reason="Badge not valid for this event",
                              staff_user_id=current_user.id, session_id=payload.session_id))
        db.commit()
        return {"result": "DENIED", "granted": False, "reason": "This badge is not valid for this event",
                "qr_code": payload.qr_code, "access_type": (payload.access_type or "EVENT_ENTRY").upper()}
    scan_at = payload.at if (ALLOW_SCAN_TIME_OVERRIDE and current_user.is_admin) else None
    dec = _authorize_decision(db, att, event, payload.access_type, scan_at)
    checked_in_now = False
    if dec.get("granted") and dec.get("access_type") == "EVENT_ENTRY":
        if not att.is_checked_in:
            att.is_checked_in = True
            att.checked_in_at = datetime.utcnow()
            checked_in_now = True
    db.add(models.ScanLog(event_id=event_id, attendee_id=att.id, qr_code=att.qr_code,
                          access_type=dec.get("access_type"), result=dec.get("result"),
                          reason=dec.get("reason"), staff_user_id=current_user.id,
                          session_id=payload.session_id))
    db.commit()
    dec["checked_in"] = bool(att.is_checked_in)
    dec["checked_in_now"] = checked_in_now
    return dec


@app.get("/events/{event_id}/scan-logs")
def get_scan_logs(
    event_id: int,
    result: Optional[str] = None,
    access_type: Optional[str] = None,
    limit: int = 250,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Reviewable access-control trail for organisers and platform admins."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "analytics.read")
    query = db.query(models.ScanLog).filter(models.ScanLog.event_id == event_id)
    if result:
        query = query.filter(models.ScanLog.result == result.strip().upper())
    if access_type:
        query = query.filter(models.ScanLog.access_type == access_type.strip().upper())
    rows = query.order_by(models.ScanLog.created_at.desc()).limit(max(1, min(limit, 1000))).all()
    return {
        "event_id": event_id,
        "count": len(rows),
        "items": [{
            "id": row.id,
            "attendee_id": row.attendee_id,
            "qr_code": row.qr_code,
            "access_type": row.access_type,
            "result": row.result,
            "reason": row.reason,
            "staff_user_id": row.staff_user_id,
            "session_id": row.session_id,
            "created_at": row.created_at,
        } for row in rows],
    }


@app.post("/attendees/{attendee_id}/addon-day")
def set_addon_day(attendee_id: int, payload: schemas.AddonDay,
                  db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    """Authorized admin selection of a one-day add-on's day. Records a lifecycle
    event; the app and scanner reflect it immediately from the same resolver."""
    att = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not att:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, att.event_id, "attendee.write")
    cd = dict(att.custom_data or {})
    ents = list(cd.get("entitlements") or [])
    prev = None; hit = False
    for e in ents:
        if e.get("addon_code") == payload.addon_code:
            prev = e.get("day")
            e["day"] = payload.day_label
            e["day_date"] = payload.day_date
            hit = True
    if not hit:
        raise HTTPException(status_code=404, detail="Attendee has no such add-on")
    cd["entitlements"] = ents
    att.custom_data = cd
    changed = bool(prev and prev != payload.day_label)
    _lifecycle_append(att, "day_changed" if changed else "day_selected",
                      actor=(current_user.email or "admin"),
                      addon_code=payload.addon_code, day=payload.day_label,
                      day_date=payload.day_date,
                      **({"from": prev, "reason": payload.reason} if changed else {}))
    db.commit(); db.refresh(att)
    return {"ok": True, "effective_access": _effective_access(db, att)}


@app.get("/events/{event_id}/door-report")
def door_report(event_id: int, db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    """Who arrived at the door, and what we took there.

    Two kinds of money appear here and they are NEVER added together:

      * verified GHL revenue - completed orders, ledgered per attendee. This is
        the number that reconciles against GHL and it is unaffected by anything
        recorded at the desk.
      * Gaia-recorded door payments - cash and card taken by us, on our own
        till. Real money, but not a GHL transaction, so it is reported on its
        own and never blended into the figure above.

    A walk-in whose GHL order later arrived is still counted as a walk-in: how
    somebody arrived does not change retroactively.
    """
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "analytics.read")
    atts = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()

    by_source, by_type, door_status, door_method = {}, {}, {}, {}
    door_total, door_count = 0.0, 0
    ghl_revenue, ghl_orders = 0.0, 0
    awaiting, reconciled, review = [], [], []
    walkins = []

    for a in atts:
        src = a.registration_source or "unknown"
        by_source[src] = by_source.get(src, 0) + 1
        # Verified GHL revenue: from the ledger only, never from door fields.
        for e in ((a.custom_data or {}).get("entitlements") or []):
            if not (e.get("order_id") or e.get("invoice_id")):
                continue
            if str(e.get("order_status") or e.get("status") or "").lower() in ("refunded", "partially_refunded"):
                continue
            ghl_orders += 1
            ghl_revenue += float(e.get("amount") or 0)
        if src != "walk_in":
            continue
        walkins.append(a)
        t = a.attendance_type or "unknown"
        by_type[t] = by_type.get(t, 0) + 1
        st = a.door_payment_status or "none"
        door_status[st] = door_status.get(st, 0) + 1
        if st in ("collected", "pending"):
            m = a.door_payment_method or "unspecified"
            slot = door_method.setdefault(m, {"count": 0, "amount": 0.0})
            slot["count"] += 1
            slot["amount"] += float(a.door_payment_amount or 0)
            if st == "collected":
                door_total += float(a.door_payment_amount or 0)
                door_count += 1
        row = {"attendee_id": a.id,
               "name": ("%s %s" % (a.first_name or "", a.last_name or "")).strip(),
               "attendance_type": t, "door_payment_status": st,
               "amount": a.door_payment_amount, "method": a.door_payment_method,
               "registered_at": (a.custom_data or {}).get("registered_at"),
               "ghl_linked_at": a.ghl_linked_at}
        if st == "needs_review":
            review.append(row)
        if a.ghl_linked_at:
            reconciled.append(row)
        elif t == "paid" and st == "none":
            awaiting.append(row)

    return {
        "event_id": event_id,
        "attendees_total": len(atts),
        "by_registration_source": by_source,
        "walk_ins": {
            "total": len(walkins),
            "by_attendance_type": by_type,
            "by_door_payment_status": door_status,
            "reconciled_with_ghl": len(reconciled),
            "awaiting_ghl_reconciliation": len(awaiting),
            "needs_review": len(review),
        },
        # Ours. Not GHL's.
        "door_payments": {
            "collected_count": door_count,
            "collected_total": round(door_total, 2),
            "by_method": {k: {"count": v["count"], "amount": round(v["amount"], 2)}
                          for k, v in door_method.items()},
            "basis": "Gaia-recorded at the door. Not a GHL transaction and not part of GHL revenue.",
        },
        "verified_ghl_revenue": {
            "orders": ghl_orders,
            "amount": round(ghl_revenue, 2),
            "basis": "Completed GHL orders, from the entitlement ledger. Reconciles against GHL.",
        },
        "lists": {"awaiting_ghl_reconciliation": awaiting[:200],
                  "needs_review": review[:200],
                  "reconciled_with_ghl": reconciled[:200]},
    }


@app.get("/events/{event_id}/acquisition-report")
def acquisition_report(event_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """Sales and acquisition for one event, built ONLY from what Gaia has already
    reconciled out of GHL. GHL is never written to; this is the reporting layer.

    Two metrics that are deliberately NOT the same number:
      * attendees  - unique people (one row, one QR)
      * purchases  - completed qualifying transactions (a base ticket and a later
                     upgrade are two payments by one person, and both are revenue)

    Every row also reports the ATTRIBUTION EVIDENCE behind it, so a contact-level
    guess is never presented with the same confidence as a referrer captured in
    that order's own checkout session.
    """
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    atts = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    tt_name = {t.id: t.name for t in db.query(models.TicketType).filter(
        models.TicketType.event_id == event_id).all()}

    def blank():
        return {"purchases": 0, "attendees": set(), "revenue": 0.0, "tickets": {},
                "first": None, "last": None,
                "evidence": {"purchase_session": 0, "weaker": 0, "none": 0}}

    levels = {"source": {}, "funnel": {}, "page": {}, "product": {}}
    gross = 0.0
    refunded = {"count": 0, "amount": 0.0}
    total_purchases = 0

    for a in atts:
        cd = a.custom_data or {}
        ents = [e for e in (cd.get("entitlements") or []) if e.get("order_id") or e.get("invoice_id")]
        basis = a.acq_source_basis or "unknown"
        bucket = ("purchase_session" if basis.startswith("purchase_session")
                  else "none" if (basis.startswith("direct") or basis == "unknown") else "weaker")
        # The SOURCE is the only one of these captured against the person rather
        # than the payment, so it stays attendee-level: every purchase that person
        # made counts under the one source we have for them. Product, funnel and
        # site are recorded on the purchase itself, so they are grouped per
        # purchase - otherwise an upgrade bought on an upsell page would be
        # reported under whatever the buyer's FIRST product happened to be, and a
        # product with real sales can vanish from the report entirely.
        source_key = a.acq_source_value or "Not captured"
        for e in ents:
            amount = e.get("amount")
            amount = float(amount) if amount is not None else 0.0
            status = str(e.get("order_status") or e.get("status") or "").lower()
            if status in ("refunded", "partially_refunded"):
                refunded["count"] += 1
                refunded["amount"] += amount
                continue
            total_purchases += 1
            gross += amount
            ts = e.get("ts")
            label = tt_name.get(e.get("ticket_type_id"), "?")
            keys = {
                "source": source_key,
                "funnel": e.get("funnel_name") or a.acq_funnel_name or "Not captured",
                "page": e.get("domain") or a.acq_domain or "Not captured",
                "product": e.get("product_name") or a.acq_product_name or "Not captured",
            }
            for lvl, key in keys.items():
                row = levels[lvl].setdefault(key, blank())
                row["purchases"] += 1
                row["attendees"].add(a.id)
                row["revenue"] += amount
                row["tickets"][label] = row["tickets"].get(label, 0) + 1
                if ts and (row["first"] is None or ts < row["first"]):
                    row["first"] = ts
                if ts and (row["last"] is None or ts > row["last"]):
                    row["last"] = ts
                row["evidence"][bucket] += 1

    def dump(d):
        out = []
        for k, v in d.items():
            out.append({"key": k, "purchases": v["purchases"], "attendees": len(v["attendees"]),
                        "revenue": round(v["revenue"], 2), "tickets": v["tickets"],
                        "first": v["first"], "last": v["last"], "evidence": v["evidence"]})
        return sorted(out, key=lambda r: -r["revenue"])

    return {
        "event_id": event_id,
        "attendees": len(atts),
        "purchases": total_purchases,
        "gross_revenue": round(gross, 2),
        "refunded": {"count": refunded["count"], "amount": round(refunded["amount"], 2)},
        "net_revenue": round(gross - refunded["amount"], 2),
        "by_source": dump(levels["source"]),
        "by_funnel": dump(levels["funnel"]),
        "by_page": dump(levels["page"]),
        "by_product": dump(levels["product"]),
    }


@app.get("/events/{event_id}/ticket-counts")
def event_ticket_counts(event_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Operational counts for the event dashboard. Base-ticket counts and add-on
    counts are reported SEPARATELY so an additive add-on never inflates a tier."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    atts = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    from collections import Counter
    base = Counter(); addon = Counter(); status = Counter(); checked = 0
    for a in atts:
        status[_ticket_status(a)] += 1
        if a.is_checked_in:
            checked += 1
        eff = _effective_access(db, a)
        bt = eff.get("base_ticket")
        base[(bt["code"] if bt else "none")] += 1
        for ad in (eff.get("addons") or []):
            addon[ad["code"]] += 1
    return {"total": len(atts), "checked_in": checked, "not_checked_in": len(atts) - checked,
            "by_base_ticket": dict(base), "by_addon": dict(addon), "by_status": dict(status)}


@app.get("/attendees/{attendee_id}", response_model=schemas.AttendeeDetail)
def get_attendee(
    attendee_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.read")
    _eff = _effective_access(db, attendee)
    attendee.effective_access = _eff
    attendee.entitlement_history = _eff.get("entitlement_history")
    _stamp_card_state(db, [attendee])
    return attendee

@app.put("/attendees/{attendee_id}", response_model=schemas.Attendee)
def update_attendee(
    attendee_id: int,
    attendee_update: schemas.AttendeeUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.write")
    
    for key, value in attendee_update.dict(exclude_unset=True).items():
        setattr(attendee, key, value)
    
    db.commit()
    db.refresh(attendee)
    return attendee

@app.delete("/attendees/{attendee_id}")
def delete_attendee(
    attendee_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.write")
    
    db.delete(attendee)
    db.commit()
    return {"message": "Attendee deleted"}

# --- Ticket lifecycle status model (single source of truth) ---------------
# registration_status is canonical. Legacy values ("registered"/None/"") and
# "active" all mean a valid, scannable ticket; the blocked set below is what a
# refund/cancel/revoke moves a ticket into, and what the scanner refuses.
TICKET_BLOCKED_STATUSES = {"refunded", "cancelled", "revoked"}

def _ticket_status(attendee) -> str:
    s = (getattr(attendee, "registration_status", None) or "active").strip().lower()
    return s if s else "active"

def _ticket_active(attendee) -> bool:
    return _ticket_status(attendee) not in TICKET_BLOCKED_STATUSES

def _blocked_reason(attendee):
    return {
        "refunded": "This ticket was refunded and is no longer valid",
        "cancelled": "This ticket was cancelled and is no longer valid",
        "revoked": "This ticket was revoked and is no longer valid",
    }.get(_ticket_status(attendee))

def _tt_rank(db, tt_id) -> int:
    """Upgrade precedence rank from ticket_types.sort_order (higher = better).
    Unknown/unset ranks as 0; no ticket ranks as -1 so any real tier beats none."""
    if not tt_id:
        return -1
    tt = db.query(models.TicketType).filter(models.TicketType.id == tt_id).first()
    if not tt:
        return -1
    return tt.upgrade_rank if tt.upgrade_rank is not None else 0

def _lifecycle_append(attendee, action, actor="system", **extra):
    """Append one immutable audit entry to custom_data.lifecycle. No schema
    migration: the trail lives in the attendee's JSON alongside its identity."""
    cd = dict(attendee.custom_data or {})
    log = list(cd.get("lifecycle") or [])
    entry = {"ts": datetime.utcnow().isoformat(), "action": action, "actor": actor}
    for k, v in extra.items():
        if v is not None:
            entry[k] = v
    log.append(entry)
    cd["lifecycle"] = log
    attendee.custom_data = cd
    return entry


# --- Entitlement ledger --------------------------------------------------------
# Each paid order the attendee holds for this event is recorded here so a refund
# can restore the highest STILL-PAID tier instead of burning the whole ticket.
# A base (is_upgrade=False) is a standalone ticket; upgrades are add-ons that do
# not grant access on their own. Refunded entries are sticky (a re-seen completed
# order never resurrects them). Legacy attendees (no ledger) keep old behavior.
def _ent_record(cd, order_id, tx, tt_id, is_upgrade, addon_code=None, day=None, day_date=None,
                event_id=None, invoice_id=None, amount=None, source=None,
                product_id=None, quantity=None, purchased_at=None):
    """Ledger one paid purchase.

    Most arrive as a completed GHL order. Some arrive as a PAID GHL INVOICE,
    which is a different object with its own id — so the invoice id is recorded
    as itself and never disguised as an order id. Either way the reference is
    what makes the ledger idempotent, so a replay updates rather than duplicates.
    """
    ref = order_id or invoice_id
    if not ref:
        return
    if not tt_id and not addon_code:
        return
    ents = list(cd.get("entitlements") or [])
    for e in ents:
        if (e.get("order_id") or e.get("invoice_id")) == ref and e.get("addon_code") == addon_code:
            if e.get("status") == "refunded":
                cd["entitlements"] = ents
                return  # sticky: a re-seen completed order does not un-refund it
            if tt_id:
                e["ticket_type_id"] = tt_id
            e["is_upgrade"] = bool(is_upgrade)
            if addon_code:
                e["addon_code"] = addon_code
            if day is not None:
                e["day"] = day
            if day_date is not None:
                e["day_date"] = day_date
            if tx:
                e["transaction_id"] = tx
            # Backfill on replay: rows written before these were captured are the
            # reason the 2026 numbers could not be classified without guessing.
            if product_id and not e.get("product_id"):
                e["product_id"] = product_id
            if quantity is not None and e.get("quantity") is None:
                e["quantity"] = int(quantity)
            # A date alone cannot separate a double charge minutes apart from a
            # second seat bought the same afternoon, so a more precise timestamp
            # replaces a date-only one.
            if purchased_at and len(str(purchased_at)) > len(str(e.get("purchased_at") or "")):
                e["purchased_at"] = purchased_at
            cd["entitlements"] = ents
            return
    # Ownership is intrinsic to the entitlement, never inferred later from which
    # attendee row happens to hold it. A ledger entry that could not say which
    # Gaia event it belonged to is exactly how 2025 transactions ended up inside
    # the 2026 event.
    entry = {"order_id": order_id, "transaction_id": tx, "ticket_type_id": tt_id,
             "event_id": event_id,
             "is_upgrade": bool(is_upgrade), "status": "paid",
             "ts": datetime.utcnow().isoformat()}
    if invoice_id:
        entry["invoice_id"] = invoice_id
    if source:
        entry["source"] = source
    if amount is not None:
        entry["amount"] = amount
    if addon_code:
        entry["addon_code"] = addon_code
    if product_id:
        # The immutable product id, so a later rename cannot orphan this record.
        entry["product_id"] = product_id
    if quantity is not None:
        entry["quantity"] = int(quantity)
    if purchased_at:
        # When GHL took the money -- NOT when Gaia reconciled it. Using the
        # reconcile time made every historical import look like one instant.
        entry["purchased_at"] = purchased_at
    if day is not None:
        entry["day"] = day
    if day_date is not None:
        entry["day_date"] = day_date
    ents.append(entry)
    cd["entitlements"] = ents


def _ent_effective(db, cd):
    """(effective_tier_id or None, has_paid_base) computed from paid entitlements.
    Effective tier is the highest rank among all paid entitlements; access is only
    valid when at least one paid BASE (non-upgrade) entitlement remains."""
    paid = [e for e in (cd.get("entitlements") or [])
            if e.get("status") == "paid" and e.get("ticket_type_id")]
    if not paid:
        return (None, False)
    best = max(paid, key=lambda e: _tt_rank(db, e.get("ticket_type_id")))
    has_base = any((not e.get("is_upgrade")) for e in paid)
    return (best.get("ticket_type_id"), has_base)


# --- Additive effective-access: ONE source of truth for admin, scanner and app ---
ADDON_LABELS = {"ONE_DAY_CONFERENCE": "One-Day Speaker Access"}

def _addon_label(code):
    if not code:
        return code
    return ADDON_LABELS.get(code) or code.replace("_", " ").title()

def _effective_access(db, attendee):
    """Resolve an attendee into a human-readable access picture: a base ticket PLUS
    additive add-ons (each with an optional day). Everyone — roster, detail view,
    scanner, member app — renders THIS, so they never disagree."""
    cd = attendee.custom_data or {}
    ents = list(cd.get("entitlements") or [])
    paid = [e for e in ents if e.get("status") == "paid"]
    # base tier = highest-rank paid entitlement that is NOT an add-on
    base_ents = [e for e in paid if not e.get("addon_code") and e.get("ticket_type_id")]
    base_tt = None
    if base_ents:
        base_tt = max(base_ents, key=lambda e: _tt_rank(db, e.get("ticket_type_id"))).get("ticket_type_id")
    if cd.get("admin_tier"):
        base_tt = cd.get("admin_tier")
    if base_tt is None:
        base_tt = attendee.ticket_type_id
    base = db.query(models.TicketType).filter(models.TicketType.id == base_tt).first() if base_tt else None
    # add-ons (dedup by code, keep the first paid one)
    addons = []
    seen = set()
    for e in paid:
        code = e.get("addon_code")
        if not code or code in seen:
            continue
        seen.add(code)
        addons.append({"code": code, "label": _addon_label(code), "day": e.get("day"),
                       "day_date": e.get("day_date"),
                       "status": "paid", "order_id": e.get("order_id")})
    active = _ticket_active(attendee)
    parts = []
    if base:
        parts.append(base.name or base.code)
    for a in addons:
        parts.append("%s (%s)" % (a["label"], a["day"] or "day not selected"))
    eff = " + ".join(parts) if parts else "No active ticket"
    if not active:
        eff = "%s \u2014 %s" % (eff, _ticket_status(attendee).upper())
    # human-readable entitlement history (the "why")
    hist = []
    for e in ents:
        if e.get("addon_code"):
            lbl = _addon_label(e.get("addon_code")); kind = "add-on"
        else:
            tt = db.query(models.TicketType).filter(models.TicketType.id == e.get("ticket_type_id")).first()
            lbl = (tt.name if tt else "Ticket"); kind = ("upgrade" if e.get("is_upgrade") else "base ticket")
        hist.append({"label": lbl, "kind": kind, "status": e.get("status") or "paid",
                     "order_id": e.get("order_id"), "day": e.get("day"), "ts": e.get("ts")})
    return {
        "base_ticket": ({"id": base.id, "code": base.code, "name": base.name} if base else None),
        "status": _ticket_status(attendee),
        "active": active,
        "addons": addons,
        "effective_label": eff,
        "entitlement_history": hist,
    }


def _event_local_today(event, at=None):
    """The event's current calendar date (event timezone), or an explicit ISO test
    override. Day rules are judged here, never in UTC or the browser's zone."""
    if at:
        return str(at)[:10]
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(event.timezone or "UTC")).date().isoformat()
    except Exception:
        return datetime.utcnow().date().isoformat()


def _conference_grant(tt, addons, today):
    """Decide conference/speaker access. A conference-granting base tier is always
    in; otherwise a ONE_DAY_CONFERENCE add-on grants it only on its selected day."""
    if tt is not None and getattr(tt, "grants_conference", False):
        return {"allowed": True, "reason": (tt.name or "Pass") + " includes conference access"}
    addon = next((a for a in (addons or []) if a.get("code") == "ONE_DAY_CONFERENCE"), None)
    if addon:
        dd = addon.get("day_date")
        if not dd:
            return {"allowed": False, "reason": "One-Day Speaker Access purchased \u2014 day not selected"}
        if str(dd)[:10] == today:
            return {"allowed": True, "reason": "One-Day Speaker Access \u2014 " + (addon.get("day") or dd)}
        return {"allowed": False, "reason": "Conference access valid " + (addon.get("day") or dd) + " only"}
    return {"allowed": False, "reason": "Pass does not include conference access"}


def _authorize_decision(db, attendee, event, access_type, at=None):
    """The backend authorization decision. Reads the ONE effective-access resolver,
    then answers a specific access zone with GRANTED / LIMITED / DENIED + reason."""
    eff = _effective_access(db, attendee)
    name = ("%s %s" % (attendee.first_name or "", attendee.last_name or "")).strip() or attendee.email
    base = eff.get("base_ticket")
    addons = eff.get("addons") or []
    tt = db.query(models.TicketType).filter(models.TicketType.id == base["id"]).first() if base else None
    today = _event_local_today(event, at)
    az = (access_type or "EVENT_ENTRY").upper()
    out = {"name": name, "qr_code": attendee.qr_code, "attendee_id": attendee.id,
           "access_type": az, "event_local_date": today,
           "effective_label": eff.get("effective_label"), "base_ticket": base,
           "addons": addons, "status": eff.get("status"),
           "checked_in": bool(attendee.is_checked_in),
           "checked_in_at": attendee.checked_in_at}
    # Lifecycle gate first — refunded/revoked/cancelled is never valid anywhere.
    if not eff.get("active"):
        st = (eff.get("status") or "invalid").upper()
        out.update({"result": "DENIED", "granted": False, "reason": "Ticket " + st + " \u2014 not valid for entry"})
        return out
    # A ticket is not valid outside its event's venue-local calendar window.
    # This is deliberately checked by the backend for every zone; the scanner
    # cannot override it with its own clock or payload.
    start_day = event.start_date.date().isoformat() if event.start_date else None
    end_day = event.end_date.date().isoformat() if event.end_date else start_day
    if start_day and today < start_day:
        out.update({"result": "DENIED", "granted": False,
                    "reason": "Event access is not open yet"})
        return out
    if end_day and today > end_day:
        out.update({"result": "DENIED", "granted": False,
                    "reason": "Event access has ended"})
        return out
    # Secure default anti-passback. Organisers can explicitly allow re-entry in
    # event.custom_fields; otherwise the same badge cannot admit a second body.
    allow_reentry_raw = (event.custom_fields or {}).get("allow_reentry")
    allow_reentry = allow_reentry_raw is True or str(allow_reentry_raw).lower() in {"1", "true", "yes"}
    if az == "EVENT_ENTRY" and attendee.is_checked_in and not allow_reentry:
        out.update({"result": "LIMITED", "granted": False,
                    "reason": "Badge already checked in; re-entry is not enabled"})
        return out
    has_base = base is not None
    conf = _conference_grant(tt, addons, today)
    zones = {
        "exhibit": has_base,
        "conference": conf,
        "workshop": bool(tt and getattr(tt, "grants_workshops", False)),
        "vip": bool(tt and getattr(tt, "is_vip", False)),
    }
    out["zones"] = zones
    # A single-day pass admits on its own day and no other. Every existing tier
    # has valid_day NULL and is unaffected.
    day_only = getattr(tt, "valid_day", None) if tt is not None else None
    if az in ("EVENT_ENTRY", "EXHIBIT") and day_only and str(day_only)[:10] != today:
        out.update({"result": "DENIED", "granted": False,
                    "reason": "%s is valid on %s only" % (base["name"] if base else "This pass", str(day_only)[:10])})
        return out
    if az in ("EVENT_ENTRY", "EXHIBIT"):
        if has_base:
            out.update({"result": "GRANTED", "granted": True,
                        "reason": (base["name"] + (" \u2014 admitted" if not day_only else " \u2014 admitted for %s" % str(day_only)[:10]))})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "Add-on found, but no valid base event admission"})
    elif az in ("CONFERENCE", "SPEAKER"):
        if conf["allowed"]:
            out.update({"result": "GRANTED", "granted": True, "reason": conf["reason"]})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " valid; " + conf["reason"])})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    elif az == "WORKSHOP":
        if zones["workshop"]:
            out.update({"result": "GRANTED", "granted": True, "reason": "Workshop access"})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " does not include workshops")})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    elif az == "VIP":
        if zones["vip"]:
            out.update({"result": "GRANTED", "granted": True, "reason": "VIP access"})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " is not a VIP pass")})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    else:
        out.update({"result": "DENIED", "granted": False, "reason": "Unknown access zone"})
    return out


# Check-in endpoints
@app.post("/events/{event_id}/checkin", response_model=schemas.CheckInResponse)
def check_in_for_event(
    event_id: int,
    request: schemas.CheckInRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Scan a badge at a specific event's door.

    A scanner standing at one event must never admit an attendee of another, so
    the badge is matched within this event only — a valid badge from elsewhere
    reads as not found here.
    """
    _get_event_or_404(event_id, db)
    attendee, _parsed = _attendee_from_scan(db, request.qr_code, event_id)
    authz.require_cap(db, current_user, event_id, "checkin.perform")
    if not attendee:
        db.add(models.ScanLog(event_id=event_id, attendee_id=None, qr_code=(request.qr_code or "")[:120],
                              access_type="EVENT_ENTRY", result="DENIED",
                              reason="Badge not valid for this event", staff_user_id=current_user.id))
        db.commit()
        return schemas.CheckInResponse(success=False, message="This badge is not valid for this event")
    decision = _authorize_decision(db, attendee, _get_event_or_404(event_id, db), "EVENT_ENTRY")
    if decision.get("granted"):
        attendee.is_checked_in = True
        attendee.checked_in_at = datetime.utcnow()
    db.add(models.ScanLog(event_id=event_id, attendee_id=attendee.id, qr_code=attendee.qr_code,
                          access_type="EVENT_ENTRY", result=decision.get("result"),
                          reason=decision.get("reason"), staff_user_id=current_user.id))
    db.commit()
    db.refresh(attendee)
    return schemas.CheckInResponse(success=bool(decision.get("granted")), attendee=attendee,
                                   message=decision.get("reason") or "Check-in decision unavailable")


@app.post("/checkin", response_model=schemas.CheckInResponse)
def check_in(
    check_in: schemas.CheckInRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    attendee, _parsed = _attendee_from_scan(db, check_in.qr_code, None)

    if not attendee:
        return schemas.CheckInResponse(success=False, message="Invalid QR code", attendee=None)
    authz.require_cap(db, current_user, attendee.event_id, "checkin.perform")
    event = _get_event_or_404(attendee.event_id, db)
    decision = _authorize_decision(db, attendee, event, "EVENT_ENTRY")
    if decision.get("granted"):
        attendee.is_checked_in = True
        attendee.checked_in_at = datetime.utcnow()
    db.add(models.ScanLog(event_id=attendee.event_id, attendee_id=attendee.id, qr_code=attendee.qr_code,
                          access_type="EVENT_ENTRY", result=decision.get("result"),
                          reason=decision.get("reason"), staff_user_id=current_user.id))
    db.commit()
    db.refresh(attendee)
    return schemas.CheckInResponse(
        success=bool(decision.get("granted")),
        message=decision.get("reason") or "Check-in decision unavailable",
        attendee=attendee
    )

@app.get("/attendees/{attendee_id}/qr")
def get_attendee_qr(
    attendee_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.read")
    
    qr_base64 = generate_qr_code(attendee.qr_code)
    return {"qr_code": attendee.qr_code, "qr_image": qr_base64}

# Exhibitor endpoints
@app.get("/events/{event_id}/exhibitors", response_model=List[schemas.Exhibitor])
def get_exhibitors(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_cap(db, current_user, event_id, "exhibitor.read")
    exhibitors = db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event_id
    ).all()
    
    for exhibitor in exhibitors:
        exhibitor.lead_count = db.query(models.Lead).filter(
            models.Lead.exhibitor_id == exhibitor.id
        ).count()
    
    return exhibitors

@app.post("/exhibitors", response_model=schemas.Exhibitor)
def create_exhibitor(
    exhibitor: schemas.ExhibitorCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    authz.require_cap(db, current_user, exhibitor.event_id, "exhibitor.write")
    access_token = f"EXH-{uuid.uuid4().hex[:16].upper()}"
    
    db_exhibitor = models.Exhibitor(
        **exhibitor.dict(),
        access_token=access_token
    )
    db.add(db_exhibitor)
    db.commit()
    db.refresh(db_exhibitor)
    return db_exhibitor

@app.delete("/exhibitors/{exhibitor_id}")
def delete_exhibitor(
    exhibitor_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Remove a vendor. Their captured leads go with them, so the caller is
    expected to have confirmed."""
    exhibitor = db.query(models.Exhibitor).filter(models.Exhibitor.id == exhibitor_id).first()
    if not exhibitor:
        raise HTTPException(status_code=404, detail="Exhibitor not found")
    authz.require_cap(db, current_user, exhibitor.event_id, "exhibitor.write")
    db.query(models.Lead).filter(models.Lead.exhibitor_id == exhibitor_id).delete(synchronize_session=False)
    db.delete(exhibitor)
    db.commit()
    return {"message": "Exhibitor deleted"}


@app.get("/exhibitors/{exhibitor_id}", response_model=schemas.Exhibitor)
def get_exhibitor(
    exhibitor_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    exhibitor = db.query(models.Exhibitor).filter(models.Exhibitor.id == exhibitor_id).first()
    if not exhibitor:
        raise HTTPException(status_code=404, detail="Exhibitor not found")
    authz.require_cap(db, current_user, exhibitor.event_id, "exhibitor.read")
    
    exhibitor.lead_count = db.query(models.Lead).filter(
        models.Lead.exhibitor_id == exhibitor.id
    ).count()
    # The scanning token is a credential. Only someone who may grant scanning
    # should ever read it back; everyone else gets the profile without it.
    if not authz.can(db, current_user, exhibitor.event_id, "exhibitor.grant_scanning"):
        exhibitor.access_token = None
        db.expunge(exhibitor)
    
    return exhibitor

# Lead retrieval endpoints
@app.post("/scan", response_model=schemas.QRScanResponse)
def scan_qr_code(
    scan: schemas.QRScanRequest,
    db: Session = Depends(get_db)
):
    """An exhibitor scans an attendee's badge.

    Token-authenticated rather than logged in, because a stand runs this on a
    phone all day. Two things changed here from the original: a token only works
    when the organiser has actually granted scanning, and the response carries a
    consent-filtered view of the attendee instead of the whole record.
    """
    exhibitor = authz.exhibitor_for_token(db, scan.access_token)

    if not exhibitor:
        # Deliberately the same answer for "no such token" and "this stand is
        # not permitted to scan": a probe learns nothing either way.
        return schemas.QRScanResponse(success=False, message="Invalid access token", attendee=None)
    
    attendee, _parsed = _attendee_from_scan(db, scan.qr_code, exhibitor.event_id)

    if not attendee:
        return schemas.QRScanResponse(success=False, message="Invalid QR code", attendee=None)

    if attendee.event_id != exhibitor.event_id:
        return schemas.QRScanResponse(
            success=False,
            message="This attendee is registered for a different event",
            attendee=None
        )
    if not _ticket_active(attendee):
        return schemas.QRScanResponse(
            success=False,
            message=_blocked_reason(attendee) or "This ticket is not valid",
            attendee=None,
        )
    
    # Check if already scanned
    existing_lead = db.query(models.Lead).filter(
        models.Lead.exhibitor_id == exhibitor.id,
        models.Lead.attendee_id == attendee.id
    ).first()
    
    if existing_lead:
        return schemas.QRScanResponse(
            success=True,
            message="Lead already captured",
            attendee=authz.lead_view(attendee),
            lead_id=existing_lead.id
        )

    lead = models.Lead(
        exhibitor_id=exhibitor.id,
        attendee_id=attendee.id,
        consent_snapshot=authz.consent_snapshot(attendee),
    )
    db.add(lead)
    db.commit()

    return schemas.QRScanResponse(
        success=True,
        message=f"Lead captured for {attendee.first_name} {attendee.last_name}",
        attendee=authz.lead_view(attendee),
        lead_id=lead.id
    )

@app.get("/scan/leads/{access_token}", response_model=List[schemas.LeadPublic])
def get_public_exhibitor_leads(
    access_token: str,
    db: Session = Depends(get_db)
):
    """Return leads for the exhibitor scanner page without requiring admin login.

    Consent-filtered: email/phone appear only where the attendee agreed (see
    authz.lead_public_view). Returning the ORM Lead here would expose the full
    attendee record to any scanner-token holder."""
    exhibitor = authz.exhibitor_for_token(db, access_token)

    if not exhibitor:
        raise HTTPException(status_code=404, detail="Invalid access token")

    leads = db.query(models.Lead).filter(
        models.Lead.exhibitor_id == exhibitor.id
    ).order_by(models.Lead.scanned_at.desc()).limit(50).all()
    return [
        {
            "id": lead.id, "exhibitor_id": lead.exhibitor_id,
            "attendee_id": lead.attendee_id, "scanned_at": lead.scanned_at,
            "notes": lead.notes, "rating": lead.rating,
            "attendee": authz.lead_public_view(lead),
        }
        for lead in leads
    ]

@app.put("/scan/leads/{lead_id}", response_model=schemas.LeadPublic)
def update_public_lead(
    lead_id: int,
    lead_update: schemas.LeadPublicUpdate,
    db: Session = Depends(get_db)
):
    """Allow an exhibitor scanner link to save notes for only its own leads."""
    exhibitor = authz.exhibitor_for_token(db, lead_update.access_token)

    if not exhibitor:
        raise HTTPException(status_code=404, detail="Invalid access token")

    lead = db.query(models.Lead).filter(
        models.Lead.id == lead_id,
        models.Lead.exhibitor_id == exhibitor.id
    ).first()

    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if lead_update.rating is not None and not 1 <= lead_update.rating <= 5:
        raise HTTPException(status_code=400, detail="Rating must be between 1 and 5")

    lead.notes = lead_update.notes
    lead.rating = lead_update.rating
    db.commit()
    db.refresh(lead)
    return {
        "id": lead.id, "exhibitor_id": lead.exhibitor_id,
        "attendee_id": lead.attendee_id, "scanned_at": lead.scanned_at,
        "notes": lead.notes, "rating": lead.rating,
        "attendee": authz.lead_public_view(lead),
    }

@app.post("/leads/{lead_id}/notes")
def update_lead_notes(
    lead_id: int,
    notes: str,
    rating: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    lead = db.query(models.Lead).filter(models.Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    exhibitor = db.query(models.Exhibitor).filter(models.Exhibitor.id == lead.exhibitor_id).first()
    authz.require_cap(db, current_user, exhibitor.event_id if exhibitor else None, "exhibitor.write")
    
    lead.notes = notes
    if rating is not None:
        lead.rating = rating
    
    db.commit()
    return {"message": "Lead updated"}

@app.get("/exhibitors/{exhibitor_id}/leads", response_model=List[schemas.Lead])
def get_exhibitor_leads(
    exhibitor_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    _exh = db.query(models.Exhibitor).filter(models.Exhibitor.id == exhibitor_id).first()
    if not _exh:
        raise HTTPException(status_code=404, detail="Exhibitor not found")
    authz.require_cap(db, current_user, _exh.event_id, "lead.read")
    leads = db.query(models.Lead).filter(
        models.Lead.exhibitor_id == exhibitor_id
    ).order_by(models.Lead.scanned_at.desc()).all()
    return leads

# Badge generation
@app.get("/attendees/{attendee_id}/badge")
def generate_badge(
    attendee_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.read")
    
    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first()
    
    # Create PDF in memory
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)
    
    # Badge design
    width, height = letter
    
    # Event name at top
    c.setFont("Helvetica-Bold", 20)
    c.drawCentredString(width/2, height - 1.5*inch, event.name if event else "Event")
    
    # Attendee name
    c.setFont("Helvetica-Bold", 28)
    name = f"{attendee.first_name} {attendee.last_name}"
    c.drawCentredString(width/2, height/2 + 0.5*inch, name)
    
    # Company and title
    c.setFont("Helvetica", 16)
    if attendee.company:
        c.drawCentredString(width/2, height/2, attendee.company)
    if attendee.job_title:
        c.drawCentredString(width/2, height/2 - 0.3*inch, attendee.job_title)
    
    # QR Code
    qr_data = generate_qr_code(attendee.qr_code)
    # Extract base64 data and add to PDF
    qr_bytes = base64.b64decode(qr_data.split(',')[1])
    qr_buffer = io.BytesIO(qr_bytes)
    c.drawImage(ImageReader(qr_buffer), width/2 - 1*inch, 1*inch, width=2*inch, height=2*inch)
    
    c.save()
    
    buffer.seek(0)
    pdf_base64 = base64.b64encode(buffer.getvalue()).decode()
    
    return {
        "badge_pdf": f"data:application/pdf;base64,{pdf_base64}",
        "filename": f"badge_{attendee.qr_code}.pdf"
    }

# Dashboard stats
@app.get("/entitlement-review")
def entitlement_review(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Platform-wide product classification + payments needing entitlement review.
    Reads the proxy-owned registry/review files (same host). No buyer PII."""
    import json as _json
    def _load(pth):
        try:
            with open(pth) as f: return _json.load(f)
        except Exception: return {}
    _reg_full=_load("/root/gaia-staging-proxy/data/product-registry.json")
    reg=_reg_full.get("products") or {}
    import os as _os
    try: _reg_mtime=datetime.utcfromtimestamp(_os.path.getmtime("/root/gaia-staging-proxy/data/product-registry.json")).strftime("%b %d, %Y")
    except Exception: _reg_mtime=None
    registry_as_of={"label": _reg_full.get("generated_from"), "as_of": _reg_mtime}
    # Live event attendance (the real number of people, from THIS app's DB) so the
    # snapshot per-product ticket counts are never mistaken for attendance.
    events_live=[]
    try:
        for e in db.query(models.Event).all():
            total=db.query(models.Attendee).filter(models.Attendee.event_id==e.id).count()
            try: checked=db.query(models.Attendee).filter(models.Attendee.event_id==e.id, models.Attendee.is_checked_in==True).count()
            except Exception: checked=None
            events_live.append({"event_id":e.id, "name":e.name, "attendees":total, "checked_in":checked})
        events_live.sort(key=lambda x:-(x["attendees"] or 0))
    except Exception: pass
    rev=_load("/root/gaia-staging-proxy/data/payment-review.json").get("items") or {}
    # Rejected/unknown course grants the hardened access-granted path refused to
    # mint (a workflow supplied a courseId/courseName resolving to no known
    # course), plus revokes that matched no held course. Newest first.
    crej=_load("/root/gaia-staging-proxy/data/course-grant-rejections.json").get("items") or []
    from collections import Counter
    summary=Counter(v.get("classification") for v in reg.values())
    review_summary=Counter(v.get("review_bucket") for v in reg.values() if v.get("classification")=="REVIEW_REQUIRED")
    products=[{"product_id":pid, "name":v.get("name"), "classification":v.get("classification"),
               "review_bucket":v.get("review_bucket"), "orders":v.get("orders"), "note":v.get("note")}
              for pid,v in reg.items()]
    products.sort(key=lambda x:-(x.get("orders") or 0))
    course_rejections=[{"at":r.get("at"), "action":r.get("action"), "event":r.get("event"),
                        "id":r.get("id"), "name":r.get("name"), "reason":r.get("reason"),
                        "contact":r.get("contactId")} for r in crej][-100:][::-1]
    rejection_reasons=dict(Counter(r.get("reason") for r in crej))
    # ---- Course authority (GHL is the authority; the ledger never is) ----
    import re as _re
    def _gkey(title):
        t=(title or "").lower().strip()
        t=_re.sub(r"\(.*?(payment|installment|pay |month|st|nd|rd|th|recording|vip|zoom|in-person|virtual|online|recording|swag|free).*?\)"," ",t)
        t=_re.sub(r"\b(payment|installment|1st|2nd|3rd|4th|st payment|nd payment|over \d+ months|recording|vip package|swag bag|second person|group)\b"," ",t)
        t=_re.sub(r"^(events?\s*-\s*|learning\s*-\s*|in-person\s*-\s*|virtual\s*-\s*|online\s*-\s*)"," ",t)
        t=_re.sub(r"(bio-well\s*\d\.\d.*?\+|device.*?\+)"," ",t)
        t=_re.sub(r"[^a-z0-9 ]"," ",t); t=_re.sub(r"\s+"," ",t).strip(); return t
    auth=_load("/root/gaia-staging-proxy/data/course-authority.json")
    acourses=auth.get("courses") or []
    aliases=(_load("/root/gaia-staging-proxy/data/course-authority-aliases.json").get("aliases")) or []
    auth_keys=set(c.get("groupKey") or _gkey(c.get("title")) for c in acourses)
    auth_ids={str(c.get("id","")).lower() for c in acourses if c.get("id")}
    alias_keys=set(a.get("alias_key") for a in aliases if a.get("approved") is not False)
    grantable=auth_keys|alias_keys
    ambiguous_keys=set((auth.get("ambiguous_keys") or {}).keys())
    course_authority={"count":len(acourses),
                      "visible":sum(1 for c in acourses if c.get("visible")),
                      "hidden":sum(1 for c in acourses if not c.get("visible")),
                      "ambiguous_keys":len(ambiguous_keys),
                      "approved_aliases":len(alias_keys),
                      "source":auth.get("source"),
                      "seeded_pending_full_sync":auth.get("seeded_pending_full_sync"),
                      "generated_at":auth.get("generatedAt")}
    # ---- legacy audit + resolution methods from the ledger (read-only) ----
    led=_load("/root/gaia-staging-proxy/data/member-entitlements.json").get("contacts") or {}
    distinct={}; methods=Counter()
    for rec in led.values():
        for c in (rec.get("courses") or []):
            k=_gkey(c.get("name") or c.get("id") or "")
            if k and k not in distinct: distinct[k]=c.get("name") or c.get("id")
            m=c.get("resolutionMethod")
            if m: methods[m]+=1
    legacy=[]; matched=0; ambiguous_ct=0
    for k,name in distinct.items():
        if k in ambiguous_keys: ambiguous_ct+=1
        elif k in grantable: matched+=1
        else: legacy.append(name)
    legacy_audit={"distinct_ledger_courses":len(distinct),"authoritatively_matched":matched,
                  "legacy_unverified":len(legacy),"ambiguous":ambiguous_ct,
                  "legacy_courses":sorted(legacy)}
    # ---- Data-clarity flags: products whose NAME suggests a different type than
    # they are filed under, so the owner can SEE the discrepancy and decide.
    # This never changes a classification; it only surfaces the truth for review.
    import re as _re2
    def _suggests(name):
        n=(name or "").lower()
        if _re2.search(r"\b(certif|certification|training|course|masterclass|workshop|learning|academy)\b", n) and not _re2.search(r"\b(device|kit|camera|sensor|glove|hardware)\b", n):
            return "COURSE"
        if _re2.search(r"\b(member|membership|subscription)\b", n):
            return "MEMBERSHIP_SUBSCRIPTION"
        if _re2.search(r"\b(ticket|admission|conference|summit|exhibit|vip pass)\b", n):
            return "EVENT_TICKET"
        return None
    classification_flags=[]
    for pid,v in reg.items():
        cls=v.get("classification"); nm=v.get("name"); sug=_suggests(nm)
        if sug and sug!=cls and cls!="REVIEW_REQUIRED":
            classification_flags.append({"product_id":pid,"name":nm,"classified_as":cls,
                                         "name_suggests":sug,"orders":v.get("orders") or 0})
    classification_flags.sort(key=lambda x:-(x["orders"] or 0))
    return {"summary":dict(summary), "review_summary":dict(review_summary),
            "registry_as_of":registry_as_of, "events_live":events_live,
            "products":products, "recent_unclassified_payments":list(rev.values()),
            "classification_flags":classification_flags,
            "course_rejections":course_rejections, "course_rejection_count":len(crej),
            "course_rejection_reasons":rejection_reasons,
            "course_authority":course_authority, "course_legacy_audit":legacy_audit,
            "course_resolution_methods":dict(methods)}


@app.get("/dashboard/stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    if not getattr(current_user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin only")
    total_events = db.query(models.Event).count()
    active_events = db.query(models.Event).filter(models.Event.is_active == True).count()
    # Global totals count only attendees that still belong to a live event.
    # Without this an orphaned row (event deleted, event_id left NULL) inflated
    # the attendee count and produced a check-in rate for an event that had no
    # check-ins at all.
    # Headline totals describe the OPERATIONAL events only. An archived event is
    # a historical record: it stays fully visible in its own card and detail
    # page, but it must not inflate the live attendee count or dilute the
    # check-in rate of the conference actually being run.
    _live_event_ids = db.query(models.Event.id).filter(
        (models.Event.is_archived == False) | (models.Event.is_archived.is_(None))  # noqa: E712
    )
    total_attendees = db.query(models.Attendee).filter(
        models.Attendee.event_id.in_(_live_event_ids)
    ).count()
    total_checked_in = db.query(models.Attendee).filter(
        models.Attendee.event_id.in_(_live_event_ids),
        models.Attendee.is_checked_in == True
    ).count()
    total_exhibitors = db.query(models.Exhibitor).count()
    total_leads = db.query(models.Lead).count()
    all_attendees = db.query(models.Attendee).all()
    paid_members = sum(1 for attendee in all_attendees if (attendee.custom_data or {}).get("paid_member") is True)
    recent_attendees = db.query(models.Attendee).order_by(
        models.Attendee.created_at.desc()
    ).limit(8).all()
    events = db.query(models.Event).order_by(models.Event.start_date.asc()).all()
    now = datetime.utcnow()
    upcoming_events = 0
    live_events = 0
    past_events = 0
    next_event = None
    event_rows = []
    for event in events:
        if event.end_date and event.end_date < now:
            event_status = "past"
            past_events += 1
        elif event.start_date and event.start_date <= now <= event.end_date:
            event_status = "live"
            live_events += 1
        else:
            event_status = "upcoming"
            upcoming_events += 1
            if next_event is None or event.start_date < next_event.start_date:
                next_event = event

        attendee_count = db.query(models.Attendee).filter(models.Attendee.event_id == event.id).count()
        checked_in_count = db.query(models.Attendee).filter(
            models.Attendee.event_id == event.id,
            models.Attendee.is_checked_in == True
        ).count()
        exhibitor_count = db.query(models.Exhibitor).filter(models.Exhibitor.event_id == event.id).count()
        lead_count = db.query(models.Lead).join(models.Exhibitor).filter(
            models.Exhibitor.event_id == event.id
        ).count()
        event_rows.append({
            "id": event.id,
            "name": event.name,
            "start_date": event.start_date,
            "end_date": event.end_date,
            "location": event.location,
            "is_active": event.is_active,
            "status": event_status,
            "days_until": (event.start_date.date() - now.date()).days if event.start_date else None,
            "attendee_count": attendee_count,
            "checked_in_count": checked_in_count,
            "check_in_rate": round(checked_in_count / attendee_count * 100, 2) if attendee_count > 0 else 0,
            "exhibitor_count": exhibitor_count,
            "lead_count": lead_count,
        })
    
    return {
        "total_events": total_events,
        "active_events": active_events,
        "upcoming_events": upcoming_events,
        "live_events": live_events,
        "past_events": past_events,
        "total_attendees": total_attendees,
        "total_checked_in": total_checked_in,
        "check_in_rate": round(total_checked_in / total_attendees * 100, 2) if total_attendees > 0 else 0,
        "total_exhibitors": total_exhibitors,
        "total_leads": total_leads,
        "paid_members": paid_members,
        # Attendees who have not yet been through the door. Previously this
        # was set to total_attendees unconditionally, which reported a fully
        # checked-in event as entirely unbadged.
        "unbadged_attendees": total_attendees - total_checked_in,
        "source_count": len(EVENT_AUTO_SYNC_URLS),
        "source_urls": EVENT_AUTO_SYNC_URLS,
        "auto_sync_interval_hours": round(EVENT_AUTO_SYNC_INTERVAL_SECONDS / 3600, 1),
        "next_event": {
            "id": next_event.id,
            "name": next_event.name,
            "start_date": next_event.start_date,
            "location": next_event.location,
            "days_until": (next_event.start_date.date() - now.date()).days if next_event and next_event.start_date else None,
        } if next_event else None,
        "events": event_rows,
        "recent_attendees": [
            {
                "id": attendee.id,
                "name": f"{attendee.first_name} {attendee.last_name}".strip(),
                "email": attendee.email,
                "company": attendee.company,
                "pass_type": (attendee.custom_data or {}).get("pass_type") or (attendee.custom_data or {}).get("Pass Type"),
                "paid_member": bool((attendee.custom_data or {}).get("paid_member")),
                "created_at": attendee.created_at,
            }
            for attendee in recent_attendees
        ],
    }

# ---------------------------------------------------------------------------
# Agenda: speakers and sessions
#
# Nothing here is specific to one event. Every row hangs off event_id, so an
# event added next year gets the same agenda, speakers and directory for free.
# ---------------------------------------------------------------------------

def event_timezone(event: models.Event) -> ZoneInfo:
    try:
        return ZoneInfo(event.timezone or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def attach_event_times(event: models.Event) -> models.Event:
    """Resolve venue-local wall-clock times into unambiguous instants.

    start_date/end_date are stored naive and mean local time at the venue. A
    client cannot safely turn those into a countdown — it would have to guess an
    offset. So the server states the instant, DST-correct for that date, plus its
    own clock, and the client subtracts. The answer is then identical whether the
    reader is in Dubai or Orlando.
    """
    tz = event_timezone(event)
    event.start_at = event.start_date.replace(tzinfo=tz).isoformat() if event.start_date else None
    event.end_at = event.end_date.replace(tzinfo=tz).isoformat() if event.end_date else None
    event.server_time = datetime.now(tz).isoformat(timespec="seconds")
    return event


def attach_event_counts(event: models.Event, db: Session) -> models.Event:
    """Real counts for an event. Nothing here is estimated or hardcoded."""
    event.attendee_count = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id
    ).count()
    event.checked_in_count = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        models.Attendee.is_checked_in == True
    ).count()
    event.exhibitor_count = db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event.id
    ).count()
    event.lead_count = db.query(models.Lead).join(
        models.Exhibitor, models.Lead.exhibitor_id == models.Exhibitor.id
    ).filter(models.Exhibitor.event_id == event.id).count()
    event.session_count = db.query(models.Session).filter(
        models.Session.event_id == event.id
    ).count()
    event.speaker_count = db.query(models.Speaker).filter(
        models.Speaker.event_id == event.id
    ).count()
    return attach_event_times(event)


def _get_event_or_404(event_id: int, db: Session) -> models.Event:
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


def _apply_speakers(session_obj, speaker_ids, event_id: int, db: Session) -> None:
    """Attach speakers to a session, refusing any that belong to another event."""
    if speaker_ids is None:
        return
    if not speaker_ids:
        session_obj.speakers = []
        return
    wanted = list(dict.fromkeys(speaker_ids))
    speakers = db.query(models.Speaker).filter(
        models.Speaker.id.in_(wanted),
        models.Speaker.event_id == event_id,
    ).all()
    if len(speakers) != len(wanted):
        raise HTTPException(status_code=400, detail="One or more speaker_ids do not belong to this event")
    session_obj.speakers = speakers


@app.get("/events/{event_id}/speakers", response_model=List[schemas.Speaker])
def list_speakers(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.Speaker).filter(
        models.Speaker.event_id == event_id
    ).order_by(models.Speaker.sort_order.asc(), models.Speaker.name.asc()).all()


@app.post("/events/{event_id}/speakers", response_model=schemas.Speaker)
def create_speaker(
    event_id: int,
    speaker: schemas.SpeakerCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    db_speaker = models.Speaker(event_id=event_id, **speaker.dict())
    db.add(db_speaker)
    db.commit()
    db.refresh(db_speaker)
    return db_speaker


@app.put("/speakers/{speaker_id}", response_model=schemas.Speaker)
def update_speaker(
    speaker_id: int,
    changes: schemas.SpeakerUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    speaker = db.query(models.Speaker).filter(models.Speaker.id == speaker_id).first()
    if not speaker:
        raise HTTPException(status_code=404, detail="Speaker not found")
    authz.require_cap(db, current_user, speaker.event_id, "event.write")
    for field, value in changes.dict(exclude_unset=True).items():
        setattr(speaker, field, value)
    db.commit()
    db.refresh(speaker)
    return speaker


@app.delete("/speakers/{speaker_id}")
def delete_speaker(
    speaker_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    speaker = db.query(models.Speaker).filter(models.Speaker.id == speaker_id).first()
    if not speaker:
        raise HTTPException(status_code=404, detail="Speaker not found")
    authz.require_cap(db, current_user, speaker.event_id, "event.write")
    db.delete(speaker)
    db.commit()
    return {"message": "Speaker deleted"}


@app.get("/events/{event_id}/sessions", response_model=List[schemas.Session])
def list_sessions(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Admin view: every session, drafts included."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.Session).filter(
        models.Session.event_id == event_id
    ).order_by(
        models.Session.start_time.asc().nullslast(),
        models.Session.sort_order.asc(),
    ).all()


@app.post("/events/{event_id}/sessions", response_model=schemas.Session)
def create_session(
    event_id: int,
    session: schemas.SessionCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    payload = session.dict()
    speaker_ids = payload.pop("speaker_ids", []) or []
    if payload.get("start_time") and payload.get("end_time") and payload["end_time"] <= payload["start_time"]:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    # Re-importing the same source updates the slot instead of duplicating it.
    external_id = payload.get("external_id")
    existing = None
    if external_id:
        existing = db.query(models.Session).filter(
            models.Session.event_id == event_id,
            models.Session.external_id == external_id,
        ).first()

    if existing:
        for field, value in payload.items():
            setattr(existing, field, value)
        db_session = existing
    else:
        db_session = models.Session(event_id=event_id, **payload)
        db.add(db_session)

    _apply_speakers(db_session, speaker_ids, event_id, db)
    db.commit()
    db.refresh(db_session)
    return db_session


@app.put("/sessions/{session_id}", response_model=schemas.Session)
def update_session(
    session_id: int,
    changes: schemas.SessionUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not db_session:
        raise HTTPException(status_code=404, detail="Session not found")
    authz.require_cap(db, current_user, db_session.event_id, "event.write")

    payload = changes.dict(exclude_unset=True)
    speaker_ids = payload.pop("speaker_ids", None)
    start = payload.get("start_time", db_session.start_time)
    end = payload.get("end_time", db_session.end_time)
    if start and end and end <= start:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    for field, value in payload.items():
        setattr(db_session, field, value)
    _apply_speakers(db_session, speaker_ids, db_session.event_id, db)
    db.commit()
    db.refresh(db_session)
    return db_session


@app.delete("/sessions/{session_id}")
def delete_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not db_session:
        raise HTTPException(status_code=404, detail="Session not found")
    authz.require_cap(db, current_user, db_session.event_id, "event.write")
    db.delete(db_session)
    db.commit()
    return {"message": "Session deleted"}


@app.put("/exhibitors/{exhibitor_id}", response_model=schemas.Exhibitor)
def update_exhibitor(
    exhibitor_id: int,
    changes: schemas.ExhibitorUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    exhibitor = db.query(models.Exhibitor).filter(models.Exhibitor.id == exhibitor_id).first()
    if not exhibitor:
        raise HTTPException(status_code=404, detail="Exhibitor not found")
    authz.require_cap(db, current_user, exhibitor.event_id, "exhibitor.write")
    for field, value in changes.dict(exclude_unset=True).items():
        setattr(exhibitor, field, value)
    db.commit()
    db.refresh(exhibitor)
    exhibitor.lead_count = db.query(models.Lead).filter(
        models.Lead.exhibitor_id == exhibitor.id
    ).count()
    return exhibitor


# ---------------------------------------------------------------------------
# Public read surface — what the Gaia app renders. Published rows only.
# ---------------------------------------------------------------------------

def _published_event_or_404(event_id: int, db: Session) -> models.Event:
    event = db.query(models.Event).filter(
        models.Event.id == event_id,
        models.Event.is_active == True,
        models.Event.is_published == True,
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found or not published")
    return event


@app.get("/public/events", response_model=List[schemas.Event])
def list_public_events(
    include_past: bool = False,
    db: Session = Depends(get_db)
):
    """Every published event, soonest first — the app's event list.

    This is what replaces pinning the app to a single event id.
    """
    query = db.query(models.Event).filter(
        models.Event.is_active == True,
        models.Event.is_published == True,
    )
    if not include_past:
        query = query.filter(
            (models.Event.end_date == None) | (models.Event.end_date >= datetime.utcnow())
        )
    events = query.order_by(models.Event.start_date.asc()).all()
    for event in events:
        attach_event_counts(event, db)
    return events


@app.get("/public/events/{event_id}/agenda", response_model=schemas.Agenda)
def get_public_agenda(
    event_id: int,
    db: Session = Depends(get_db)
):
    """Published sessions grouped by venue-local day.

    Sessions with no start_time are omitted: they cannot be placed on a day, and
    an unscheduled slot is still being drafted.
    """
    event = _published_event_or_404(event_id, db)
    sessions = db.query(models.Session).filter(
        models.Session.event_id == event_id,
        models.Session.is_published == True,
        models.Session.start_time != None,
    ).order_by(models.Session.start_time.asc(), models.Session.sort_order.asc()).all()

    days: List[schemas.AgendaDay] = []
    by_date = {}
    for session in sessions:
        key = session.start_time.date()
        if key not in by_date:
            day = schemas.AgendaDay(
                date=key.isoformat(),
                label=f"{key:%A, %B} {key.day}",
                sessions=[],
            )
            by_date[key] = day
            days.append(day)
        row = schemas.SessionPublic.model_validate(session)
        if session.requires_registration:
            row.availability = workshops_lib.availability(session, db)
        by_date[key].sessions.append(row)

    # Published but untimed: surfaced separately rather than silently dropped.
    unscheduled = db.query(models.Session).filter(
        models.Session.event_id == event_id,
        models.Session.is_published == True,
        models.Session.start_time == None,
    ).order_by(models.Session.sort_order.asc(), models.Session.title.asc()).all()

    return schemas.Agenda(
        event_id=event.id,
        event_name=event.name,
        timezone=event.timezone or "UTC",
        days=days,
        unscheduled=[schemas.SessionPublic.model_validate(s) for s in unscheduled],
    )


@app.get("/public/events/{event_id}/speakers", response_model=List[schemas.SpeakerPublic])
def get_public_speakers(
    event_id: int,
    db: Session = Depends(get_db)
):
    _published_event_or_404(event_id, db)
    return db.query(models.Speaker).filter(
        models.Speaker.event_id == event_id,
        models.Speaker.is_published == True,
    ).order_by(models.Speaker.sort_order.asc(), models.Speaker.name.asc()).all()


@app.get("/public/events/{event_id}/exhibitors", response_model=List[schemas.ExhibitorPublic])
def get_public_exhibitors(
    event_id: int,
    db: Session = Depends(get_db)
):
    """The vendor directory. Organiser-only contact details are never included."""
    _published_event_or_404(event_id, db)
    return db.query(models.Exhibitor).filter(
        models.Exhibitor.event_id == event_id,
        models.Exhibitor.is_published == True,
    ).order_by(models.Exhibitor.sort_order.asc(), models.Exhibitor.company_name.asc()).all()


# ---------------------------------------------------------------------------
# Bulk actions, attendee search and CSV import
#
# All three are generic over entity type and scoped to one event: an operator
# working on event A can never move, publish or import into event B.
# ---------------------------------------------------------------------------

# Entity name -> (model, publish column exists, natural key used for idempotency)
BULK_MODELS = {
    "sessions": (models.Session, "title"),
    "speakers": (models.Speaker, "name"),
    "sponsors": (models.Sponsor, "name"),
    "exhibitors": (models.Exhibitor, "company_name"),
    "announcements": (models.Announcement, "title"),
}


def _bulk_model(entity: str):
    if entity not in BULK_MODELS:
        raise HTTPException(status_code=404, detail=f"Unknown entity '{entity}'")
    return BULK_MODELS[entity]


@app.post("/events/{event_id}/{entity}/bulk")
def bulk_update(
    event_id: int,
    entity: str,
    payload: schemas.BulkAction,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Publish, unpublish, feature or delete many rows at once.

    The event id is part of the query, not just the payload, so ids belonging to
    another event are silently out of scope rather than quietly acted upon.
    """
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    model, _ = _bulk_model(entity)
    query = db.query(model).filter(model.event_id == event_id)
    if payload.ids:
        query = query.filter(model.id.in_(payload.ids))
    rows = query.all()

    if payload.action == "delete":
        for row in rows:
            db.delete(row)
    elif payload.action in ("publish", "unpublish"):
        for row in rows:
            row.is_published = payload.action == "publish"
    elif payload.action in ("feature", "unfeature"):
        if not hasattr(model, "is_featured"):
            raise HTTPException(status_code=400, detail=f"{entity} cannot be featured")
        for row in rows:
            row.is_featured = payload.action == "feature"
    else:
        raise HTTPException(status_code=400, detail="Unknown action")

    db.commit()
    return {"ok": True, "entity": entity, "action": payload.action, "affected": len(rows)}


def _digits(v):
    return re.sub(r"\D", "", str(v or ""))


def _mask_email(v):
    v = str(v or "")
    if "@" not in v:
        return v
    a, b = v.split("@", 1)
    return (a[0] + "\u2022" * max(len(a) - 2, 1) + a[-1] if len(a) > 2 else a[0] + "\u2022") + "@" + b


def _walk_in_matches(db, event_id, email, phone, first, last):
    """Who might this already be? Searched across EVERY event and every
    permanent card, because the point is to avoid minting a second card for
    somebody who already has one.

    Returns candidates for a human to judge — never an automatic merge. Contact
    details are masked: a queue can see the screen.
    """
    email = (email or "").strip().lower()
    ph = _digits(phone)
    nm = re.sub(r"[^a-z ]+", "", ("%s %s" % (first or "", last or "")).lower()).strip()
    out = {}

    def add(a, why, strength):
        card = _find_member_card(db, token=a.public_token) if a.public_token else None
        key = a.public_token or ("a%d" % a.id)
        prev = out.get(key)
        if prev and prev["strength"] >= strength:
            return
        ev = db.query(models.Event).filter(models.Event.id == a.event_id).first()
        out[key] = {
            "strength": strength, "why": why,
            "name": ("%s %s" % (a.first_name or "", a.last_name or "")).strip(),
            "email_masked": _mask_email(a.email),
            "phone_masked": ("\u2022\u2022\u2022 " + ph_last) if (ph_last := _digits(a.phone)[-4:]) else "",
            "event_name": ev.name if ev else "",
            "this_event": a.event_id == event_id,
            "attendee_id": a.id,
            "token": a.public_token or "",
            "card_claimed": bool(card and (card.card_public or card.card_claimed_at)),
        }

    if email:
        for a in db.query(models.Attendee).filter(func.lower(models.Attendee.email) == email).all():
            add(a, "same email address", 3)
    if ph and len(ph) >= 7:
        for a in db.query(models.Attendee).filter(models.Attendee.phone.isnot(None)).all():
            if _digits(a.phone)[-9:] == ph[-9:]:
                add(a, "same phone number", 2)
    if nm:
        for a in db.query(models.Attendee).all():
            if badge_card.normalized_name(a) == nm:
                add(a, "same name", 1)
    rows = sorted(out.values(), key=lambda r: -r["strength"])
    return rows[:8]


@app.post("/events/{event_id}/walk-in/check")
def walk_in_check(event_id: int, payload: schemas.WalkInCreate,
                  db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    """Who is this, before anything is written? Staff see the candidates."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    matches = _walk_in_matches(db, event_id, payload.email, payload.phone,
                               payload.first_name, payload.last_name)
    return {"ok": True, "matches": matches,
            "already_here": [m for m in matches if m["this_event"]]}


@app.post("/events/{event_id}/walk-in")
def walk_in_create(event_id: int, payload: schemas.WalkInCreate,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Register someone at the door.

    Writes to GAIA ONLY — an attendee row, and their permanent card if they do
    not already have one. Nothing is created or changed in GHL: a door sale is
    recorded in the till it was taken on, and GHL stays the source of truth for
    what was sold online. The row is stamped `source: walk_in` so it is never
    mistaken for a reconciled order.

    The result is not a lesser record. The person leaves with the same badge
    token, card, check-in, printing and claim flow as somebody who bought
    online three months ago.
    """
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.write")
    _assert_event_writable(db, event, "register a walk-in for it")
    email = (payload.email or "").strip().lower()
    if not email or not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(status_code=400, detail="A valid email is required so they can claim their card")
    if not (payload.first_name or "").strip():
        raise HTTPException(status_code=400, detail="A first name is required")

    # Already on the list for THIS event: never create a second row.
    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event_id,
        func.lower(models.Attendee.email) == email).first()
    if existing:
        attach_member_identity(db, existing)
        db.commit(); db.refresh(existing)
        existing.effective_access = _effective_access(db, existing)
        _stamp_card_state(db, [existing])
        return {"ok": True, "created": False, "already_registered": True,
                "attendee": schemas.Attendee.from_orm(existing)}

    matches = _walk_in_matches(db, event_id, email, payload.phone,
                               payload.first_name, payload.last_name)
    if matches and not payload.confirm_new and not payload.link_token:
        # Stop and ask. Creating a second permanent card for someone who
        # already has one is the one mistake that cannot be undone quietly.
        return {"ok": False, "reason": "possible_duplicate", "matches": matches}

    custom = {"source": "walk_in", "registered_by": current_user.id,
              "registered_at": datetime.utcnow().isoformat(),
              "lifecycle": [{"ts": datetime.utcnow().isoformat(), "action": "walk_in_registered",
                             "actor": "staff:%d" % current_user.id}]}
    if payload.note:
        custom["note"] = str(payload.note)[:300]
    # Staff said "this is that person": carry their contact id so the new row
    # lands on the card they already own.
    if payload.link_token:
        tok = (payload.link_token or "").strip().upper()
        src = db.query(models.Attendee).filter(models.Attendee.public_token == tok).first()
        if not src:
            raise HTTPException(status_code=400, detail="That person could not be found")
        cid = (src.custom_data or {}).get("contact_id")
        if cid:
            custom["contact_id"] = cid

    at = (payload.attendance_type or "paid").strip().lower()
    if at not in ATTENDANCE_TYPES:
        raise HTTPException(status_code=400, detail="Unknown attendance type")
    dps = (payload.door_payment_status or "none").strip().lower()
    if dps not in DOOR_PAYMENT_STATUS:
        raise HTTPException(status_code=400, detail="Unknown door payment status")
    dpm = (payload.door_payment_method or "").strip().lower() or None
    if dpm and dpm not in DOOR_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Unknown door payment method")
    if dps == "collected" and (payload.door_payment_amount or 0) <= 0:
        raise HTTPException(status_code=400, detail="Record how much was taken at the door")
    if at != "paid" and dps == "collected":
        raise HTTPException(status_code=400, detail="A complimentary or staff badge cannot also be a door sale")

    attendee = models.Attendee(
        event_id=event_id, email=email,
        first_name=(payload.first_name or "").strip(),
        last_name=(payload.last_name or "").strip(),
        phone=(payload.phone or "").strip() or None,
        ticket_type_id=payload.ticket_type_id,
        custom_data=custom, registration_status="registered",
        qr_code="ATT-%s" % uuid.uuid4().hex[:12].upper())
    db.add(attendee)
    db.flush()
    stamp_registration(attendee, "walk_in", at)
    # Gaia's own record of money taken at our desk. It is never written into the
    # entitlement ledger and never counted as GHL revenue.
    attendee.door_payment_status = dps
    if dps in ("collected", "pending"):
        attendee.door_payment_method = dpm
        attendee.door_payment_amount = payload.door_payment_amount
        attendee.door_payment_currency = (payload.door_payment_currency or "USD").upper()[:3]
        attendee.door_payment_reference = (payload.door_payment_reference or "").strip()[:80] or None
        attendee.door_payment_by = current_user.id
        attendee.door_payment_at = datetime.utcnow()
    if payload.note:
        attendee.door_payment_note = str(payload.note)[:300]
    if payload.link_token:
        # Reuse the existing card outright, so there is exactly one per person.
        attendee.public_token = (payload.link_token or "").strip().upper()
    card = attach_member_identity(db, attendee)
    db.commit()
    db.refresh(attendee)
    attendee.effective_access = _effective_access(db, attendee)
    _stamp_card_state(db, [attendee])
    return {"ok": True, "created": True, "already_registered": False,
            "reused_existing_card": bool(payload.link_token),
            "attendee": schemas.Attendee.from_orm(attendee),
            "card_url": badge_card.card_url(card.public_token) if card else None}


@app.get("/events/{event_id}/attendees/search", response_model=List[schemas.Attendee])
def search_attendees(
    event_id: int,
    q: str = "",
    response: Response = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Find an attendee at the door when a QR will not scan.

    Tolerant on purpose, because the person is standing there: first or last
    name, either order, any fragment; any part of the email; a phone number
    however it is typed (only the digits are compared) or just its last
    digits; the ticket code or the badge token. Scoped to the event, so someone
    registered elsewhere is simply not found - the same answer the scanner
    gives. Results are ranked so an exact name lands first, and a cut-off list
    says so in the X-Search-Truncated header instead of pretending 50 was all.
    """
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    term = (q or "").strip().lower()
    if not term:
        return []
    digits = re.sub(r"\D", "", term)
    words = [w for w in re.split(r"\s+", term) if w]
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    scored = []
    for a in rows:
        first = (a.first_name or "").strip().lower()
        last = (a.last_name or "").strip().lower()
        full = ("%s %s" % (first, last)).strip()
        rev = ("%s %s" % (last, first)).strip()
        email = (a.email or "").lower()
        code = (a.qr_code or "").lower()
        tok = (a.public_token or "").lower()
        comp = (a.company or "").lower()
        phone_d = re.sub(r"\D", "", a.phone or "")
        score = 0
        if full == term or rev == term:
            score = 100
        elif full.startswith(term) or last.startswith(term) or first.startswith(term):
            score = 80
        elif term in full or term in rev:
            score = 60
        elif words and all(w in full for w in words):
            score = 55
        elif email == term:
            score = 90
        elif term in email:
            score = 40
        elif term in code or term in tok or (len(term) >= 4 and (code.endswith(term) or tok.endswith(term))):
            score = 85
        elif comp and term in comp:
            score = 30
        if not score and len(digits) >= 4 and phone_d and digits in phone_d:
            score = 70 if phone_d.endswith(digits) else 50
        if score:
            scored.append((score, last, first, a))
    scored.sort(key=lambda t: (-t[0], t[1], t[2]))
    out = [t[3] for t in scored[:50]]
    if response is not None:
        response.headers["X-Search-Total"] = str(len(scored))
        response.headers["X-Search-Truncated"] = "1" if len(scored) > 50 else "0"
    for _a in out:
        _a.effective_access = _effective_access(db, _a)
    _stamp_card_state(db, out)
    return out

CSV_FIELDS = {
    "speakers": ["name", "role", "company", "bio", "photo_url"],
    "sponsors": ["name", "tier", "logo_url", "website", "blurb"],
    "exhibitors": ["company_name", "booth_number", "contact_email", "contact_phone",
                   "category", "website", "logo_url", "description"],
    "sessions": ["title", "description", "session_type", "track", "room", "start_time", "end_time"],
}


def _csv_rows(raw: bytes, entity: str):
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    allowed = CSV_FIELDS[entity]
    rows = []
    for line in reader:
        row = {}
        for key, value in (line or {}).items():
            if key is None:
                continue
            field = key.strip().lower().replace(" ", "_")
            if field in allowed and isinstance(value, str) and value.strip():
                row[field] = value.strip()
        if row:
            rows.append(row)
    return rows


@app.post("/events/{event_id}/import/{entity}")
async def import_csv(
    event_id: int,
    entity: str,
    file: UploadFile = File(...),
    dry_run: bool = Form(True),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Import speakers, sponsors, exhibitors or sessions from a CSV.

    Defaults to a dry run: nothing is written until the caller asks for it, so an
    operator can see what a file would do before it does it. Matching is on the
    entity's natural key within this event, so re-running a corrected file
    updates the same rows instead of duplicating them.
    """
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    if entity not in CSV_FIELDS:
        raise HTTPException(status_code=404, detail=f"Cannot import '{entity}'")
    model, key = _bulk_model(entity)

    rows = _csv_rows(await file.read(), entity)
    created, updated, skipped, warnings = [], [], [], []

    for index, row in enumerate(rows, start=2):  # row 1 is the header
        identifier = row.get(key)
        if not identifier:
            skipped.append(f"row {index}: no {key}")
            continue
        for when in ("start_time", "end_time"):
            if row.get(when):
                parsed = _parse_iso(row[when])
                if parsed is None:
                    warnings.append(f"row {index}: could not read {when} '{row[when]}'")
                    row.pop(when)
                else:
                    row[when] = parsed
        existing = db.query(model).filter(
            model.event_id == event_id, getattr(model, key) == identifier).first()
        if existing:
            updated.append(identifier)
            if not dry_run:
                for field, value in row.items():
                    setattr(existing, field, value)
        else:
            created.append(identifier)
            if not dry_run:
                values = dict(row)
                if entity == "exhibitors":
                    # Exhibitors need a scan token, and contact_email is NOT NULL
                    # in practice — default it rather than colliding with the row.
                    values["access_token"] = f"EXH-{uuid.uuid4().hex[:16].upper()}"
                    values.setdefault("contact_email", "")
                db.add(model(event_id=event_id, is_published=False, **values))
        missing = [f for f in ("bio", "photo_url") if entity == "speakers" and not row.get(f)]
        if missing:
            warnings.append(f"{identifier}: missing {', '.join(missing)}")

    if not dry_run:
        db.commit()
    return {
        "ok": True, "entity": entity, "dry_run": dry_run,
        "would_create" if dry_run else "created": created,
        "would_update" if dry_run else "updated": updated,
        "skipped": skipped, "warnings": warnings,
        "totals": {"rows": len(rows), "create": len(created), "update": len(updated), "skip": len(skipped)},
    }


# ---------------------------------------------------------------------------
# Sponsors and announcements
# ---------------------------------------------------------------------------

@app.get("/events/{event_id}/sponsors", response_model=List[schemas.Sponsor])
def list_sponsors(event_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.Sponsor).filter(
        models.Sponsor.event_id == event_id
    ).order_by(models.Sponsor.sort_order.asc(), models.Sponsor.name.asc()).all()


@app.post("/events/{event_id}/sponsors", response_model=schemas.Sponsor)
def create_sponsor(event_id: int, sponsor: schemas.SponsorCreate, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    db_sponsor = models.Sponsor(event_id=event_id, **sponsor.dict())
    db.add(db_sponsor)
    db.commit()
    db.refresh(db_sponsor)
    return db_sponsor


@app.put("/sponsors/{sponsor_id}", response_model=schemas.Sponsor)
def update_sponsor(sponsor_id: int, changes: schemas.SponsorUpdate, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    sponsor = db.query(models.Sponsor).filter(models.Sponsor.id == sponsor_id).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    authz.require_cap(db, current_user, sponsor.event_id, "event.write")
    for field, value in changes.dict(exclude_unset=True).items():
        setattr(sponsor, field, value)
    db.commit()
    db.refresh(sponsor)
    return sponsor


@app.delete("/sponsors/{sponsor_id}")
def delete_sponsor(sponsor_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    sponsor = db.query(models.Sponsor).filter(models.Sponsor.id == sponsor_id).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    authz.require_cap(db, current_user, sponsor.event_id, "event.write")
    db.delete(sponsor)
    db.commit()
    return {"message": "Sponsor deleted"}


@app.get("/events/{event_id}/announcements", response_model=List[schemas.Announcement])
def list_announcements(event_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.Announcement).filter(
        models.Announcement.event_id == event_id
    ).order_by(models.Announcement.is_pinned.desc(), models.Announcement.created_at.desc()).all()


@app.post("/events/{event_id}/announcements", response_model=schemas.Announcement)
def create_announcement(event_id: int, announcement: schemas.AnnouncementCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    db_announcement = models.Announcement(event_id=event_id, **announcement.dict())
    db.add(db_announcement)
    db.commit()
    db.refresh(db_announcement)
    return db_announcement


@app.put("/announcements/{announcement_id}", response_model=schemas.Announcement)
def update_announcement(announcement_id: int, changes: schemas.AnnouncementUpdate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    announcement = db.query(models.Announcement).filter(models.Announcement.id == announcement_id).first()
    if not announcement:
        raise HTTPException(status_code=404, detail="Announcement not found")
    authz.require_cap(db, current_user, announcement.event_id, "event.write")
    for field, value in changes.dict(exclude_unset=True).items():
        setattr(announcement, field, value)
    db.commit()
    db.refresh(announcement)
    return announcement


@app.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    announcement = db.query(models.Announcement).filter(models.Announcement.id == announcement_id).first()
    if not announcement:
        raise HTTPException(status_code=404, detail="Announcement not found")
    authz.require_cap(db, current_user, announcement.event_id, "event.write")
    db.delete(announcement)
    db.commit()
    return {"message": "Announcement deleted"}


# ---------------------------------------------------------------------------
# Registration intake
#
# Tickets are sold in GHL, so ticket buyers exist there and nowhere else. This
# turns each sale into an attendee with a QR badge, which is what the door
# scanner and the live counters actually read.
# ---------------------------------------------------------------------------

REGISTRATION_WEBHOOK_SECRET = os.getenv("REGISTRATION_WEBHOOK_SECRET", "").strip()

# GHL sends different shapes depending on which trigger fires, so accept the
# common spellings rather than demanding one exact schema.
_FIELD_ALIASES = {
    "email": ("email", "contact_email", "Email", "customer_email"),
    "first_name": ("first_name", "firstName", "first", "given_name"),
    "last_name": ("last_name", "lastName", "last", "family_name"),
    "phone": ("phone", "phone_number", "contact_phone"),
    "company": ("company", "companyName", "organisation", "organization", "business_name"),
    "job_title": ("job_title", "jobTitle", "title", "role"),
    "pass_type": ("pass_type", "passType", "ticket", "ticket_type", "product", "product_name", "offer_name"),
    "contact_id": ("contact_id", "contactId", "ghl_contact_id", "id"),
    "order_id": ("order_id", "orderId", "transaction_id", "invoice_id"),
    "event_id": ("event_id", "eventId"),
    "source_url": ("source_url", "sourceUrl", "page_url"),
}


def _pick(payload: dict, field: str):
    for key in _FIELD_ALIASES[field]:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
    contact = payload.get("contact") or payload.get("customer") or {}
    if isinstance(contact, dict):
        for key in _FIELD_ALIASES[field]:
            value = contact.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _resolve_registration_event(payload: dict, db: Session) -> Optional[models.Event]:
    explicit = _pick(payload, "event_id")
    if explicit and str(explicit).isdigit():
        event = db.query(models.Event).filter(models.Event.id == int(explicit)).first()
        if event:
            return event
    source_url = _pick(payload, "source_url")
    if source_url:
        event = db.query(models.Event).filter(models.Event.source_url == source_url).first()
        if event:
            return event
    # Otherwise the next active event that has not finished — the only sensible
    # default when a funnel posts without naming one.
    return db.query(models.Event).filter(
        models.Event.is_active == True,
        (models.Event.end_date == None) | (models.Event.end_date >= datetime.utcnow()),
    ).order_by(models.Event.start_date.asc()).first()


def _match_ticket_type(db, event_id, pass_type):
    """Map an external pass label (GHL pass_type) to a ticket type for this event,
    by canonical code first, then display name. This is what makes an upgrade
    bought outside the app land as the right access inside it."""
    if not pass_type:
        return None
    pt = str(pass_type).strip().lower()
    for tt in db.query(models.TicketType).filter(models.TicketType.event_id == event_id).all():
        if (tt.code or "").strip().lower() == pt or (tt.name or "").strip().lower() == pt:
            return tt
    return None


def _notify_ticket_change(db, attendee, tt):
    """Confirm an auto-recognised upgrade to the attendee's device, if subscribed."""
    subs = db.query(models.PushSubscription).filter(
        models.PushSubscription.attendee_id == attendee.id).all()
    if not subs:
        return
    payload = {"title": "Ticket updated",
               "body": f"Your ticket is now {tt.name}. Your QR access has been updated.",
               "url": "https://gaiahealers.app/home.html?view=events&event=" + str(attendee.event_id),
               "eventId": attendee.event_id}
    for sub in subs:
        try:
            push_lib.send_one(sub.endpoint, sub.p256dh, sub.auth, payload)
        except Exception:
            pass


def _notify_status(db, attendee, title, body):
    """Push a ticket-status change (refund/revoke/reinstate) to the attendee's
    device, if subscribed. Only ever called AFTER the status is actually set, so
    the message can never claim something that did not happen."""
    subs = db.query(models.PushSubscription).filter(
        models.PushSubscription.attendee_id == attendee.id).all()
    for sub in subs:
        try:
            push_lib.send_one(sub.endpoint, sub.p256dh, sub.auth, {
                "title": title, "body": body,
                "url": "https://gaiahealers.app/home.html?view=events&event=" + str(attendee.event_id),
                "eventId": attendee.event_id})
        except Exception:
            pass


def _log_webhook_noop(reason, email, payload, product_id=None):
    """A registration webhook that resolves to NO entitlement must be loud and
    safe: log why and create nothing. Never a name/price/next-event guess."""
    try:
        print(f"[registration_webhook] NO-OP reason={reason} product_id={product_id} "
              f"email={email} source={(payload or {}).get('source')}", flush=True)
    except Exception:
        pass



def _assert_event_writable(db, event, action="modify"):
    """An archived event is a historical record: nothing may add to or alter it.

    The 2025 conference was archived after its sales cycle was found mixed into
    the 2026 event (the same GHL funnel and product ids were reused across
    years). Reconciler, webhook, scanner, importer and admin writes all pass
    through here so a past event can never silently gain or change attendees.
    """
    if event is not None and getattr(event, "is_archived", 0):
        raise HTTPException(status_code=409,
            detail=f"Event '{event.name}' is archived and read-only; refusing to {action}.")


def _mapping_covers(mapping, when):
    """A product id may be reused for next year's event. A mapping therefore
    only grants its ticket for orders placed inside its own sales window."""
    if not when:
        return True
    w = str(when)[:10]
    vf = getattr(mapping, "valid_from", None)
    vu = getattr(mapping, "valid_until", None)
    if vf and w < str(vf)[:10]:
        return False
    if vu and w > str(vu)[:10]:
        return False
    return True


@app.post("/webhooks/registration")
async def registration_webhook(request: FastAPIRequest, db: Session = Depends(get_db)):
    """Create or update an attendee from a ticket sale.

    Idempotent on (event, email): GHL retries and resends, and a conference must
    not end up with three badges for the same person.
    """
    if not REGISTRATION_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Registration webhook is not configured")

    supplied = (
        request.headers.get("X-Gaia-Secret")
        or request.headers.get("x-gaia-secret")
        or request.query_params.get("secret")
        or ""
    )
    if not secrets.compare_digest(supplied, REGISTRATION_WEBHOOK_SECRET):
        raise HTTPException(status_code=403, detail="Invalid secret")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")

    email = (_pick(payload, "email") or "").lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A contact email is required")

    # HARDENED: an event ticket is minted ONLY from an exact, enabled, EVENT-typed
    # product mapping. No product id, no mapping, or a non-event entitlement type is
    # a logged SAFE NO-OP — never a name/price/next-active-event guess. This closes
    # the one path by which a membership/course/device/other-event payment could
    # otherwise have become an event attendee.
    _EVENT_TYPES = ("EVENT_TICKET", "EVENT_UPGRADE")
    _product_id = payload.get("ghl_product_id") or payload.get("product_id")
    if not _product_id:
        _log_webhook_noop("no_product_id", email, payload)
        return {"ok": True, "created": False, "no_op": True, "reason": "no_product_id",
                "detail": "No authoritative product id; refusing to infer an event ticket."}
    _mapping = db.query(models.TicketMapping).filter(
        models.TicketMapping.external_product_id == str(_product_id).strip(),
        models.TicketMapping.is_active == True,  # noqa: E712
    ).first()
    if not _mapping or (getattr(_mapping, "entitlement_type", "EVENT_TICKET") or "EVENT_TICKET") not in _EVENT_TYPES:
        _log_webhook_noop("unmapped_or_non_event_product", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "unmapped_or_non_event_product",
                "detail": "No enabled event-ticket mapping for this product; nothing granted."}
    event = db.query(models.Event).filter(models.Event.id == _mapping.event_id).first()
    if event is not None and getattr(event, "is_archived", 0):
        _log_webhook_noop("event_archived", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "event_archived",
                "detail": "Mapping points at an archived event; nothing granted."}
    if not _mapping_covers(_mapping, payload.get("created_at") or payload.get("date")):
        _log_webhook_noop("outside_mapping_window", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "outside_mapping_window",
                "detail": "Order date falls outside this mapping's sales window; nothing granted."}
    _forced_tt = _mapping.ticket_type_id
    if not event:
        _log_webhook_noop("mapping_event_missing", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "mapping_event_missing",
                "detail": "Mapping points to a missing event; nothing granted."}

    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        func.lower(models.Attendee.email) == email,
    ).first()

    custom = dict(existing.custom_data or {}) if existing else {}
    for key in ("pass_type", "contact_id", "order_id"):
        value = _pick(payload, key)
        if value:
            custom[key] = value
    custom["source"] = payload.get("source") or "ghl_webhook"

    if existing:
        for field in ("first_name", "last_name", "phone", "company", "job_title"):
            value = _pick(payload, field)
            if value:
                setattr(existing, field, value)
        old_tt = existing.ticket_type_id
        # HARDENED: tier comes only from the explicit mapping, never a name match.
        new_tt = _forced_tt
        if new_tt:
            existing.ticket_type_id = new_tt
        existing.custom_data = custom
        stamp_registration(existing, _inferred_source(existing), "paid")
        link_ghl_order(db, existing)
        attach_member_identity(db, existing)
        db.commit()
        db.refresh(existing)
        upgraded = bool(new_tt and new_tt != old_tt)
        if upgraded and existing.ticket_type:
            _notify_ticket_change(db, existing, existing.ticket_type)
        return {"ok": True, "created": False, "attendee_id": existing.id,
                "event_id": event.id, "qr_code": existing.qr_code,
                "ticket_type_id": existing.ticket_type_id, "upgraded": upgraded}

    attendee = models.Attendee(
        event_id=event.id,
        email=email,
        first_name=_pick(payload, "first_name") or "",
        last_name=_pick(payload, "last_name") or "",
        phone=_pick(payload, "phone"),
        company=_pick(payload, "company"),
        job_title=_pick(payload, "job_title"),
        custom_data=custom,
        ticket_type_id=_forced_tt,
        qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}",
    )
    db.add(attendee)
    db.flush()
    stamp_registration(attendee, "ghl_webhook", "paid")
    link_ghl_order(db, attendee)
    attach_member_identity(db, attendee)
    db.commit()
    db.refresh(attendee)
    return {"ok": True, "created": True, "attendee_id": attendee.id,
            "event_id": event.id, "qr_code": attendee.qr_code,
            "public_token": attendee.public_token}


# ---------------------------------------------------------------------------
# Attendee identity — the bridge between a signed-in Gaia person and the
# attendee records that are theirs.
#
# These endpoints are server-to-server only. The Gaia proxy holds the member
# session, proves who the person is, and calls here with a service token; the
# browser never sends an attendee id and therefore cannot ask for someone
# else's ticket by guessing a number. That is the whole reason the lookup is
# shaped this way rather than as a public /attendees/{id} read.
# ---------------------------------------------------------------------------

IDENTITY_SERVICE_TOKEN = os.getenv("IDENTITY_SERVICE_TOKEN", "").strip()


def require_service_token(request: FastAPIRequest):
    """Fail closed. An unset token disables the endpoints rather than opening them."""
    if not IDENTITY_SERVICE_TOKEN or len(IDENTITY_SERVICE_TOKEN) < 32:
        raise HTTPException(status_code=503, detail="Identity service is not configured")
    header = request.headers.get("authorization") or ""
    supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not secrets.compare_digest(supplied, IDENTITY_SERVICE_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid service token")
    return True


def _attendee_event_payload(attendee: models.Attendee, event: models.Event, db=None) -> dict:
    """One row of My Events: the event, plus what this person holds for it."""
    grants = identity_lib.attendee_grants(attendee)
    return {
        "event_id": event.id,
        "event_name": event.name,
        "start_date": event.start_date,
        "end_date": event.end_date,
        "location": event.location,
        "timezone": event.timezone or "UTC",
        "hero_image_url": event.hero_image_url or "",
        "is_published": bool(event.is_published),
        "attendee": {
            "first_name": attendee.first_name or "",
            "last_name": attendee.last_name or "",
            "email": attendee.email or "",
            "registration_status": attendee.registration_status or "registered",
            "is_checked_in": bool(attendee.is_checked_in),
            "checked_in_at": attendee.checked_in_at,
            "pass_label": identity_lib.pass_label(attendee),
            "ticket_type_code": attendee.ticket_type.code if attendee.ticket_type else None,
            "is_vip": grants["is_vip"],
            "grants_workshops": grants["workshops"],
            # The ONE resolver — same object Admin and Scanner read, so the
            # app renders effective access instead of recomputing it.
            "effective_access": (_effective_access(db, attendee) if db is not None else None),
            # The QR value itself. Returned only through this token-guarded
            # route, and only for records the caller has already proved they own.
            "qr_code": attendee.qr_code,
            # The public alias behind the printed badge QR, and where it opens.
            "public_token": badge_card.ensure_public_token(db, models, attendee) if db is not None else attendee.public_token,
            "card_url": badge_card.card_url(attendee.public_token) if attendee.public_token else "",
        },
    }


@app.post("/identity/my-events")
def identity_my_events(
    payload: schemas.IdentityLookup,
    request: FastAPIRequest,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    """Every event this person holds an attendee record for.

    Ordered by start date. Unpublished events are included when the person is
    genuinely on the list — a ticket holder for an event still being built
    should see their own ticket; the publish gate governs the public programme,
    not a person's own record.
    """
    attendees, evidence, report = identity_lib.resolve_attendees(
        db,
        contact_id=payload.contact_id,
        email=payload.email,
        email_verified=bool(payload.email_verified),
    )

    if payload.record_links and attendees:
        identity_lib.record_links(
            db, attendees, evidence,
            contact_id=payload.contact_id, email=payload.email,
        )

    rows = []
    for attendee in attendees:
        event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first()
        if not event:
            continue
        rows.append(_attendee_event_payload(attendee, event, db))

    rows.sort(key=lambda r: (r["start_date"] is None, r["start_date"] or datetime.max))
    return {"ok": True, "events": rows, "resolution": report}


@app.post("/identity/ticket")
def identity_ticket(
    payload: schemas.IdentityTicketLookup,
    request: FastAPIRequest,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    """This person's ticket for one event, with a rendered QR image.

    The event is named by the caller, but ownership is still re-proved here
    rather than trusted: resolution runs again and the requested event must
    appear in the result. A caller that names an event the person does not hold
    gets the same answer as a caller naming an event that does not exist.
    """
    attendees, evidence, report = identity_lib.resolve_attendees(
        db,
        contact_id=payload.contact_id,
        email=payload.email,
        email_verified=bool(payload.email_verified),
    )
    attendee = next((a for a in attendees if a.event_id == payload.event_id), None)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}

    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first()
    if not event:
        return {"ok": False, "reason": "event_not_found"}

    row = _attendee_event_payload(attendee, event, db)
    row["ok"] = True
    row["qr_image"] = generate_qr_code(attendee.qr_code)
    row["resolution"] = report
    return row


def _resolve_own_attendee(payload, db):
    """The attendee record this caller has proved is theirs, for one event.

    Every schedule route goes through here. Ownership is re-proved on each call
    rather than trusted from a previous one, so there is no request shape in
    which a caller reaches a session list that is not their own.
    """
    attendees, _evidence, report = identity_lib.resolve_attendees(
        db,
        contact_id=payload.contact_id,
        email=payload.email,
        email_verified=bool(payload.email_verified),
    )
    attendee = next((a for a in attendees if a.event_id == payload.event_id), None)
    return attendee, report


@app.post("/identity/schedule")
def identity_schedule(
    payload: schemas.IdentityTicketLookup,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    """This person's saved sessions for one event."""
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    result = schedule_lib.my_schedule(db, attendee)
    result["saved_ids"] = schedule_lib.saved_ids(db, attendee)
    result["registrations"] = workshops_lib.my_registrations(db, attendee)
    return result


@app.post("/identity/schedule/save")
def identity_schedule_save(
    payload: schemas.ScheduleChange,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    result = schedule_lib.save_session(db, attendee, payload.session_id)
    if result.get("ok"):
        result["saved_ids"] = schedule_lib.saved_ids(db, attendee)
    return result


@app.post("/identity/schedule/unsave")
def identity_schedule_unsave(
    payload: schemas.ScheduleChange,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    result = schedule_lib.unsave_session(db, attendee, payload.session_id)
    result["saved_ids"] = schedule_lib.saved_ids(db, attendee)
    return result


@app.post("/identity/workshops/register")
def identity_workshop_register(
    payload: schemas.ScheduleChange,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    result = workshops_lib.register(db, attendee, payload.session_id)
    result["registrations"] = workshops_lib.my_registrations(db, attendee)
    return result


@app.post("/identity/workshops/unregister")
def identity_workshop_unregister(
    payload: schemas.ScheduleChange,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    result = workshops_lib.unregister(db, attendee, payload.session_id)
    result["registrations"] = workshops_lib.my_registrations(db, attendee)
    return result


@app.post("/sessions/{session_id}/checkin")
def session_checkin(
    session_id: int,
    request: schemas.CheckInRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Staff scan at a session door: verify the place, record the walk-in.

    Same authorization as the event door — checkin.perform at this session's
    event — so weekend door staff can also work a workshop entrance, and staff
    from another event cannot.
    """
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not authz.can(db, current_user, session.event_id, "checkin.perform"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")

    attendee = db.query(models.Attendee).filter(
        models.Attendee.qr_code == request.qr_code,
        models.Attendee.event_id == session.event_id,
    ).first()
    if not attendee:
        return {"ok": False, "reason": "badge_not_valid_here"}

    result = workshops_lib.record_attendance(db, session, attendee)
    result["attendee_name"] = f"{attendee.first_name or ''} {attendee.last_name or ''}".strip()
    return result


VALID_PLACE_KINDS = {"room", "booth", "stage", "registration", "restroom",
                     "food", "entrance", "help", "other"}


def _place_payload(place: models.VenuePlace) -> dict:
    return {
        "id": place.id,
        "kind": place.kind or "other",
        "name": place.name or "",
        "description": place.description or "",
        "x": max(0, min(100, place.x if place.x is not None else 50)),
        "y": max(0, min(100, place.y if place.y is not None else 50)),
        "exhibitor_id": place.exhibitor_id,
        "sort_order": place.sort_order or 0,
    }


@app.get("/public/events/{event_id}/map")
def get_public_map(event_id: int, db: Session = Depends(get_db)):
    """The venue plan and its published places. Public — it is a map."""
    event = _published_event_or_404(event_id, db)
    places = db.query(models.VenuePlace).filter(
        models.VenuePlace.event_id == event_id,
        models.VenuePlace.is_published == True,
    ).order_by(models.VenuePlace.sort_order.asc(), models.VenuePlace.name.asc()).all()
    return {
        "event_id": event.id,
        "map_image_url": event.map_image_url or "",
        "places": [_place_payload(p) for p in places],
    }


@app.get("/events/{event_id}/places")
def list_places_admin(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Every place, published or not, for the organiser building the map.

    The public map endpoint refuses draft events — correct for visitors, and
    exactly wrong for the person still assembling the event. Without this, an
    organiser adding pins to an unpublished event could not see their own work.
    """
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.read"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    rows = db.query(models.VenuePlace).filter(
        models.VenuePlace.event_id == event_id,
    ).order_by(models.VenuePlace.sort_order.asc(), models.VenuePlace.name.asc()).all()
    return [_place_payload(p) for p in rows]


@app.post("/events/{event_id}/places")
def create_place(
    event_id: int,
    payload: schemas.PlaceCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Add a place to this event's map. Organiser-scoped, like all event writes."""
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    kind = payload.kind if payload.kind in VALID_PLACE_KINDS else "other"
    if payload.exhibitor_id:
        exhibitor = db.query(models.Exhibitor).filter(
            models.Exhibitor.id == payload.exhibitor_id).first()
        # A booth pin must not point at another event's exhibitor.
        if not exhibitor or exhibitor.event_id != event_id:
            raise HTTPException(status_code=400, detail="Exhibitor is not part of this event")
    place = models.VenuePlace(
        event_id=event_id, kind=kind, name=payload.name or "",
        description=payload.description or "",
        x=max(0, min(100, payload.x)), y=max(0, min(100, payload.y)),
        exhibitor_id=payload.exhibitor_id,
        sort_order=payload.sort_order or 0,
        is_published=payload.is_published if payload.is_published is not None else True,
    )
    db.add(place)
    db.commit()
    db.refresh(place)
    return _place_payload(place)


@app.put("/places/{place_id}")
def update_place(
    place_id: int,
    payload: schemas.PlaceUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    place = db.query(models.VenuePlace).filter(models.VenuePlace.id == place_id).first()
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")
    if not authz.can(db, current_user, place.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    data = payload.model_dump(exclude_unset=True)
    if "kind" in data and data["kind"] not in VALID_PLACE_KINDS:
        data["kind"] = "other"
    if "exhibitor_id" in data and data["exhibitor_id"]:
        exhibitor = db.query(models.Exhibitor).filter(
            models.Exhibitor.id == data["exhibitor_id"]).first()
        if not exhibitor or exhibitor.event_id != place.event_id:
            raise HTTPException(status_code=400, detail="Exhibitor is not part of this event")
    for field in ("kind", "name", "description", "sort_order", "exhibitor_id", "is_published"):
        if field in data:
            setattr(place, field, data[field])
    for axis in ("x", "y"):
        if axis in data and data[axis] is not None:
            setattr(place, axis, max(0, min(100, data[axis])))
    db.commit()
    db.refresh(place)
    return _place_payload(place)


@app.delete("/places/{place_id}")
def delete_place(
    place_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    place = db.query(models.VenuePlace).filter(models.VenuePlace.id == place_id).first()
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")
    if not authz.can(db, current_user, place.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    db.delete(place)
    db.commit()
    return {"ok": True}


@app.post("/identity/networking/profile")
def identity_networking_profile(
    payload: schemas.NetworkingProfileChange,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.set_profile(db, attendee,
                                      visible=bool(payload.visible), bio=payload.bio or "")


@app.post("/identity/networking/directory")
def identity_networking_directory(
    payload: schemas.IdentityTicketLookup,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.directory(db, attendee)


@app.post("/identity/networking/connect")
def identity_networking_connect(
    payload: schemas.ConnectionRequest,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.connect(db, attendee, payload.target_attendee_id)


@app.post("/identity/networking/respond")
def identity_networking_respond(
    payload: schemas.ConnectionResponse,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.respond(db, attendee, payload.connection_id, bool(payload.accept))


@app.post("/identity/networking/connections")
def identity_networking_connections(
    payload: schemas.IdentityTicketLookup,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.my_connections(db, attendee)


@app.post("/identity/feedback")
def identity_feedback(
    payload: schemas.FeedbackSubmit,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    """Rate the event, or one of its sessions. One opinion per person per target."""
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    if not (1 <= int(payload.rating) <= 5):
        return {"ok": False, "reason": "rating_out_of_range"}

    session_id = payload.session_id
    if session_id is not None:
        session = db.query(models.Session).filter(models.Session.id == session_id).first()
        if not session or session.event_id != attendee.event_id:
            return {"ok": False, "reason": "session_not_in_this_event"}

    row = db.query(models.Feedback).filter(
        models.Feedback.attendee_id == attendee.id,
        models.Feedback.session_id == session_id,
    ).first()
    if row:
        # A changed mind is one opinion, not two.
        row.rating = int(payload.rating)
        row.comment = (payload.comment or "").strip()[:1000]
        row.updated_at = datetime.utcnow()
    else:
        row = models.Feedback(
            event_id=attendee.event_id, attendee_id=attendee.id,
            session_id=session_id, rating=int(payload.rating),
            comment=(payload.comment or "").strip()[:1000],
        )
        db.add(row)
    db.commit()
    return {"ok": True, "rating": row.rating, "comment": row.comment or ""}


@app.post("/identity/feedback/mine")
def identity_feedback_mine(
    payload: schemas.IdentityTicketLookup,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    """Only ever this person's own ratings — for pre-filling their stars."""
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    rows = db.query(models.Feedback).filter(
        models.Feedback.attendee_id == attendee.id).all()
    return {"ok": True, "ratings": [
        {"session_id": r.session_id, "rating": r.rating, "comment": r.comment or ""}
        for r in rows
    ]}


@app.get("/events/{event_id}/feedback/summary")
def feedback_summary(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Aggregates for the organiser. Counts and averages — never names.

    Comments are included but deliberately unattributed: the organiser learns
    what was said, not who said it. analytics.read is the gate, per event.
    """
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "analytics.read"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")

    rows = db.query(models.Feedback).filter(models.Feedback.event_id == event_id).all()
    by_target = {}
    for row in rows:
        key = row.session_id or 0   # 0 = the event itself
        bucket = by_target.setdefault(key, {"count": 0, "total": 0, "comments": []})
        bucket["count"] += 1
        bucket["total"] += row.rating or 0
        if row.comment:
            bucket["comments"].append(row.comment)

    session_titles = {s.id: s.title for s in db.query(models.Session).filter(
        models.Session.event_id == event_id).all()}
    out = []
    for key, bucket in sorted(by_target.items()):
        out.append({
            "session_id": key or None,
            "title": session_titles.get(key, "The event overall") if key else "The event overall",
            "count": bucket["count"],
            "average": round(bucket["total"] / bucket["count"], 2) if bucket["count"] else None,
            "comments": bucket["comments"],
        })
    return {"ok": True, "event_id": event_id, "summary": out}


# ── Ticket types and roles: what the admin configures per event ─────────────

def _tt_payload(tt):
    return {"id": tt.id, "code": tt.code or "", "name": tt.name or "",
            "description": tt.description or "", "is_vip": bool(tt.is_vip),
            "grants_workshops": bool(tt.grants_workshops),
            "sort_order": tt.sort_order or 0}


@app.get("/events/{event_id}/ticket-types")
def list_ticket_types(event_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.read"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    rows = db.query(models.TicketType).filter(models.TicketType.event_id == event_id
        ).order_by(models.TicketType.sort_order.asc(), models.TicketType.name.asc()).all()
    return [_tt_payload(t) for t in rows]


@app.post("/events/{event_id}/ticket-types")
def create_ticket_type(event_id: int, payload: schemas.TicketTypeCreate,
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    code = (payload.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="A canonical code is required")
    duplicate = db.query(models.TicketType).filter(
        models.TicketType.event_id == event_id, models.TicketType.code == code).first()
    if duplicate:
        # One code, one meaning. Two rows sharing a code is how access forks.
        raise HTTPException(status_code=400, detail="That code already exists for this event")
    tt = models.TicketType(event_id=event_id, code=code, name=payload.name or code,
                           description=payload.description or "",
                           is_vip=bool(payload.is_vip),
                           grants_workshops=bool(payload.grants_workshops),
                           sort_order=payload.sort_order or 0)
    db.add(tt)
    db.commit()
    db.refresh(tt)
    return _tt_payload(tt)


@app.put("/ticket-types/{tt_id}")
def update_ticket_type(tt_id: int, payload: schemas.TicketTypeUpdate,
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    tt = db.query(models.TicketType).filter(models.TicketType.id == tt_id).first()
    if not tt:
        raise HTTPException(status_code=404, detail="Ticket type not found")
    if not authz.can(db, current_user, tt.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(tt, field, value)
    db.commit()
    db.refresh(tt)
    return _tt_payload(tt)


@app.delete("/ticket-types/{tt_id}")
def delete_ticket_type(tt_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    tt = db.query(models.TicketType).filter(models.TicketType.id == tt_id).first()
    if not tt:
        raise HTTPException(status_code=404, detail="Ticket type not found")
    if not authz.can(db, current_user, tt.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    holders = db.query(models.Attendee).filter(models.Attendee.ticket_type_id == tt_id).count()
    if holders:
        # Deleting a pass people hold would silently strip their access.
        raise HTTPException(status_code=400,
                            detail=f"{holders} attendee(s) hold this pass; reassign them first")
    db.delete(tt)
    db.commit()
    return {"ok": True}


@app.get("/events/{event_id}/info", response_model=List[schemas.EventInfo])
def list_event_info(event_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.EventInfo).filter(models.EventInfo.event_id == event_id).order_by(
        models.EventInfo.section, models.EventInfo.sort_order, models.EventInfo.id).all()


@app.post("/events/{event_id}/info", response_model=schemas.EventInfo)
def create_event_info(event_id: int, payload: schemas.EventInfoCreate,
                      db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    info = models.EventInfo(event_id=event_id, section=(payload.section or "faq"),
                            title=payload.title or "", body=payload.body or "",
                            sort_order=payload.sort_order or 0,
                            is_published=True if payload.is_published is None else bool(payload.is_published))
    db.add(info); db.commit(); db.refresh(info)
    return info


@app.put("/info/{info_id}", response_model=schemas.EventInfo)
def update_event_info(info_id: int, payload: schemas.EventInfoUpdate,
                      db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    info = db.query(models.EventInfo).filter(models.EventInfo.id == info_id).first()
    if not info:
        raise HTTPException(status_code=404, detail="Info card not found")
    if not authz.can(db, current_user, info.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(info, field, value)
    db.commit(); db.refresh(info)
    return info


@app.delete("/info/{info_id}")
def delete_event_info(info_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    info = db.query(models.EventInfo).filter(models.EventInfo.id == info_id).first()
    if not info:
        raise HTTPException(status_code=404, detail="Info card not found")
    if not authz.can(db, current_user, info.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    db.delete(info); db.commit()
    return {"ok": True}


@app.get("/public/events/{event_id}/info")
def public_event_info(event_id: int, db: Session = Depends(get_db)):
    _published_event_or_404(event_id, db)
    rows = db.query(models.EventInfo).filter(
        models.EventInfo.event_id == event_id,
        models.EventInfo.is_published == True,  # noqa: E712
    ).order_by(models.EventInfo.sort_order, models.EventInfo.id).all()
    sections = {}
    for r in rows:
        sections.setdefault(r.section or "faq", []).append({"id": r.id, "title": r.title, "body": r.body})
    return {"sections": sections,
            "items": [{"id": r.id, "section": r.section or "faq", "title": r.title, "body": r.body} for r in rows]}


@app.get("/events/{event_id}/attendees/export")
def export_attendees(event_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    """Attendee CSV. Every export is written to the audit trail so who took the
    data — and how much — is always recoverable."""
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "attendee.read"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    rows = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    import io as _io
    from fastapi.responses import Response as _Response
    buf = _io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["first_name", "last_name", "email", "phone", "company", "job_title",
                     "base_ticket", "add_ons", "add_on_day", "effective_access",
                     "registration_status", "checked_in", "checked_in_at",
                     "qr_code", "source", "order_ref"])
    for a in rows:
        _eff = _effective_access(db, a)
        _bt = _eff.get("base_ticket") or {}
        _addons = _eff.get("addons") or []
        _cd = a.custom_data or {}
        writer.writerow([a.first_name, a.last_name, a.email, a.phone or "", a.company or "",
                         a.job_title or "", (_bt.get("name") or ""),
                         "; ".join(x.get("label") or "" for x in _addons),
                         "; ".join((x.get("day") or "") for x in _addons),
                         _eff.get("effective_label") or "",
                         a.registration_status, "yes" if a.is_checked_in else "no",
                         a.checked_in_at.isoformat() if a.checked_in_at else "", a.qr_code,
                         _cd.get("source") or "", _cd.get("order_id") or ""])
    db.add(models.ExportAudit(event_id=event_id, user_id=current_user.id, kind="attendees", count=len(rows)))
    db.commit()
    return _Response(content=buf.getvalue(), media_type="text/csv",
                     headers={"Content-Disposition": f'attachment; filename="attendees_event_{event_id}.csv"'})


@app.get("/events/{event_id}/exports")
def list_exports(event_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    out = []
    for r in db.query(models.ExportAudit).filter(models.ExportAudit.event_id == event_id).order_by(
            models.ExportAudit.created_at.desc()).limit(50).all():
        u = db.query(models.User).filter(models.User.id == r.user_id).first() if r.user_id else None
        out.append({"id": r.id, "kind": r.kind, "count": r.count,
                    "at": r.created_at.isoformat() if r.created_at else None,
                    "by": u.email if u else None})
    return out


@app.get("/events/{event_id}/resources", response_model=List[schemas.EventResource])
def list_event_resources(event_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    return db.query(models.EventResource).filter(models.EventResource.event_id == event_id).order_by(
        models.EventResource.sort_order, models.EventResource.id).all()


@app.post("/events/{event_id}/resources", response_model=schemas.EventResource)
def create_event_resource(event_id: int, payload: schemas.EventResourceCreate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    r = models.EventResource(event_id=event_id, title=payload.title or "",
                             description=payload.description or "", url=payload.url or "",
                             category=payload.category or "general", sort_order=payload.sort_order or 0,
                             is_published=True if payload.is_published is None else bool(payload.is_published))
    db.add(r); db.commit(); db.refresh(r)
    return r


@app.put("/resources/{resource_id}", response_model=schemas.EventResource)
def update_event_resource(resource_id: int, payload: schemas.EventResourceUpdate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    r = db.query(models.EventResource).filter(models.EventResource.id == resource_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Resource not found")
    if not authz.can(db, current_user, r.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(r, field, value)
    db.commit(); db.refresh(r)
    return r


@app.delete("/resources/{resource_id}")
def delete_event_resource(resource_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    r = db.query(models.EventResource).filter(models.EventResource.id == resource_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Resource not found")
    if not authz.can(db, current_user, r.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    db.delete(r); db.commit()
    return {"ok": True}


@app.get("/public/events/{event_id}/resources")
def public_event_resources(event_id: int, db: Session = Depends(get_db)):
    _published_event_or_404(event_id, db)
    rows = db.query(models.EventResource).filter(
        models.EventResource.event_id == event_id,
        models.EventResource.is_published == True,  # noqa: E712
    ).order_by(models.EventResource.sort_order, models.EventResource.id).all()
    return [{"id": r.id, "title": r.title, "description": r.description,
             "url": r.url, "category": r.category or "general"} for r in rows]


def _copy_columns(src, model, **overrides):
    """Shallow copy of a row's columns into a new instance (id dropped), with
    explicit overrides for FKs/tokens that must not be shared across events."""
    from sqlalchemy import inspect as _sa_inspect
    keys = [c.key for c in _sa_inspect(model).mapper.column_attrs if c.key != "id"]
    data = {k: getattr(src, k) for k in keys}
    data.update(overrides)
    return model(**data)


@app.post("/events/{event_id}/duplicate", response_model=schemas.Event)
def duplicate_event(event_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Clone an event's STRUCTURE for the next occurrence — passes, speakers,
    sessions, sponsors, exhibitors, map, FAQ and resources — as a fresh DRAFT.
    Never copies people or transactional data (attendees, check-ins,
    announcements, leads, staff roles): a new event starts with an empty house."""
    src = _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    new = _copy_columns(src, models.Event, name=(src.name or "Event") + " (COPY)",
                        is_published=False, source_url=None, locked_fields=[],
                        created_at=datetime.utcnow())
    db.add(new)
    db.flush()

    for tt in db.query(models.TicketType).filter(models.TicketType.event_id == src.id).all():
        db.add(_copy_columns(tt, models.TicketType, event_id=new.id))

    spk_map = {}
    for sp in db.query(models.Speaker).filter(models.Speaker.event_id == src.id).all():
        ns = _copy_columns(sp, models.Speaker, event_id=new.id)
        db.add(ns)
        db.flush()
        spk_map[sp.id] = ns

    for se in db.query(models.Session).filter(models.Session.event_id == src.id).all():
        ns = _copy_columns(se, models.Session, event_id=new.id)
        db.add(ns)
        db.flush()
        for sp in se.speakers:
            if sp.id in spk_map:
                ns.speakers.append(spk_map[sp.id])

    for sp in db.query(models.Sponsor).filter(models.Sponsor.event_id == src.id).all():
        db.add(_copy_columns(sp, models.Sponsor, event_id=new.id))

    exh_map = {}
    for ex in db.query(models.Exhibitor).filter(models.Exhibitor.event_id == src.id).all():
        ne = _copy_columns(ex, models.Exhibitor, event_id=new.id,
                           access_token=f"EXH-{uuid.uuid4().hex[:16].upper()}")
        db.add(ne)
        db.flush()
        exh_map[ex.id] = ne.id

    for pl in db.query(models.VenuePlace).filter(models.VenuePlace.event_id == src.id).all():
        db.add(_copy_columns(pl, models.VenuePlace, event_id=new.id,
                             exhibitor_id=exh_map.get(pl.exhibitor_id)))

    for it in db.query(models.EventInfo).filter(models.EventInfo.event_id == src.id).all():
        db.add(_copy_columns(it, models.EventInfo, event_id=new.id))
    for r in db.query(models.EventResource).filter(models.EventResource.event_id == src.id).all():
        db.add(_copy_columns(r, models.EventResource, event_id=new.id))

    db.commit()
    db.refresh(new)
    return new


@app.get("/events/{event_id}/ticket-mappings", response_model=List[schemas.TicketMapping])
def list_ticket_mappings(event_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    return db.query(models.TicketMapping).filter(models.TicketMapping.event_id == event_id).order_by(
        models.TicketMapping.id).all()


@app.post("/events/{event_id}/ticket-mappings", response_model=schemas.TicketMapping)
def create_ticket_mapping(event_id: int, payload: schemas.TicketMappingCreate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    mp = models.TicketMapping(event_id=event_id, provider=payload.provider or "ghl",
                              external_product_id=(payload.external_product_id or "").strip(),
                              external_price_id=(payload.external_price_id or None),
                              ticket_type_id=payload.ticket_type_id,
                              is_upgrade=bool(payload.is_upgrade), label=payload.label or "",
                              checkout_url=(payload.checkout_url or None),
                              from_ticket_type_id=(payload.from_ticket_type_id or None),
                              entitlement_type=(getattr(payload, "entitlement_type", None)
                                                or ("EVENT_UPGRADE" if payload.is_upgrade else "EVENT_TICKET")),
                              addon_code=(getattr(payload, "addon_code", None) or None),
                              is_active=True if payload.is_active is None else bool(payload.is_active))
    db.add(mp); db.commit(); db.refresh(mp)
    return mp


@app.put("/ticket-mappings/{mapping_id}", response_model=schemas.TicketMapping)
def update_ticket_mapping(mapping_id: int, payload: schemas.TicketMappingUpdate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    mp = db.query(models.TicketMapping).filter(models.TicketMapping.id == mapping_id).first()
    if not mp:
        raise HTTPException(status_code=404, detail="Mapping not found")
    if not authz.can(db, current_user, mp.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(mp, field, value)
    db.commit(); db.refresh(mp)
    return mp


@app.delete("/ticket-mappings/{mapping_id}")
def delete_ticket_mapping(mapping_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    mp = db.query(models.TicketMapping).filter(models.TicketMapping.id == mapping_id).first()
    if not mp:
        raise HTTPException(status_code=404, detail="Mapping not found")
    if not authz.can(db, current_user, mp.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    db.delete(mp); db.commit()
    return {"ok": True}


@app.get("/identity/ticket-mappings")
def identity_ticket_mappings(db: Session = Depends(get_db), _: bool = Depends(require_service_token)):
    """All active mappings, for the reconciler running in the Gaia proxy."""
    rows = db.query(models.TicketMapping).filter(models.TicketMapping.is_active == True).all()  # noqa: E712
    return [{"provider": r.provider, "external_product_id": r.external_product_id,
             "external_price_id": r.external_price_id, "event_id": r.event_id,
             "ticket_type_id": r.ticket_type_id, "is_upgrade": bool(r.is_upgrade),
             "entitlement_type": getattr(r, "entitlement_type", None) or "EVENT_TICKET",
             "addon_code": getattr(r, "addon_code", None),
               "valid_from": getattr(r, "valid_from", None),
               "valid_until": getattr(r, "valid_until", None),
             "label": r.label, "checkout_url": r.checkout_url} for r in rows]


@app.post("/identity/upgrades")
def identity_upgrades(payload: schemas.IdentityTicketLookup,
                      db: Session = Depends(get_db),
                      _: bool = Depends(require_service_token)):
    """Eligible upgrades for this person's ticket in one event. Source of truth is
    ticket_mappings + ticket_types.upgrade_rank: only mapped is_upgrade products
    whose target tier ranks STRICTLY HIGHER than what they already hold are
    returned — never a downgrade, never their own tier. Price is not stored here;
    the caller reads it live from GHL via external_price_id, so it is always the
    real configured amount, never a hard-coded guess."""
    attendees, _evidence, report = identity_lib.resolve_attendees(
        db, contact_id=payload.contact_id, email=payload.email,
        email_verified=bool(payload.email_verified))
    attendee = next((a for a in attendees if a.event_id == payload.event_id), None)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    if not _ticket_active(attendee):
        # A refunded/revoked ticket cannot be upgraded until reinstated/repurchased.
        return {"ok": True, "status": _ticket_status(attendee), "upgrades": [],
                "current": None, "reason": "ticket_not_active"}
    cur_rank = _tt_rank(db, attendee.ticket_type_id)
    cur = attendee.ticket_type
    maps = db.query(models.TicketMapping).filter(
        models.TicketMapping.event_id == attendee.event_id,
        models.TicketMapping.is_upgrade == True,        # noqa: E712
        models.TicketMapping.is_active == True).all()   # noqa: E712
    opts = []
    for m in maps:
        tt = db.query(models.TicketType).filter(models.TicketType.id == m.ticket_type_id).first()
        if not tt:
            continue
        rank = tt.upgrade_rank if tt.upgrade_rank is not None else 0
        if rank <= cur_rank:      # strictly higher only
            continue
        if m.from_ticket_type_id and m.from_ticket_type_id != attendee.ticket_type_id:
            continue   # per-source pricing: only the path from THIS current tier
        opts.append({"ticket_type_id": tt.id, "tier_name": tt.name, "tier_code": tt.code,
                     "upgrade_rank": rank, "is_vip": bool(tt.is_vip),
                     "grants_workshops": bool(tt.grants_workshops),
                     "external_product_id": m.external_product_id,
                     "external_price_id": m.external_price_id,
                     "checkout_url": m.checkout_url, "label": m.label,
                     "from_ticket_type_id": m.from_ticket_type_id})
    opts.sort(key=lambda o: o["upgrade_rank"])
    return {"ok": True, "status": _ticket_status(attendee),
            "current": {"ticket_type_id": cur.id if cur else None,
                        "tier_name": cur.name if cur else None,
                        "tier_code": cur.code if cur else None,
                        "upgrade_rank": cur_rank},
            "upgrades": opts}


@app.post("/identity/report-unmapped-sale")
def report_unmapped_sale(payload: schemas.UnmappedSaleIn, db: Session = Depends(get_db),
                         _: bool = Depends(require_service_token)):
    """Someone paid for something we do not recognise as a ticket.

    Recorded for a human, never converted into access. Idempotent on the
    order/invoice reference. If the product has since been mapped, the row
    closes itself rather than nagging.
    """
    ref = (payload.reference or "").strip()
    if not ref:
        raise HTTPException(status_code=400, detail="A payment reference is required")
    if payload.product_id:
        mapped = db.query(models.TicketMapping).filter(
            models.TicketMapping.external_product_id == payload.product_id,
            models.TicketMapping.is_active == True).first()
        if mapped:
            row = db.query(models.UnmappedSale).filter(models.UnmappedSale.reference == ref).first()
            if row and row.status == "pending":
                row.status = "mapped"; row.resolved_at = datetime.utcnow(); db.commit()
            return {"ok": True, "recorded": False, "reason": "product_is_now_mapped"}
    row = db.query(models.UnmappedSale).filter(models.UnmappedSale.reference == ref).first()
    if row:
        return {"ok": True, "recorded": False, "already": True, "id": row.id, "status": row.status}
    email = (payload.buyer_email or "").lower() or None
    # Triage on the way in, so the panel stays about this event. Nothing is
    # discarded: an "unrelated" row is stored in full and still searchable.
    relevance, reason = _classify_unmapped(payload.product_name, payload.amount,
                                           email, payload.funnel, db, payload.event_id)
    row = models.UnmappedSale(
        event_id=payload.event_id, reference=ref, source=payload.source,
        product_id=payload.product_id, product_name=payload.product_name,
        buyer_name=payload.buyer_name, buyer_email=email,
        contact_id=payload.contact_id, amount=payload.amount, currency=payload.currency,
        quantity=payload.quantity or 1, paid_at=payload.paid_at, funnel=payload.funnel,
        relevance=relevance, relevance_reason=reason)
    db.add(row); db.commit(); db.refresh(row)
    return {"ok": True, "recorded": True, "id": row.id,
            "relevance": relevance, "relevance_reason": reason}


# Triage for the review panel. This decides only what staff are SHOWN, never
# what is granted -- a product becomes event access when a human maps it and at
# no other moment. That separation is what makes a name-based hint acceptable
# here when it would be unacceptable anywhere near an entitlement.
#
# Gaia Healers sells Bio-Well devices, Healeex systems, CRM subscriptions,
# sponsorship tiers and calendar bookings through the same GHL location as event
# tickets. Those are real sales; they are simply not this event's, and leaving
# 80 of them permanently in an event alert trains staff to ignore the alert.

_EVENT_WORDS = ("ticket", "admission", "pass", "conference", "expo", "exhibit",
                "attendee", "seat", "vip", "workshop", "summit", "elevate",
                "day pass", "speaker")
_NOT_EVENT_WORDS = ("bio-well", "biowell", "bio well", "healeex", "crm",
                    "subscription", "sponsor", "ambassador", "legacy partner",
                    "connector", "device", "sensor", "bundle", "wholesale",
                    "via calendars", "biopulsar", "plasma", "scan", "custom item",
                    "colour energy", "color energy")


def _classify_unmapped(product_name, amount, buyer_email, funnel, db, event_id):
    """event_like -> stays in the review panel. unrelated -> kept, not shown."""
    name = (product_name or "").strip().lower()
    fun = (funnel or "").strip().lower()

    # Strongest signal available, and it is not a name at all: this buyer already
    # holds a ticket to this event, so the purchase is very likely event-related.
    if buyer_email and event_id:
        holder = db.query(models.Attendee).filter(
            models.Attendee.event_id == event_id,
            func.lower(models.Attendee.email) == buyer_email.strip().lower()).first()
        if holder:
            return "event_like", "buyer already holds a ticket to this event"

    if fun and any(w in fun for w in ("elevate", "conference", "exhibit", "event")):
        return "event_like", "purchased through an event funnel"

    if any(w in name for w in _EVENT_WORDS):
        return "event_like", "product name reads like event admission"

    if any(w in name for w in _NOT_EVENT_WORDS):
        return "unrelated", "matches the non-event catalogue"

    # A device costs thousands; a ticket does not. Used only to break ties.
    try:
        if amount is not None and float(amount) > 1000:
            return "unrelated", "amount is far outside any ticket price"
    except (TypeError, ValueError):
        pass
    return "event_like", "could not be ruled out"


@app.get("/events/{event_id}/unmapped-sales")
def unmapped_sales(event_id: int, include_resolved: bool = False,
                   include_unrelated: bool = False,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Paid products nobody has mapped to a ticket. Review required."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    q = db.query(models.UnmappedSale).filter(
        (models.UnmappedSale.event_id == event_id) | (models.UnmappedSale.event_id.is_(None)))
    if not include_resolved:
        q = q.filter(models.UnmappedSale.status == "pending")
    all_rows = q.order_by(models.UnmappedSale.paid_at.desc()).limit(500).all()
    # Bio-Well kits and sponsorships are real sales that simply are not this
    # event's. They stay recorded and reachable, but an event alert that is 90%
    # other people's business is an alert nobody reads.
    unrelated_n = sum(1 for r in all_rows if (r.relevance or "event_like") == "unrelated")
    rows = ([r for r in all_rows if (r.relevance or "event_like") != "unrelated"]
            if not include_unrelated else all_rows)[:200]
    out = []
    for r in rows:
        att = db.query(models.Attendee).filter(
            models.Attendee.event_id == event_id,
            func.lower(models.Attendee.email) == (r.buyer_email or "")).first() if r.buyer_email else None
        out.append({"id": r.id, "reference": r.reference, "source": r.source,
                    "product_id": r.product_id, "product_name": r.product_name,
                    "buyer_name": r.buyer_name, "buyer_email": r.buyer_email,
                    "amount": r.amount, "currency": r.currency, "quantity": r.quantity,
                    "paid_at": r.paid_at, "funnel": r.funnel, "status": r.status,
                    "relevance": r.relevance or "event_like",
                    "relevance_reason": r.relevance_reason,
                    "already_an_attendee": bool(att)})
    return {"event_id": event_id,
            "pending": sum(1 for r in rows if r.status == "pending"),
            "unrelated_hidden": 0 if include_unrelated else unrelated_n,
            "items": out}


@app.post("/events/{event_id}/unmapped-sales/{sale_id}/dismiss")
def dismiss_unmapped_sale(event_id: int, sale_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    """Not a ticket. Recorded as reviewed so it stops asking."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.write")
    r = db.query(models.UnmappedSale).filter(models.UnmappedSale.id == sale_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    r.status = "dismissed"; r.resolved_by = current_user.id; r.resolved_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Map & Reconcile
#
# A product only becomes event access when a human maps it. That rule is right,
# but until now mapping a product did nothing for the sales that already
# happened: four people bought a day pass created that morning, and even after
# somebody mapped it their payments sat there unrepresented.
#
# This closes that. Staff pick an immutable GHL product id, choose the Gaia
# ticket type, see exactly what the replay would do, and only then approve it.
# The replay calls the SAME reconcile functions the webhook and the hourly
# mirror call -- not a parallel implementation -- so a replayed sale and a live
# one cannot end up in different states.
#
# Nothing here writes to GHL. The GHL read goes through the proxy, which is
# where the credentials live.

GAIA_PROXY_BASE = (os.environ.get("GAIA_PROXY_BASE_URL") or "http://127.0.0.1:8787").rstrip("/")


def _ghl_sales_for_product(product_id: str):
    """Every GHL order and invoice containing this exact product id.

    Read-only, and matched on the immutable id alone. Product names are carried
    for display but never matched on -- a renamed product is the same product,
    and treating the new name as a new thing is how history splits in two.
    """
    import urllib.request, urllib.error, urllib.parse
    token = os.environ.get("IDENTITY_SERVICE_TOKEN") or ""
    url = "%s/api/event/ghl-sales?product_id=%s" % (GAIA_PROXY_BASE, urllib.parse.quote(product_id))
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail="Could not read sales from GHL (%s)" % e.code)
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail="Could not read sales from GHL: %s" % e)


def _mr_eligible(sales):
    """Split GHL sales into what may be replayed and what must not be.

    Only settled money creates access. Pending, failed and refunded records are
    excluded and counted, so the preview can say why a number is smaller than
    the raw sale count instead of quietly dropping rows.
    """
    reversed_ids = set((sales.get("reversed") or {}).keys())
    eligible, excluded = [], {"not_paid": 0, "refunded": 0}
    for o in sales.get("orders") or []:
        if o.get("id") in reversed_ids:
            excluded["refunded"] += 1; continue
        if str(o.get("status") or "").lower() != "completed":
            excluded["not_paid"] += 1; continue
        if not (o.get("email") or "").strip():
            excluded["not_paid"] += 1; continue
        eligible.append({"kind": "order", **o})
    for iv in sales.get("invoices") or []:
        if iv.get("id") in reversed_ids:
            excluded["refunded"] += 1; continue
        if str(iv.get("status") or "").lower() not in ("paid", "partially_paid"):
            excluded["not_paid"] += 1; continue
        if not (iv.get("email") or "").strip():
            excluded["not_paid"] += 1; continue
        eligible.append({"kind": "invoice", **iv})
    return eligible, excluded


def _mr_preview(db, event, product_id, ticket_type_id, is_upgrade):
    sales = _ghl_sales_for_product(product_id)
    eligible, excluded = _mr_eligible(sales)

    # What Gaia already holds, keyed on the payment reference -- the only key
    # that is stable. Email would merge two people who share an address.
    held = set()
    for a in db.query(models.Attendee).filter(models.Attendee.event_id == event.id).all():
        cd = a.custom_data or {}
        if cd.get("order_id"):
            held.add(cd["order_id"])
        for e in (cd.get("entitlements") or []):
            ref = e.get("order_id") or e.get("invoice_id")
            if ref:
                held.add(ref)

    seats = 0
    already = 0
    people = set()
    product_name = None
    for row in eligible:
        for it in row.get("items") or []:
            if str(it.get("product_id")) != str(product_id):
                continue
            seats += max(1, int(it.get("qty") or 1))
            product_name = product_name or it.get("name")
        if row.get("id") in held:
            already += 1
        if row.get("email"):
            people.add(row["email"])

    tt = db.query(models.TicketType).filter(
        models.TicketType.id == ticket_type_id).first() if ticket_type_id else None
    return {
        "product_id": product_id,
        "product_name": product_name,
        "ticket_type_id": ticket_type_id,
        "ticket_type_name": tt.name if tt else None,
        "is_upgrade": bool(is_upgrade),
        "successful_payments": len(eligible),
        "total_seats": seats,
        "unique_buyers": len(people),
        "already_in_gaia": already,
        "expected_to_create_or_update": len(eligible) - already,
        "excluded": {"not_paid_or_pending": excluded["not_paid"],
                     "refunded_or_reversed": excluded["refunded"]},
        # An upgrade adds revenue and a tier, never a head or a seat. Saying so
        # on the confirmation screen is the whole point of showing it first.
        "counts_as_seats": (not is_upgrade),
        "note": ("This product is mapped as an UPGRADE: replaying it changes tiers "
                 "and revenue, and adds no attendees or paid seats."
                 if is_upgrade else
                 "This product is mapped as a BASE ticket: replaying it may add "
                 "attendees and paid seats."),
    }


# --- Ticket metrics ---------------------------------------------------------
# One number called "purchases" is what let an upgrade look like another ticket.
# These figures are deliberately separate, and the identity that ties them
# together is printed with them:
#
#   original ticket purchases + repeat base payments + upgrade payments
#     = total economic events
#
# An upgrade adds revenue and a tier. It does not add a head or a seat.

REPEAT_DUPLICATE_WINDOW_MIN = 15


def _tm_classify(entitlements, upgrade_tt_ids, upgrade_pids):
    """Split one attendee's paid ledger into the categories that mean different
    things. Classification is driven by the mapping (is this product an upgrade?)
    and by the purchase timing GHL recorded -- never by ordering alone, because
    "the second payment is an upgrade" is simply not true."""
    paid = [e for e in (entitlements or []) if e.get("status") != "refunded"]
    out = {"base": [], "upgrade": [], "repeat": []}
    seen_base_products = {}
    for e in sorted(paid, key=lambda x: (x.get("purchased_at") or x.get("ts") or "")):
        pid = e.get("product_id")
        is_up = bool(e.get("is_upgrade")) or (pid and pid in upgrade_pids) \
            or (e.get("ticket_type_id") in upgrade_tt_ids and pid is None and False)
        if is_up:
            out["upgrade"].append(e)
            continue
        key = pid or e.get("ticket_type_id")
        if key in seen_base_products:
            first = seen_base_products[key]
            gap = None
            try:
                a = (first.get("purchased_at") or first.get("ts") or "")[:19]
                b = (e.get("purchased_at") or e.get("ts") or "")[:19]
                if a and b:
                    gap = abs((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()) / 60.0
            except Exception:                       # noqa: BLE001
                gap = None
            same_amount = (e.get("amount") is not None and first.get("amount") is not None
                           and abs(float(e["amount"]) - float(first["amount"])) < 0.01)
            if gap is not None and gap <= REPEAT_DUPLICATE_WINDOW_MIN and same_amount:
                kind = "duplicate_suspected"
            elif gap is not None and gap > 1440:
                kind = "additional_paid_seat"
            else:
                kind = "needs_review"
            out["repeat"].append({**e, "repeat_kind": kind, "gap_minutes": gap})
        else:
            seen_base_products[key] = e
            out["base"].append(e)
    return out


@app.get("/events/{event_id}/ticket-metrics")
def ticket_metrics(event_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Unambiguous figures. Never one blended "purchases" count."""
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")

    maps = db.query(models.TicketMapping).filter(
        models.TicketMapping.event_id == event_id,
        models.TicketMapping.is_active == True).all()   # noqa: E712
    upgrade_pids = {m.external_product_id for m in maps if m.is_upgrade}
    upgrade_tt_ids = {m.ticket_type_id for m in maps if m.is_upgrade}

    attendees = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()

    people = 0
    comp = 0
    base_n = upgrade_n = 0
    repeats = {"duplicate_suspected": 0, "additional_paid_seat": 0, "needs_review": 0}
    repeat_rows = []
    gross = 0.0
    refunded_amount = 0.0
    refunded_n = 0
    unassigned_seats = 0
    blocked = 0

    for a in attendees:
        cd = a.custom_data or {}
        ents = cd.get("entitlements") or []
        status = _ticket_status(a)
        if status in TICKET_BLOCKED_STATUSES:
            blocked += 1
        else:
            people += 1
        if not ents:
            # No paid ledger at all: comp, staff, speaker, exhibitor or a door
            # registration. Real attendees, but they are not ticket sales.
            comp += 1
        c = _tm_classify(ents, upgrade_tt_ids, upgrade_pids)
        base_n += len(c["base"])
        upgrade_n += len(c["upgrade"])
        for r in c["repeat"]:
            repeats[r["repeat_kind"]] = repeats.get(r["repeat_kind"], 0) + 1
            repeat_rows.append({
                "email": a.email, "name": ("%s %s" % (a.first_name or "", a.last_name or "")).strip(),
                "kind": r["repeat_kind"], "gap_minutes": round(r["gap_minutes"], 1) if r.get("gap_minutes") is not None else None,
                "amount": r.get("amount"), "reference": r.get("order_id") or r.get("invoice_id"),
                "purchased_at": r.get("purchased_at")})
            if r["repeat_kind"] == "additional_paid_seat":
                unassigned_seats += max(1, int(r.get("quantity") or 1))
        for e in ents:
            q = max(1, int(e.get("quantity") or 1))
            if q > 1:
                # Paid for more people than themselves. GHL holds no name for the
                # others, so the seats are counted and left unassigned rather
                # than filled with invented attendees.
                unassigned_seats += q - 1
            if e.get("status") == "refunded":
                refunded_n += 1
                refunded_amount += float(e.get("amount") or 0)
            elif e.get("amount") is not None:
                gross += float(e["amount"])

    return {
        "event_id": event_id,
        "people": {
            "unique_attendees": people,
            "revoked_or_refunded_attendees": blocked,
            "complimentary_or_unpaid": comp,
        },
        "seats": {
            "assigned_paid_seats": people - comp,
            "unassigned_paid_seats": unassigned_seats,
        },
        "payments": {
            "original_ticket_purchases": base_n,
            "upgrade_payments": upgrade_n,
            "repeat_base_payments": sum(repeats.values()),
            "repeat_breakdown": repeats,
            "total_economic_events": base_n + upgrade_n + sum(repeats.values()),
        },
        "money": {
            "gross_event_revenue": round(gross, 2),
            "refunds": round(refunded_amount, 2),
            "refunded_payments": refunded_n,
            "net_event_revenue": round(gross - refunded_amount, 2),
        },
        "needs_review": [r for r in repeat_rows if r["kind"] != "additional_paid_seat"],
        "additional_paid_seats": [r for r in repeat_rows if r["kind"] == "additional_paid_seat"],
        "definitions": {
            "upgrade_payment": "Adds revenue and a tier. Never an attendee or a seat.",
            "original_ticket_purchase": "The first base ticket a person paid for.",
            "repeat_base_payment": "The same person paid for the same base product again. "
                                   "Minutes apart with the same amount is treated as a suspected "
                                   "duplicate charge; days apart as an additional paid seat; "
                                   "anything between is left for a human.",
            "unassigned_paid_seat": "A seat that was paid for but whose occupant GHL does not name.",
        },
    }


@app.post("/events/{event_id}/map-reconcile/preview")
def map_reconcile_preview(event_id: int, payload: schemas.MapReconcileRequest,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    """What WOULD happen. Reads GHL, writes nothing, creates no mapping."""
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.write")
    if not (payload.product_id or "").strip():
        raise HTTPException(status_code=400, detail="A GHL product id is required")
    return {"ok": True, "preview": _mr_preview(db, event, payload.product_id.strip(),
                                               payload.ticket_type_id, payload.is_upgrade)}


@app.post("/events/{event_id}/map-reconcile/apply")
def map_reconcile_apply(event_id: int, payload: schemas.MapReconcileRequest,
                        db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Create the mapping, then replay this product's eligible history through
    the ordinary reconcile path. Idempotent: a second run finds everything
    already present and creates nothing."""
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.write")
    _assert_event_writable(db, event, "reconcile sales into it")
    if not payload.confirm:
        raise HTTPException(status_code=400,
                            detail="Confirmation is required. Review the preview first.")
    product_id = (payload.product_id or "").strip()
    if not product_id:
        raise HTTPException(status_code=400, detail="A GHL product id is required")
    if not payload.ticket_type_id:
        raise HTTPException(status_code=400, detail="Choose the Gaia ticket type this product grants")
    tt = db.query(models.TicketType).filter(
        models.TicketType.id == payload.ticket_type_id,
        models.TicketType.event_id == event.id).first()
    if not tt:
        raise HTTPException(status_code=404, detail="That ticket type is not part of this event")

    preview = _mr_preview(db, event, product_id, payload.ticket_type_id, payload.is_upgrade)

    # The mapping itself, keyed on the immutable product id. Re-mapping the same
    # product updates it rather than creating a rival row.
    mapping = db.query(models.TicketMapping).filter(
        models.TicketMapping.external_product_id == product_id,
        models.TicketMapping.event_id == event.id).first()
    if mapping is None:
        mapping = models.TicketMapping(event_id=event.id, provider="ghl",
                                       external_product_id=product_id)
        db.add(mapping)
    mapping.ticket_type_id = payload.ticket_type_id
    mapping.is_upgrade = bool(payload.is_upgrade)
    mapping.entitlement_type = payload.entitlement_type or "EVENT_TICKET"
    mapping.addon_code = payload.addon_code
    mapping.label = payload.label or preview.get("product_name") or tt.name
    mapping.is_active = True
    db.flush()

    sales = _ghl_sales_for_product(product_id)
    eligible, _excluded = _mr_eligible(sales)
    created = updated = skipped = failed = 0
    details = []
    for row in eligible:
        qty = 1
        for it in row.get("items") or []:
            if str(it.get("product_id")) == str(product_id):
                qty = max(qty, int(it.get("qty") or 1))
        nm = str(row.get("name") or "").split(" ")
        first, last = (nm[0] if nm else ""), " ".join(nm[1:])
        try:
            if row["kind"] == "invoice":
                # Invoices resolve their ticket type from the mapping we just
                # wrote, which is why this runs after the flush.
                res = reconcile_invoice(schemas.ReconcileInvoice(
                    event_id=event.id, email=row["email"], invoice_id=row["id"],
                    contact_id=row.get("contact_id"), product_id=product_id,
                    amount=row.get("amount_paid"), quantity=qty, status="paid",
                    first_name=first, last_name=last,
                    issued_at=str(row.get("created_at") or "")[:10] or None,
                ), db=db, _=True)
            else:
                res = reconcile_attendee(schemas.ReconcileAttendee(
                    event_id=event.id, email=row["email"],
                    ticket_type_id=payload.ticket_type_id,
                    is_upgrade=bool(payload.is_upgrade), addon_code=payload.addon_code,
                    contact_id=row.get("contact_id"), order_id=row["id"],
                    product_id=product_id, quantity=qty, amount=row.get("amount"),
                    purchased_at=str(row.get("created_at") or "")[:10] or None,
                    first_name=first, last_name=last,
                ), db=db, _=True)
            if isinstance(res, dict) and res.get("blocked"):
                skipped += 1
            elif isinstance(res, dict) and res.get("created"):
                created += 1
            else:
                updated += 1
        except HTTPException as e:
            failed += 1
            details.append({"reference": row["id"], "error": str(e.detail)})
        except Exception as e:                       # noqa: BLE001
            failed += 1
            details.append({"reference": row["id"], "error": str(e)})

    run = models.MapReconcileRun(
        event_id=event.id, product_id=product_id,
        product_name=preview.get("product_name"),
        ticket_type_id=payload.ticket_type_id, is_upgrade=bool(payload.is_upgrade),
        entitlement_type=payload.entitlement_type or "EVENT_TICKET",
        preview=preview, result={"failures": details[:50]},
        created=created, updated=updated, skipped=skipped, failed=failed,
        actor_id=current_user.id)
    db.add(run)

    # Anything filed for review under this product is now answered.
    for r in db.query(models.UnmappedSale).filter(
            models.UnmappedSale.product_id == product_id,
            models.UnmappedSale.status == "pending").all():
        r.status = "mapped"
        r.resolved_by = current_user.id
        r.resolved_at = datetime.utcnow()
        r.note = "Mapped to %s and reconciled" % tt.name
    db.commit()

    return {"ok": True, "run_id": run.id, "preview": preview,
            "created": created, "updated": updated,
            "skipped_refunded_or_blocked": skipped, "failed": failed,
            "failures": details[:50]}


@app.get("/events/{event_id}/map-reconcile/runs")
def map_reconcile_runs(event_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """The audit trail: who mapped what, what they were shown, what it did."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    rows = db.query(models.MapReconcileRun).filter(
        models.MapReconcileRun.event_id == event_id).order_by(
        models.MapReconcileRun.created_at.desc()).limit(50).all()
    return {"items": [{
        "id": r.id, "product_id": r.product_id, "product_name": r.product_name,
        "ticket_type_id": r.ticket_type_id, "is_upgrade": bool(r.is_upgrade),
        "created": r.created, "updated": r.updated,
        "skipped": r.skipped, "failed": r.failed,
        "preview": r.preview,
        "at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]}


@app.post("/identity/reconcile-invoice")
def reconcile_invoice(payload: schemas.ReconcileInvoice, db: Session = Depends(get_db),
                      _: bool = Depends(require_service_token)):
    """Turn a PAID GHL invoice for a mapped ticket product into an attendee.

    The same guarantees as the order path, and the same refusals:

      * only paid / partially_paid invoices; anything else is ignored
      * only products positively mapped to a ticket type FOR THIS EVENT — a
        sponsorship, a CRM subscription or a piece of hardware never becomes an
        attendee, however event-sounding its name
      * idempotent on the invoice id, so a replay updates rather than duplicates
      * an existing person keeps their attendee row, their ticket QR and their
        permanent card; an upgrade lifts the tier instead of creating a second
        record
      * no GHL order id is invented — the invoice is recorded as an invoice
    """
    event = db.query(models.Event).filter(models.Event.id == payload.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    _assert_event_writable(db, event, "reconcile an invoice into it")
    if str(payload.status or "").lower() not in ("paid", "partially_paid"):
        return {"ok": False, "reason": "invoice_not_paid", "status": payload.status}
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A contact email is required")
    mapping = db.query(models.TicketMapping).filter(
        models.TicketMapping.event_id == event.id,
        models.TicketMapping.external_product_id == (payload.product_id or ""),
        models.TicketMapping.is_active == True).first()
    if not mapping:
        # Deliberate: an unmapped product is surfaced for review, never guessed
        # into a ticket from its name.
        return {"ok": False, "reason": "product_not_mapped_to_this_event",
                "product_id": payload.product_id}
    tt_id = mapping.ticket_type_id
    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        func.lower(models.Attendee.email) == email).first()
    created = False
    if existing is None:
        existing = models.Attendee(
            event_id=event.id, email=email,
            first_name=payload.first_name or "", last_name=payload.last_name or "",
            phone=payload.phone, ticket_type_id=tt_id,
            custom_data={"contact_id": payload.contact_id, "source": "ghl_invoice"},
            qr_code="ATT-%s" % uuid.uuid4().hex[:12].upper())
        db.add(existing); db.flush()
        stamp_registration(existing, "ghl_invoice", "paid")
        created = True
    custom = dict(existing.custom_data or {})
    if payload.contact_id:
        custom["contact_id"] = payload.contact_id
    already = any((e.get("invoice_id") == payload.invoice_id) for e in (custom.get("entitlements") or []))
    _ent_record(custom, None, payload.transaction_id, tt_id, bool(mapping.is_upgrade),
                event_id=event.id, invoice_id=payload.invoice_id,
                amount=payload.amount, source="ghl_invoice",
                product_id=payload.product_id, quantity=payload.quantity,
                purchased_at=payload.issued_at)
    if not already:
        _ll = list(custom.get("lifecycle") or [])
        _ll.append({"ts": datetime.utcnow().isoformat(), "action": "reconciled_with_ghl_invoice",
                    "actor": "reconcile", "invoice_id": payload.invoice_id,
                    "transaction_id": payload.transaction_id})
        custom["lifecycle"] = _ll
    old_tt = existing.ticket_type_id
    # Tier behaviour matches the order path: a base sets it when unset, an
    # upgrade only ever lifts.
    if custom.get("admin_tier") is None:
        if tt_id and not mapping.is_upgrade and not existing.ticket_type_id:
            existing.ticket_type_id = tt_id
        if tt_id and mapping.is_upgrade and _tt_rank(db, tt_id) >= _tt_rank(db, existing.ticket_type_id):
            existing.ticket_type_id = tt_id
    for f in ("first_name", "last_name", "phone"):
        v = getattr(payload, f)
        if v and not getattr(existing, f):
            setattr(existing, f, v)
    existing.custom_data = custom
    if not existing.ghl_linked_at:
        existing.ghl_linked_at = datetime.utcnow()
    attach_member_identity(db, existing)
    db.commit(); db.refresh(existing)
    return {"ok": True, "created": created, "already": already,
            "attendee_id": existing.id, "qr_code": existing.qr_code,
            "public_token": existing.public_token,
            "ticket_type_id": existing.ticket_type_id,
            "upgraded": bool(existing.ticket_type_id != old_tt and not created)}


@app.post("/identity/reconcile-attendee")
def reconcile_attendee(payload: schemas.ReconcileAttendee, db: Session = Depends(get_db),
                       _: bool = Depends(require_service_token)):
    """Idempotent upsert of an attendee from a reconciled external order. Keyed on
    (event, email); a repeat call updates, never duplicates. Explicit ticket_type_id
    from the mapping — stable, not name-guessing."""
    event = db.query(models.Event).filter(models.Event.id == payload.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    _assert_event_writable(db, event, "reconcile an attendee into it")
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A contact email is required")
    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        func.lower(models.Attendee.email) == email).first()
    # ADD-ON: additive event entitlement (e.g. one-day speaker). Never sets or
    # raises the base tier; idempotent per (order, addon). Creates a base-less
    # attendee if the buyer has no base ticket yet.
    if payload.addon_code:
        att = existing
        created = False
        if att is None:
            att = models.Attendee(event_id=event.id, email=email,
                first_name=payload.first_name or "", last_name=payload.last_name or "",
                phone=payload.phone, ticket_type_id=None,
                custom_data={"contact_id": payload.contact_id, "order_id": payload.order_id, "source": "ghl_reconcile"},
                qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}")
            db.add(att); db.flush(); created = True
        cd = dict(att.custom_data or {})
        already = any(e.get("order_id") == payload.order_id and e.get("addon_code") == payload.addon_code
                      for e in (cd.get("entitlements") or []))
        _ent_record(cd, payload.order_id, None, None, False, addon_code=payload.addon_code, day=payload.day, day_date=payload.day_date, event_id=event.id)
        if not already:
            _ll = list(cd.get("lifecycle") or [])
            _ll.append({"ts": datetime.utcnow().isoformat(), "action": "addon_added", "actor": "reconcile",
                        "addon_code": payload.addon_code, "day": payload.day, "order_id": payload.order_id})
            cd["lifecycle"] = _ll
        if payload.contact_id:
            cd["contact_id"] = payload.contact_id
        att.custom_data = cd
        db.commit(); db.refresh(att)
        return {"ok": True, "created": created, "addon": payload.addon_code,
                "attendee_id": att.id, "qr_code": att.qr_code}
    if existing:
        # A refunded/cancelled/revoked ticket must not be silently revived by the
        # reconciler re-seeing the same completed order. A genuinely new order
        # (different order_id) is allowed to reactivate; the same order is not.
        if not _ticket_active(existing):
            refunded_oids = set((existing.custom_data or {}).get("refunded_order_ids") or [])
            same_order = (not payload.order_id) or (payload.order_id in refunded_oids) \
                or (payload.order_id == (existing.custom_data or {}).get("order_id"))
            if same_order:
                return {"ok": True, "created": False, "upgraded": False,
                        "blocked": True, "status": _ticket_status(existing),
                        "attendee_id": existing.id, "qr_code": existing.qr_code}
            # New paid order for a previously refunded person -> reactivate.
            existing.registration_status = "active"
            _lifecycle_append(existing, "reactivated", actor="reconcile", order_id=payload.order_id)
        custom = dict(existing.custom_data or {})
        if payload.contact_id:
            custom["contact_id"] = payload.contact_id
        if payload.order_id:
            custom["order_id"] = payload.order_id
        # The row already existed — possibly as a walk-in registered ten minutes
        # ago. Record that a real order reconciled onto it; never restate how
        # the person originally arrived.
        custom["ghl_reconciled"] = True
        if not any(e.get("action") == "reconciled_with_ghl_order" and e.get("order_id") == payload.order_id
                   for e in (custom.get("lifecycle") or [])):
            _ll = list(custom.get("lifecycle") or [])
            _ll.append({"ts": datetime.utcnow().isoformat(), "action": "reconciled_with_ghl_order",
                        "actor": "reconcile", "order_id": payload.order_id})
            custom["lifecycle"] = _ll
        old_tt = existing.ticket_type_id
        # Ledger this paid order for refund-aware recalculation.
        _ent_record(custom, payload.order_id, None, payload.ticket_type_id, payload.is_upgrade,
                    event_id=event.id, product_id=payload.product_id,
                    quantity=payload.quantity, amount=payload.amount,
                    purchased_at=getattr(payload, "purchased_at", None))
        _order_refunded = bool(payload.order_id and payload.order_id in set(custom.get("refunded_order_ids") or []))
        # Purchase-side tier behavior is unchanged (base sets if unset; upgrades
        # never downgrade) EXCEPT: an admin override wins, and a refunded order
        # never re-applies its tier (so a re-seen refunded upgrade cannot re-lift).
        if custom.get("admin_tier") is None and not _order_refunded:
            if payload.ticket_type_id and not payload.is_upgrade:
                if not existing.ticket_type_id:
                    existing.ticket_type_id = payload.ticket_type_id
            if payload.ticket_type_id and payload.is_upgrade:
                if _tt_rank(db, payload.ticket_type_id) >= _tt_rank(db, existing.ticket_type_id):
                    if existing.ticket_type_id != payload.ticket_type_id:
                        _ll = list(custom.get("lifecycle") or [])
                        _ll.append({"ts": datetime.utcnow().isoformat(), "action": "upgraded",
                                    "actor": "reconcile", "from_tt": existing.ticket_type_id,
                                    "to_tt": payload.ticket_type_id, "order_id": payload.order_id})
                        custom["lifecycle"] = _ll
                    existing.ticket_type_id = payload.ticket_type_id
        for f in ("first_name", "last_name", "phone"):
            v = getattr(payload, f)
            if v and not getattr(existing, f):
                setattr(existing, f, v)
        existing.custom_data = custom
        # A row that predates these fields gets its original source inferred
        # once, from what it already says about itself.
        stamp_registration(existing, _inferred_source(existing), "paid")
        link_ghl_order(db, existing, payload.order_id)
        attach_member_identity(db, existing)
        db.commit(); db.refresh(existing)
        upgraded = bool(payload.ticket_type_id and existing.ticket_type_id != old_tt)
        if upgraded and existing.ticket_type:
            _notify_ticket_change(db, existing, existing.ticket_type)
        return {"ok": True, "created": False, "upgraded": upgraded,
                "attendee_id": existing.id, "qr_code": existing.qr_code}
    _cd_new = {"contact_id": payload.contact_id, "order_id": payload.order_id, "source": "ghl_reconcile"}
    _ent_record(_cd_new, payload.order_id, None, payload.ticket_type_id, payload.is_upgrade,
                event_id=event.id, product_id=payload.product_id,
                quantity=payload.quantity, amount=payload.amount,
                purchased_at=getattr(payload, "purchased_at", None))
    attendee = models.Attendee(
        event_id=event.id, email=email,
        first_name=payload.first_name or "", last_name=payload.last_name or "",
        phone=payload.phone, ticket_type_id=payload.ticket_type_id,
        custom_data=_cd_new,
        qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}")
    db.add(attendee); db.flush()
    stamp_registration(attendee, "ghl_order", "paid")
    link_ghl_order(db, attendee, payload.order_id)
    attach_member_identity(db, attendee)
    db.commit(); db.refresh(attendee)
    return {"ok": True, "created": True, "upgraded": False,
            "attendee_id": attendee.id, "qr_code": attendee.qr_code,
            "public_token": attendee.public_token}


@app.post("/identity/refund-ticket")
def refund_ticket(payload: schemas.RefundTicket, db: Session = Depends(get_db),
                  _: bool = Depends(require_service_token)):
    """Mark a ticket refunded from an authoritative provider refund (detected by
    the reconciler). Idempotent per order. A FULL refund revokes access; a PARTIAL
    refund is recorded but does NOT revoke (business rule). The QR value is kept
    so history/audit survive; the scanner refuses it via status."""
    email = (payload.email or "").strip().lower()
    _ref_lookup = payload.order_id or payload.invoice_id
    attendee = None

    # The payment reference is tried FIRST and on its own, because it is the only
    # identifier that means "this exact money". The reconciler legitimately calls
    # this with nothing else: most refunds in the account are sponsorships and
    # equipment rather than tickets, and those must resolve to nobody.
    if _ref_lookup:
        _q = db.query(models.Attendee)
        if payload.event_id:
            # A caller that names the event means that event. Without this the
            # scan returned the first holder of the reference anywhere, which is
            # the wrong row the moment two events share a reference.
            _q = _q.filter(models.Attendee.event_id == payload.event_id)
        for a in _q.all():
            _cd = a.custom_data or {}
            if _cd.get("order_id") == _ref_lookup or _cd.get("invoice_id") == _ref_lookup:
                attendee = a; break
            if any((e.get("order_id") or e.get("invoice_id")) == _ref_lookup
                   for e in (_cd.get("entitlements") or [])):
                attendee = a; break

    # Falling back to the PERSON requires actually being given a person. This
    # query used to run with no filter at all when neither email nor event was
    # supplied, so it returned whichever attendee happened to be first in the
    # table -- and a refunded $3,500 sponsorship revoked a stranger's ticket.
    if attendee is None and email:
        q = db.query(models.Attendee).filter(func.lower(models.Attendee.email) == email)
        if payload.event_id:
            q = q.filter(models.Attendee.event_id == payload.event_id)
        attendee = q.first()

    if attendee is None:
        return {"ok": True, "matched": False, "reason": "no_attendee"}

    cd = dict(attendee.custom_data or {})
    seen = set(cd.get("refunded_order_ids") or [])
    # Idempotent per order: once this order has been refunded (whether it dropped
    # the ticket to a lower tier or invalidated it), a repeat delivery is a no-op.
    # A ticket bought on an INVOICE is ledgered under invoice_id, not order_id.
    # Matching on order_id alone made an invoice refund a silent no-op: the
    # person kept full access after their money was returned.
    _ref = payload.order_id or payload.invoice_id
    _already = _ref and (_ref in seen or any(
        (e.get("order_id") or e.get("invoice_id")) == _ref and e.get("status") == "refunded"
        for e in (cd.get("entitlements") or [])))
    if _already:
        return {"ok": True, "matched": True, "changed": False,
                "status": _ticket_status(attendee), "attendee_id": attendee.id}

    is_full = bool(payload.full)
    if payload.amount and payload.amount_refunded is not None:
        is_full = float(payload.amount_refunded) >= float(payload.amount) - 1e-6

    if not is_full:
        _lifecycle_append(attendee, "partial_refund", actor=payload.actor or "reconcile",
                          order_id=payload.order_id, transaction_id=payload.transaction_id,
                          amount=payload.amount, amount_refunded=payload.amount_refunded,
                          reason=payload.reason)
        db.commit()
        return {"ok": True, "matched": True, "changed": True, "partial": True,
                "status": _ticket_status(attendee), "attendee_id": attendee.id}

    if _ref:
        seen.add(_ref)
    cd["refunded_order_ids"] = sorted(seen)
    ents = list(cd.get("entitlements") or [])
    ledger_hit = None
    for e in ents:
        if (e.get("order_id") or e.get("invoice_id")) == _ref:
            e["status"] = "refunded"; ledger_hit = e; break
    cd["entitlements"] = ents
    prev_tt = attendee.ticket_type_id
    # Admin override keeps access at the admin-set tier regardless of payment.
    if cd.get("admin_tier") is not None:
        attendee.custom_data = cd
        _lifecycle_append(attendee, "partial_refund" if False else "refund_recorded",
                          actor=payload.actor or "reconcile", order_id=payload.order_id,
                          transaction_id=payload.transaction_id, note="admin override retained")
        db.commit(); db.refresh(attendee)
        return {"ok": True, "matched": True, "changed": True, "status": _ticket_status(attendee),
                "attendee_id": attendee.id, "qr_code": attendee.qr_code}
    if ledger_hit is not None:
        # Entitlement-aware: restore the highest still-paid tier, or invalidate
        # only if no paid base remains.
        eff, has_base = _ent_effective(db, cd)
        attendee.custom_data = cd
        if eff is not None and has_base:
            attendee.ticket_type_id = eff
            attendee.registration_status = "active"
            _lifecycle_append(attendee, "upgrade_refunded", actor=payload.actor or "reconcile",
                              order_id=payload.order_id, transaction_id=payload.transaction_id,
                              from_tt=prev_tt, to_tt=eff, amount=payload.amount,
                              amount_refunded=payload.amount_refunded, reason=payload.reason)
            db.commit(); db.refresh(attendee)
            try:
                _notify_status(db, attendee, "Upgrade refunded",
                               "Your upgrade was refunded. Your original access has been restored.")
            except Exception:
                pass
            return {"ok": True, "matched": True, "changed": True, "status": "active",
                    "restored_tier": eff, "attendee_id": attendee.id, "qr_code": attendee.qr_code}
        attendee.registration_status = "refunded"
        _lifecycle_append(attendee, "refunded", actor=payload.actor or "reconcile",
                          order_id=payload.order_id, transaction_id=payload.transaction_id,
                          amount=payload.amount, amount_refunded=payload.amount_refunded,
                          reason=payload.reason)
        db.commit(); db.refresh(attendee)
        try:
            _notify_status(db, attendee, "Ticket refunded",
                           "Your ticket has been refunded and is no longer valid for entry.")
        except Exception:
            pass
        return {"ok": True, "matched": True, "changed": True, "status": "refunded",
                "attendee_id": attendee.id, "qr_code": attendee.qr_code}
    # Legacy attendee with no ledger: whole ticket is refunded (previous behavior).
    attendee.custom_data = cd
    attendee.registration_status = "refunded"
    _lifecycle_append(attendee, "refunded", actor=payload.actor or "reconcile",
                      order_id=payload.order_id, transaction_id=payload.transaction_id,
                      amount=payload.amount, amount_refunded=payload.amount_refunded,
                      reason=payload.reason)
    db.commit(); db.refresh(attendee)
    try:
        _notify_status(db, attendee, "Ticket refunded",
                       "Your ticket has been refunded and is no longer valid for entry.")
    except Exception:
        pass
    return {"ok": True, "matched": True, "changed": True, "status": "refunded",
            "attendee_id": attendee.id, "qr_code": attendee.qr_code}


@app.post("/attendees/{attendee_id}/revoke", response_model=schemas.Attendee)
def revoke_attendee(attendee_id: int, payload: schemas.RevokeTicket,
                    db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Admin manually revokes access (fraud, chargeback, comp mistake). Distinct
    from a payment refund: no money moves. Status -> revoked, QR kept, audited."""
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.write")
    attendee.registration_status = "revoked"
    _lifecycle_append(attendee, "revoked", actor=(current_user.email or "admin"),
                      reason=payload.reason)
    db.commit(); db.refresh(attendee)
    return attendee


@app.post("/attendees/{attendee_id}/reinstate", response_model=schemas.Attendee)
def reinstate_attendee(attendee_id: int, payload: schemas.RevokeTicket,
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """Admin reinstates a refunded/revoked/cancelled ticket back to active, audited."""
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.write")
    prev = _ticket_status(attendee)
    attendee.registration_status = "active"
    _lifecycle_append(attendee, "reinstated", actor=(current_user.email or "admin"),
                      reason=payload.reason, **{"from": prev})
    db.commit(); db.refresh(attendee)
    return attendee


@app.post("/attendees/{attendee_id}/change-pass", response_model=schemas.Attendee)
def change_pass(attendee_id: int, payload: schemas.ChangePass,
                db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    """Admin changes an attendee's pass (comp upgrade, or explicit downgrade).

    Never a second attendee, always the same QR. A complimentary change records
    that no payment occurred. Downgrades are refused unless allow_downgrade is
    set, so a mis-click cannot strip a paid VIP. Fully audited (old->new, who,
    reason) and the attendee is notified of the new access."""
    attendee = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not attendee:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, attendee.event_id, "attendee.write")
    tt = db.query(models.TicketType).filter(
        models.TicketType.id == payload.ticket_type_id,
        models.TicketType.event_id == attendee.event_id).first()
    if not tt:
        raise HTTPException(status_code=400, detail="That pass does not belong to this event")
    old_tt = attendee.ticket_type_id
    if old_tt == tt.id:
        return attendee
    is_downgrade = _tt_rank(db, tt.id) < _tt_rank(db, old_tt)
    if is_downgrade and not payload.allow_downgrade:
        raise HTTPException(status_code=409,
                            detail="This is a downgrade. Re-submit with allow_downgrade to confirm.")
    attendee.ticket_type_id = tt.id
    _cp_cd = dict(attendee.custom_data or {}); _cp_cd["admin_tier"] = tt.id
    attendee.custom_data = _cp_cd
    _lifecycle_append(attendee, "comp_downgrade" if is_downgrade else "comp_upgrade",
                      actor=(current_user.email or "admin"), from_tt=old_tt, to_tt=tt.id,
                      complimentary=bool(payload.complimentary), reason=payload.reason)
    db.commit(); db.refresh(attendee)
    try:
        _notify_ticket_change(db, attendee, tt)
    except Exception:
        pass
    return attendee


@app.get("/events/{event_id}/roles")
def list_roles(event_id: int, db: Session = Depends(get_db),
               current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    rows = db.query(models.EventRole).filter(models.EventRole.event_id == event_id).all()
    return [{"id": r.id, "role": r.role,
             "email": r.user.email if r.user else "",
             "full_name": (r.user.full_name or "") if r.user else ""} for r in rows]


@app.post("/events/{event_id}/roles")
def grant_role(event_id: int, payload: schemas.RoleGrant,
               db: Session = Depends(get_db),
               current_user: models.User = Depends(get_current_user)):
    """Give one person one role at this event, creating their account if new.

    Grantable roles only — is_admin is never reachable from here, so an
    organiser can staff their own event but cannot mint another platform owner.
    """
    _get_event_or_404(event_id, db)
    if not authz.can(db, current_user, event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    if payload.role not in authz.GRANTABLE_ROLES:
        raise HTTPException(status_code=400, detail="Unknown role")
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required")

    user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
    if not user:
        if not payload.password or len(payload.password) < 10:
            raise HTTPException(status_code=400,
                                detail="New account: a password of at least 10 characters is required")
        user = models.User(email=email, full_name=payload.full_name or "",
                           hashed_password=get_password_hash(payload.password),
                           is_admin=False)
        db.add(user)
        db.commit()
        db.refresh(user)

    existing = db.query(models.EventRole).filter(
        models.EventRole.user_id == user.id,
        models.EventRole.event_id == event_id,
        models.EventRole.role == payload.role).first()
    if existing:
        return {"ok": True, "already": True, "id": existing.id}
    row = models.EventRole(user_id=user.id, event_id=event_id, role=payload.role)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "already": False, "id": row.id}


@app.delete("/roles/{role_id}")
def revoke_role(role_id: int, db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    row = db.query(models.EventRole).filter(models.EventRole.id == role_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Role not found")
    if not authz.can(db, current_user, row.event_id, "event.write"):
        raise HTTPException(status_code=403, detail="Not authorized for this event")
    db.delete(row)
    db.commit()
    return {"ok": True}


@app.get("/public/events/{event_id}/announcements", response_model=List[schemas.AnnouncementPublic])
def get_public_announcements(event_id: int, db: Session = Depends(get_db)):
    """Organiser updates, newest first. Available whether or not live mode is on:
    the useful ones (travel, hotel block, schedule published) go out weeks before
    anyone is standing in the venue."""
    _published_event_or_404(event_id, db)
    now = datetime.utcnow()
    rows = db.query(models.Announcement).filter(
        models.Announcement.event_id == event_id,
        models.Announcement.is_published == True,
        ((models.Announcement.scheduled_for == None) | (models.Announcement.scheduled_for <= now)),
    ).order_by(models.Announcement.is_pinned.desc(), models.Announcement.created_at.desc()).limit(20).all()
    # An unidentified public viewer only sees untargeted announcements; anything
    # aimed at VIPs / a pass / checked-in people is withheld here and served,
    # filtered, through the identity-aware endpoint below.
    return [a for a in rows if not (a.audience and (a.audience.get("type") or "all") != "all")]


def _announcement_matches(aud, *, is_vip, ticket_type_id, is_checked_in):
    """Is one announcement's audience filter satisfied by this viewer? Unknown
    audience types fail closed so a targeted note is never leaked by accident."""
    t = (aud or {}).get("type") or "all"
    if t == "all":
        return True
    if t == "vip":
        return bool(is_vip)
    if t == "ticket_type":
        return ticket_type_id is not None and str(ticket_type_id) == str((aud or {}).get("ticket_type_id"))
    if t == "checked_in":
        return bool(is_checked_in)
    return False


@app.post("/identity/events/{event_id}/announcements")
def identity_announcements(event_id: int, payload: schemas.IdentityLookup,
                           db: Session = Depends(get_db),
                           _: bool = Depends(require_service_token)):
    """Announcements this person is allowed to see, audience-filtered from their
    real ticket. A VIP-only note never reaches a General attendee — the filter
    runs server-side on trustworthy attendee data, not in the app."""
    event = _published_event_or_404(event_id, db)
    attendees, evidence, report = identity_lib.resolve_attendees(
        db, contact_id=payload.contact_id, email=payload.email,
        email_verified=bool(payload.email_verified))
    attendee = next((a for a in attendees if a.event_id == event_id), None)
    ticket_type_id = attendee.ticket_type_id if attendee else None
    is_vip = bool(attendee and attendee.ticket_type and attendee.ticket_type.is_vip)
    is_checked_in = bool(attendee and attendee.is_checked_in)
    now = datetime.utcnow()
    rows = db.query(models.Announcement).filter(
        models.Announcement.event_id == event_id,
        models.Announcement.is_published == True,
        ((models.Announcement.scheduled_for == None) | (models.Announcement.scheduled_for <= now)),
    ).order_by(models.Announcement.is_pinned.desc(), models.Announcement.created_at.desc()).limit(30).all()
    out = [{"id": a.id, "title": a.title, "body": a.body, "is_pinned": bool(a.is_pinned),
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "audience": a.audience or None}
           for a in rows
           if _announcement_matches(a.audience, is_vip=is_vip,
                                    ticket_type_id=ticket_type_id, is_checked_in=is_checked_in)]
    return {"ok": True, "announcements": out,
            "viewer": {"has_ticket": attendee is not None, "is_vip": is_vip,
                       "ticket_type_id": ticket_type_id, "is_checked_in": is_checked_in}}


@app.get("/public/events/{event_id}/sponsors", response_model=List[schemas.SponsorPublic])
def get_public_sponsors(event_id: int, db: Session = Depends(get_db)):
    _published_event_or_404(event_id, db)
    return _published_sponsors(event_id, db)


# ---------------------------------------------------------------------------
# The live surface: one endpoint behind the in-app live panel and the lobby
# display. Both read the same numbers, so a screen in the foyer and a phone in
# the hall never disagree.
# ---------------------------------------------------------------------------

TIER_ORDER = {"headline": 0, "gold": 1, "silver": 2, "partner": 3}


def _published_sponsors(event_id: int, db: Session):
    sponsors = db.query(models.Sponsor).filter(
        models.Sponsor.event_id == event_id,
        models.Sponsor.is_published == True,
    ).all()
    return sorted(sponsors, key=lambda s: (TIER_ORDER.get((s.tier or "partner").lower(), 9), s.sort_order or 0, s.name or ""))


def venue_now(event: models.Event) -> datetime:
    """Wall-clock time at the venue, as a naive datetime matching how session
    times are stored. The server's own timezone is irrelevant."""
    try:
        return datetime.now(ZoneInfo(event.timezone or "UTC")).replace(tzinfo=None)
    except Exception:
        return datetime.utcnow()


# ---- Push notifications (web push / VAPID) ----------------------------------
# Multi-event: subscribe + send are scoped to one event_id, so this serves the
# current event and every future event built with the Event Builder.
@app.get("/public/push/vapid-key")
def public_push_vapid_key():
    return {"key": push_lib.application_server_key(), "configured": push_lib.push_configured()}


@app.post("/identity/push/subscribe")
def identity_push_subscribe(
    payload: schemas.PushSubscribe,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    attendees, _evidence, _report = identity_lib.resolve_attendees(
        db, contact_id=payload.contact_id, email=payload.email,
        email_verified=bool(payload.email_verified),
    )
    target = next((a for a in attendees if a.event_id == payload.event_id), None)
    if not target:
        return {"ok": False, "reason": "no_attendee_for_event"}
    sub = payload.subscription or {}
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not (endpoint and p256dh and auth):
        raise HTTPException(status_code=400, detail="Invalid subscription")
    existing = db.query(models.PushSubscription).filter(
        models.PushSubscription.attendee_id == target.id,
        models.PushSubscription.endpoint == endpoint,
    ).first()
    if existing:
        existing.p256dh = p256dh
        existing.auth = auth
    else:
        db.add(models.PushSubscription(
            attendee_id=target.id, event_id=target.event_id,
            endpoint=endpoint, p256dh=p256dh, auth=auth,
        ))
    db.commit()
    return {"ok": True}


@app.post("/identity/push/unsubscribe")
def identity_push_unsubscribe(
    payload: schemas.PushUnsubscribe,
    db: Session = Depends(get_db),
    _: bool = Depends(require_service_token),
):
    if payload.endpoint:
        db.query(models.PushSubscription).filter(
            models.PushSubscription.endpoint == payload.endpoint
        ).delete()
        db.commit()
    return {"ok": True}


@app.post("/events/{event_id}/notifications")
def send_event_notification(
    event_id: int,
    payload: schemas.NotificationSend,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    event = db.query(models.Event).filter(models.Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event_id, "event.write")
    q = db.query(models.PushSubscription).filter(models.PushSubscription.event_id == event_id)
    aud = payload.audience or {}
    atype = aud.get("type") or "all"
    if atype == "ticket_type" and aud.get("ticket_type_id"):
        q = q.join(models.Attendee, models.Attendee.id == models.PushSubscription.attendee_id).filter(
            models.Attendee.ticket_type_id == int(aud["ticket_type_id"]))
    elif atype == "checked_in":
        q = q.join(models.Attendee, models.Attendee.id == models.PushSubscription.attendee_id).filter(
            models.Attendee.is_checked_in == True)  # noqa: E712
    elif atype == "session" and aud.get("session_id"):
        q = q.join(models.SavedSession, models.SavedSession.attendee_id == models.PushSubscription.attendee_id).filter(
            models.SavedSession.session_id == int(aud["session_id"]))
    subs = q.all()
    default_url = "https://gaiahealers.app/home.html?view=events&event=" + str(event_id)
    body_payload = {"title": payload.title, "body": payload.body,
                    "url": payload.url or default_url, "eventId": event_id}
    sent = 0
    failed = 0
    gone = []
    for sub in subs:
        ok, is_gone = push_lib.send_one(sub.endpoint, sub.p256dh, sub.auth, body_payload)
        if ok:
            sent += 1
        else:
            failed += 1
            if is_gone:
                gone.append(sub.id)
    if gone:
        db.query(models.PushSubscription).filter(
            models.PushSubscription.id.in_(gone)).delete(synchronize_session=False)
    if payload.also_announce:
        db.add(models.Announcement(event_id=event_id, title=payload.title,
                                   body=payload.body, is_pinned=False, is_published=True))
    db.commit()
    return {"ok": True, "targeted": len(subs), "sent": sent, "failed": failed}


@app.get("/public/events/{event_id}/live", response_model=schemas.LiveEvent)
def get_public_live(event_id: int, db: Session = Depends(get_db)):
    event = _published_event_or_404(event_id, db)
    now = venue_now(event)

    sessions = db.query(models.Session).filter(
        models.Session.event_id == event_id,
        models.Session.is_published == True,
        models.Session.start_time != None,
    ).order_by(models.Session.start_time.asc()).all()

    running, upcoming = [], []
    for session in sessions:
        start, end = session.start_time, session.end_time
        payload = schemas.LiveSession.model_validate(session)
        if start <= now and end and end > now:
            payload.minutes_remaining = max(0, int((end - now).total_seconds() // 60))
            running.append(payload)
        elif start > now:
            payload.minutes_until = max(0, int((start - now).total_seconds() // 60))
            upcoming.append(payload)

    attendees = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).count()
    checked_in = db.query(models.Attendee).filter(
        models.Attendee.event_id == event_id, models.Attendee.is_checked_in == True
    ).count()

    if event.start_date and now < event.start_date:
        status = "before"
    elif event.end_date and now > event.end_date:
        status = "ended"
    else:
        status = "running"

    return schemas.LiveEvent(
        event_id=event.id,
        event_name=event.name,
        timezone=event.timezone or "UTC",
        live_enabled=bool(event.live_enabled),
        live_message=event.live_message or None,
        server_time=now.isoformat(timespec="seconds"),
        today=now.date().isoformat(),
        status=status,
        now=running,
        next=upcoming[:3],
        counters=schemas.LiveCounters(
            # How many people bought and how many turned up is commercially
            # sensitive — an event that sold poorly should not announce it to
            # every visitor. Private unless the organiser switches it on for
            # this event, e.g. for a lobby screen. The room-level figures below
            # (exhibitors, sponsors, sessions today) are on the programme
            # anyway and stay public.
            attendees=attendees if event.public_counters else None,
            checked_in=checked_in if event.public_counters else None,
            check_in_rate=(int(round((checked_in / attendees) * 100)) if attendees else 0)
            if event.public_counters else None,
            exhibitors=db.query(models.Exhibitor).filter(
                models.Exhibitor.event_id == event_id, models.Exhibitor.is_published == True).count(),
            sponsors=len(_published_sponsors(event_id, db)),
            speakers=db.query(models.Speaker).filter(
                models.Speaker.event_id == event_id, models.Speaker.is_published == True).count(),
            leads=db.query(models.Lead).join(
                models.Exhibitor, models.Lead.exhibitor_id == models.Exhibitor.id
            ).filter(models.Exhibitor.event_id == event_id).count(),
            sessions_today=sum(1 for s in sessions if s.start_time.date() == now.date()),
        ),
        announcements=db.query(models.Announcement).filter(
            models.Announcement.event_id == event_id,
            models.Announcement.is_published == True,
        ).order_by(models.Announcement.is_pinned.desc(), models.Announcement.created_at.desc()).limit(5).all(),
        sponsors=_published_sponsors(event_id, db),
    )




# ===========================================================================
# Event community feed — moderated public board (see models.EventPost).
# Signed-in members post via the identity proxy; everyone reads; organizers
# pin announcements and moderate. Post-moderation: posts show immediately,
# admins hide/delete/suspend after, members can report.
# ===========================================================================
POST_MAX_LEN = 1200
POST_RATE_WINDOW_SEC = 60
POST_RATE_MAX = 6
_BANNED_WORDS = {"fuck", "shit", "bitch", "cunt", "asshole", "nigger", "faggot", "retard", "motherfucker"}
_BANNED_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in _BANNED_WORDS) + r")\b", re.IGNORECASE)


def _post_member_key(payload) -> str:
    """A post needs a stable member id to attribute, like, report and moderate
    against. The proxy proves identity; we key on the GHL contact id."""
    return (getattr(payload, "contact_id", None) or "").strip()


def _mask_profanity(text: str) -> str:
    return _BANNED_RE.sub(lambda m: m.group(0)[0] + "•" * (len(m.group(0)) - 1), text)


def _is_suspended(db, event_id, key) -> bool:
    if not key:
        return False
    return db.query(models.EventCommunityBan).filter(
        models.EventCommunityBan.event_id == event_id,
        models.EventCommunityBan.member_key == key).first() is not None


def _post_dict(p, viewer_key="", db=None) -> dict:
    liked = False
    if viewer_key and db is not None:
        liked = db.query(models.EventPostLike).filter(
            models.EventPostLike.post_id == p.id,
            models.EventPostLike.member_key == viewer_key).first() is not None
    return {
        "id": p.id,
        "author_name": p.author_name or "Member",
        "author_photo": p.author_photo or "",
        "body": p.body or "",
        "image_url": p.image_url or "",
        "is_announcement": bool(p.is_announcement),
        "is_pinned": bool(p.is_pinned),
        "like_count": int(p.like_count or 0),
        "report_count": int(p.report_count or 0),
        "created_at": (p.created_at.isoformat() + "Z") if p.created_at else None,
        "liked": liked,
        "is_own": bool(viewer_key and p.author_key == viewer_key),
        "parent_id": p.parent_id,
    }


def _visible_posts(db, event_id, since=0, limit=60):
    q = db.query(models.EventPost).filter(
        models.EventPost.event_id == event_id,
        models.EventPost.is_hidden == False,  # noqa: E712
        models.EventPost.parent_id == None)  # noqa: E711
    if since:
        q = q.filter(models.EventPost.id > since)
    return q.order_by(models.EventPost.is_pinned.desc(),
                      models.EventPost.created_at.desc()).limit(min(max(limit, 1), 100)).all()


def _visible_replies(db, parent_id):
    return db.query(models.EventPost).filter(
        models.EventPost.parent_id == parent_id,
        models.EventPost.is_hidden == False).order_by(  # noqa: E712
        models.EventPost.created_at.asc()).all()


def _feed_dict(db, p, viewer_key):
    d = _post_dict(p, viewer_key, db)
    replies = _visible_replies(db, p.id)
    d["reply_count"] = len(replies)
    d["replies"] = [_post_dict(r, viewer_key, db) for r in replies]
    return d


@app.get("/public/events/{event_id}/posts")
def public_posts(event_id: int, since: int = 0, limit: int = 60, db: Session = Depends(get_db)):
    _get_event_or_404(event_id, db)
    posts = _visible_posts(db, event_id, since, limit)
    return {"ok": True, "posts": [_feed_dict(db, p, "") for p in posts]}


@app.post("/identity/events/{event_id}/posts/feed")
def identity_posts_feed(event_id: int, payload: schemas.PostFeedRequest,
                        db: Session = Depends(get_db), _: bool = Depends(require_service_token)):
    _get_event_or_404(event_id, db)
    key = _post_member_key(payload)
    posts = _visible_posts(db, event_id, payload.since, payload.limit)
    return {"ok": True, "posts": [_feed_dict(db, p, key) for p in posts],
            "suspended": _is_suspended(db, event_id, key)}


def _notify_reply(db, event_id, parent, replier_name):
    """Best-effort push to the author of the post being replied to, if they
    are an attendee of this event with a live push subscription."""
    cid = (parent.author_contact_id or parent.author_key or "").strip()
    if not cid or cid == "__organizer__":
        return
    try:
        attendees, _e, _r = identity_lib.resolve_attendees(db, contact_id=cid, email=None, email_verified=False)
    except Exception:
        return
    target = next((a for a in attendees if a.event_id == event_id), None)
    if not target:
        return
    subs = db.query(models.PushSubscription).filter(models.PushSubscription.attendee_id == target.id).all()
    if not subs:
        return
    payload = {"title": "New reply",
               "body": (replier_name or "Someone") + " replied to your post",
               "url": "https://gaiahealers.app/home.html?view=events&event=" + str(event_id) + "&tab=community",
               "eventId": event_id}
    gone = []
    for sub in subs:
        try:
            ok, is_gone = push_lib.send_one(sub.endpoint, sub.p256dh, sub.auth, payload)
        except Exception:
            ok, is_gone = False, False
        if not ok and is_gone:
            gone.append(sub.id)
    if gone:
        db.query(models.PushSubscription).filter(models.PushSubscription.id.in_(gone)).delete(synchronize_session=False)
        db.commit()


@app.post("/identity/events/{event_id}/posts")
def identity_create_post(event_id: int, payload: schemas.PostCreate,
                         db: Session = Depends(get_db), _: bool = Depends(require_service_token)):
    _get_event_or_404(event_id, db)
    key = _post_member_key(payload)
    if not key:
        raise HTTPException(status_code=403, detail="Sign in to post")
    if _is_suspended(db, event_id, key):
        raise HTTPException(status_code=403, detail="You have been suspended from posting in this event")
    body = (payload.body or "").strip()[:POST_MAX_LEN]
    image_url = (payload.image_url or "").strip()[:600]
    if image_url and POST_MEDIA_PATH not in image_url:
        image_url = ""
    if not body and not image_url:
        raise HTTPException(status_code=400, detail="Write something to post")
    since = datetime.utcnow() - timedelta(seconds=POST_RATE_WINDOW_SEC)
    recent = db.query(models.EventPost).filter(
        models.EventPost.event_id == event_id,
        models.EventPost.author_key == key,
        models.EventPost.created_at >= since).count()
    if recent >= POST_RATE_MAX:
        raise HTTPException(status_code=429, detail="You're posting too fast — take a breath")
    name = (payload.author_name or "").strip()[:60] or "Member"
    parent_id = getattr(payload, "parent_id", None)
    if parent_id:
        parent = db.query(models.EventPost).filter(
            models.EventPost.id == int(parent_id),
            models.EventPost.event_id == event_id).first()
        if not parent or parent.parent_id is not None:
            raise HTTPException(status_code=400, detail="That post can't be replied to")
        parent_id = int(parent_id)
    else:
        parent_id = None
    post = models.EventPost(
        event_id=event_id, author_key=key, author_name=name,
        author_photo=(payload.author_photo or "").strip()[:400],
        author_contact_id=(payload.contact_id or ""),
        body=_mask_profanity(body), image_url=image_url,
        is_announcement=False, is_pinned=False, is_hidden=False,
        parent_id=parent_id, like_count=0, report_count=0)
    db.add(post)
    db.commit()
    db.refresh(post)
    if parent_id and parent.author_key != key:
        try:
            _notify_reply(db, event_id, parent, name)
        except Exception:
            pass
    return {"ok": True, "post": _post_dict(post, key, db)}


@app.post("/identity/events/{event_id}/posts/{post_id}/like")
def identity_like_post(event_id: int, post_id: int, payload: schemas.PostInteract,
                       db: Session = Depends(get_db), _: bool = Depends(require_service_token)):
    key = _post_member_key(payload)
    if not key:
        raise HTTPException(status_code=403, detail="Sign in to react")
    post = db.query(models.EventPost).filter(
        models.EventPost.id == post_id, models.EventPost.event_id == event_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    existing = db.query(models.EventPostLike).filter(
        models.EventPostLike.post_id == post_id, models.EventPostLike.member_key == key).first()
    if existing:
        db.delete(existing)
        liked = False
    else:
        db.add(models.EventPostLike(post_id=post_id, member_key=key))
        liked = True
    db.flush()
    post.like_count = db.query(models.EventPostLike).filter(models.EventPostLike.post_id == post_id).count()
    db.commit()
    return {"ok": True, "liked": liked, "like_count": post.like_count}


@app.post("/identity/events/{event_id}/posts/{post_id}/report")
def identity_report_post(event_id: int, post_id: int, payload: schemas.PostInteract,
                         db: Session = Depends(get_db), _: bool = Depends(require_service_token)):
    key = _post_member_key(payload)
    if not key:
        raise HTTPException(status_code=403, detail="Sign in to report")
    post = db.query(models.EventPost).filter(
        models.EventPost.id == post_id, models.EventPost.event_id == event_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    exists = db.query(models.EventPostReport).filter(
        models.EventPostReport.post_id == post_id, models.EventPostReport.reporter_key == key).first()
    if not exists:
        db.add(models.EventPostReport(post_id=post_id, reporter_key=key, reason=(payload.reason or "")[:200]))
        db.flush()
        post.report_count = db.query(models.EventPostReport).filter(models.EventPostReport.post_id == post_id).count()
        db.commit()
    return {"ok": True, "reported": True}


# ---- admin moderation (JWT) ----
@app.get("/events/{event_id}/posts")
def admin_list_posts(event_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    posts = db.query(models.EventPost).filter(models.EventPost.event_id == event_id).order_by(
        models.EventPost.is_pinned.desc(), models.EventPost.created_at.desc()).all()
    out = []
    for p in posts:
        d = _post_dict(p)
        d["is_hidden"] = bool(p.is_hidden)
        d["author_contact_id"] = p.author_contact_id or ""
        d["author_key"] = p.author_key or ""
        out.append(d)
    return {"ok": True, "posts": out}


@app.post("/posts/{post_id}/moderate")
def admin_moderate_post(post_id: int, payload: dict = Body(default={}),
                        db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    post = db.query(models.EventPost).filter(models.EventPost.id == post_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    authz.require_cap(db, current_user, post.event_id, "event.write")
    action = (payload or {}).get("action")
    if action == "hide":
        post.is_hidden = True
    elif action == "unhide":
        post.is_hidden = False
    elif action == "pin":
        post.is_pinned = True
    elif action == "unpin":
        post.is_pinned = False
    elif action == "clear_reports":
        db.query(models.EventPostReport).filter(models.EventPostReport.post_id == post_id).delete()
        post.report_count = 0
    elif action == "delete":
        children = db.query(models.EventPost).filter(models.EventPost.parent_id == post_id).all()
        all_ids = [post_id] + [c.id for c in children]
        db.query(models.EventPostLike).filter(models.EventPostLike.post_id.in_(all_ids)).delete(synchronize_session=False)
        db.query(models.EventPostReport).filter(models.EventPostReport.post_id.in_(all_ids)).delete(synchronize_session=False)
        for c in children:
            db.delete(c)
        db.delete(post)
        db.commit()
        return {"ok": True, "deleted": True}
    else:
        raise HTTPException(status_code=400, detail="Unknown action")
    db.commit()
    return {"ok": True}


def _broadcast_push(db, event_id, title, body, url=None):
    """Fan a community announcement out to this event's push subscribers,
    reusing the same web-push path as the Notify tab."""
    subs = db.query(models.PushSubscription).filter(models.PushSubscription.event_id == event_id).all()
    if not subs:
        return 0
    default_url = url or ("https://gaiahealers.app/home.html?view=events&event=" + str(event_id) + "&tab=community")
    payload = {"title": (title or "Announcement")[:80], "body": (body or "")[:180],
               "url": default_url, "eventId": event_id}
    sent = 0
    gone = []
    for sub in subs:
        try:
            ok, is_gone = push_lib.send_one(sub.endpoint, sub.p256dh, sub.auth, payload)
        except Exception:
            ok, is_gone = False, False
        if ok:
            sent += 1
        elif is_gone:
            gone.append(sub.id)
    if gone:
        db.query(models.PushSubscription).filter(
            models.PushSubscription.id.in_(gone)).delete(synchronize_session=False)
        db.commit()
    return sent


@app.post("/events/{event_id}/announce")
def admin_announce(event_id: int, payload: dict = Body(default={}),
                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    body = ((payload or {}).get("body") or "").strip()[:POST_MAX_LEN]
    if not body:
        raise HTTPException(status_code=400, detail="Announcement needs a message")
    name = ((payload or {}).get("author_name") or "Organizer").strip()[:60]
    post = models.EventPost(event_id=event_id, author_key="__organizer__", author_name=name,
                            author_photo="", author_contact_id="", body=body,
                            is_announcement=True, is_pinned=True, is_hidden=False,
                            like_count=0, report_count=0)
    db.add(post)
    db.commit()
    db.refresh(post)
    pushed = 0
    try:
        pushed = _broadcast_push(db, event_id, "\U0001F4E3 " + (event.name or "Announcement"), body)
    except Exception:
        pushed = 0
    return {"ok": True, "post": _post_dict(post), "pushed": pushed}


@app.post("/events/{event_id}/community/suspend")
def admin_suspend(event_id: int, payload: dict = Body(default={}),
                  db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    key = ((payload or {}).get("member_key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="member_key required")
    name = ((payload or {}).get("author_name") or "").strip()[:60]
    if not db.query(models.EventCommunityBan).filter(
            models.EventCommunityBan.event_id == event_id,
            models.EventCommunityBan.member_key == key).first():
        db.add(models.EventCommunityBan(event_id=event_id, member_key=key, author_name=name))
        db.query(models.EventPost).filter(
            models.EventPost.event_id == event_id,
            models.EventPost.author_key == key).update({"is_hidden": True})
        db.commit()
    return {"ok": True, "suspended": True}


@app.post("/events/{event_id}/community/unsuspend")
def admin_unsuspend(event_id: int, payload: dict = Body(default={}),
                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.write")
    key = ((payload or {}).get("member_key") or "").strip()
    ban = db.query(models.EventCommunityBan).filter(
        models.EventCommunityBan.event_id == event_id,
        models.EventCommunityBan.member_key == key).first()
    if ban:
        db.delete(ban)
        db.commit()
    return {"ok": True}


@app.get("/events/{event_id}/community/bans")
def admin_list_bans(event_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "event.read")
    bans = db.query(models.EventCommunityBan).filter(
        models.EventCommunityBan.event_id == event_id).order_by(
        models.EventCommunityBan.created_at.desc()).all()
    return {"ok": True, "bans": [{"id": b.id, "member_key": b.member_key, "author_name": b.author_name,
            "created_at": (b.created_at.isoformat() + "Z") if b.created_at else None} for b in bans]}




# ---- Community feed: post image upload + serving ----------------------------
POST_IMAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "posts")
os.makedirs(POST_IMAGE_DIR, exist_ok=True)
_POST_IMAGE_EXT = {"image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/png": ".png",
                   "image/webp": ".webp", "image/gif": ".gif"}
POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024
POST_MEDIA_PATH = "/public/posts/media/"
EVENT_API_PUBLIC_BASE = os.getenv("EVENT_API_PUBLIC_BASE", "https://api.gaiahealers.app/event-api").rstrip("/")


@app.post("/identity/events/{event_id}/posts/image")
async def identity_post_image(event_id: int, request: FastAPIRequest,
                              file: UploadFile = File(...),
                              db: Session = Depends(get_db),
                              _: bool = Depends(require_service_token)):
    """Store one image for a post. The proxy proves who is uploading via the
    contact id on the query string; only a signed-in, non-suspended member may."""
    _get_event_or_404(event_id, db)
    contact_id = (request.query_params.get("contact_id") or "").strip()
    if not contact_id:
        raise HTTPException(status_code=403, detail="Sign in to attach a photo")
    if _is_suspended(db, event_id, contact_id):
        raise HTTPException(status_code=403, detail="You have been suspended from posting in this event")
    ext = _POST_IMAGE_EXT.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(status_code=400, detail="Only JPG, PNG, WEBP or GIF images are allowed")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > POST_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 5MB)")
    name = uuid.uuid4().hex + ext
    with open(os.path.join(POST_IMAGE_DIR, name), "wb") as fh:
        fh.write(data)
    return {"ok": True, "url": EVENT_API_PUBLIC_BASE + POST_MEDIA_PATH + name}


# ===========================================================================
# Badge: print state, undo, the thermal label, and the public digital card
# ===========================================================================
CARD_IMAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "cards")
os.makedirs(CARD_IMAGE_DIR, exist_ok=True)
CARD_MEDIA_PATH = "/public/cards/media/"

_rate_lock = threading.Lock()
_rate_hits = {}
_view_seen = {}


def _rate_limited(key: str, limit: int = 120, window: int = 60) -> bool:
    """Tiny in-process limiter for the public card routes: enough to make token
    guessing pointless, cheap enough to run on every request."""
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate_hits.get(key, []) if now - t < window]
        hits.append(now)
        _rate_hits[key] = hits
        if len(_rate_hits) > 5000:
            for k in [k for k, v in _rate_hits.items() if not v or now - v[-1] > window]:
                _rate_hits.pop(k, None)
        return len(hits) > limit


def _client_ip(request: FastAPIRequest) -> str:
    fwd = request.headers.get("x-forwarded-for") or ""
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?"))


def _inferred_source(attendee):
    """What an older row says about how it arrived, read once and then frozen."""
    src = str(((attendee.custom_data or {}).get("source") or "")).lower()
    if src == "walk_in":
        return "walk_in"
    if src == "ghl_invoice":
        return "ghl_invoice"
    if any(e.get("invoice_id") for e in ((attendee.custom_data or {}).get("entitlements") or [])) \
            and not (attendee.custom_data or {}).get("order_id"):
        return "ghl_invoice"
    if src in ("ghl_reconcile", "ghl_order"):
        return "ghl_order"
    if "webhook" in src:
        return "ghl_webhook"
    if "csv" in src or src == "import":
        return "import"
    if (attendee.custom_data or {}).get("order_id"):
        return "ghl_order"
    return "admin"


def _person_candidates(contact_id=None, email=None, name=None):
    """The stable keys a human is known by, strongest first.

    A CRM contact id is never a key on its own: couples and households share
    one contact record, so it only identifies a person together with the name
    on their ticket. An email address stands alone.
    """
    out = []
    cid = str(contact_id or "").strip()
    em = str(email or "").strip().lower()
    nm = str(name or "").strip()
    if cid and nm:
        out.append("contact:%s|%s" % (cid, nm))
    if em:
        out.append("email:" + em)
    return out


def _attendee_person(attendee):
    cd = attendee.custom_data or {}
    cid = cd.get("contact_id") or getattr(attendee, "acq_contact_id", None) or ""
    return (str(cid).strip(), (attendee.email or "").strip().lower(),
            badge_card.normalized_name(attendee))


def _find_member_card(db, *, contact_id=None, email=None, name=None, token=None):
    """One card per human. Matched on any key we hold for them, so a person
    whose email changed between years keeps the same card and the same badge —
    while two people behind one CRM contact keep separate cards."""
    if token:
        row = db.query(models.MemberCard).filter(models.MemberCard.public_token == token).first()
        if row:
            return row
    keys = _person_candidates(contact_id, email, name)
    if keys:
        row = db.query(models.MemberCard).filter(models.MemberCard.person_key.in_(keys)).first()
        if row:
            return row
    em = str(email or "").strip().lower()
    if em:
        row = db.query(models.MemberCard).filter(func.lower(models.MemberCard.email) == em).first()
        if row:
            return row
    cid = str(contact_id or "").strip()
    if cid and not name:
        # Last resort, and only for a caller that could not supply a name. With
        # a name we already hold the exact key, so any contact-only hit would be
        # a DIFFERENT person behind the same shared CRM record. Even here it must
        # be unambiguous: two cards behind one contact means two people, and
        # guessing between them hands over the wrong person's card.
        rows = db.query(models.MemberCard).filter(models.MemberCard.contact_id == cid).limit(2).all()
        if len(rows) == 1:
            return rows[0]
    return None


def _member_card_for_attendee(db, attendee, create=True):
    """The person's permanent card, seeding it from this ticket the first time.

    The token comes from the attendee row when one is already printed, so a
    badge in someone's pocket is never invalidated by this lookup.
    """
    cid, em, nm = _attendee_person(attendee)
    card = _find_member_card(db, contact_id=cid, email=em, name=nm, token=attendee.public_token)
    if not card:
        if not create:
            return None
        token = badge_card.ensure_public_token(db, models, attendee, commit=False)
        card = models.MemberCard(
            person_key=(_person_candidates(cid, em, nm) or ["email:" + (em or "a%d" % attendee.id)])[0],
            public_token=token, name=("%s %s" % (attendee.first_name or "", attendee.last_name or "")).strip(),
            email=em, contact_id=cid or None, card={}, bio="", card_public=False)
        db.add(card)
        db.flush()
    # Keep the snapshot fresh while a live ticket exists; it is what the card
    # falls back to once every event it came from has gone.
    name = ("%s %s" % (attendee.first_name or "", attendee.last_name or "")).strip()
    if name:
        card.name = name
    if em and not card.email:
        card.email = em
    if attendee.phone and not card.phone:
        card.phone = attendee.phone
    if cid and not card.contact_id:
        card.contact_id = cid
    if card.public_token and not attendee.public_token:
        attendee.public_token = card.public_token
    elif attendee.public_token and not card.public_token:
        card.public_token = attendee.public_token
    return card


REGISTRATION_SOURCES = ("ghl_order", "ghl_invoice", "ghl_webhook", "walk_in", "admin", "import")
ATTENDANCE_TYPES = ("paid", "complimentary", "staff", "speaker", "exhibitor")
DOOR_PAYMENT_STATUS = ("none", "pending", "collected", "waived", "needs_review")
DOOR_PAYMENT_METHODS = ("cash", "card_terminal", "payment_link", "other")


def stamp_registration(attendee, source, attendance_type=None):
    """Record how this attendee row came into being — ONCE.

    Immutable by design. A GHL order arriving after a walk-in reconciles onto
    the row and is recorded separately; it does not get to rewrite the fact that
    the person turned up at the door, because next year's report should still
    say so.
    """
    if attendee is None:
        return
    if not attendee.registration_source and source in REGISTRATION_SOURCES:
        attendee.registration_source = source
    if attendance_type in ATTENDANCE_TYPES and not attendee.attendance_type:
        attendee.attendance_type = attendance_type
    if not attendee.door_payment_status:
        attendee.door_payment_status = "none"


def link_ghl_order(db, attendee, order_id=None):
    """A genuine GHL order has reconciled onto this row.

    Records the linkage and the moment; leaves registration_source alone. If
    money was taken at the door, this does NOT decide that the two are the same
    payment — that judgement needs a rule we have not agreed, so the door
    payment is flagged for a human instead of being quietly written off.
    """
    if attendee is None:
        return
    if not attendee.ghl_linked_at:
        attendee.ghl_linked_at = datetime.utcnow()
    if attendee.door_payment_status == "collected":
        # Deliberately conservative: same email and similar amount is NOT proof
        # that the door cash and this order are one payment. Two genuine
        # payments happen (a friend's ticket, an upgrade), and silently hiding
        # one would misstate the takings.
        attendee.door_payment_status = "needs_review"
        _lifecycle_append(attendee, "door_payment_needs_review", actor="reconcile", order_id=order_id)


def attach_member_identity(db, attendee, commit=False):
    """Give a NEW attendee row the permanent identity every other attendee has.

    Called from every path an attendee can enter by — a GHL order reconcile, the
    registration webhook, a CSV import, an organiser adding someone by hand, or
    a walk-in at the door. There is no second-class attendee: whoever created
    the row, the person leaves with the same badge token, the same permanent
    card and the same participation history.

    A returning member keeps the card they already have. Only somebody genuinely
    new gets a new one.
    """
    if attendee is None:
        return None
    card = _member_card_for_attendee(db, attendee, create=True)
    if card and not attendee.public_token:
        attendee.public_token = card.public_token
    _sync_participation(db, card)
    if commit:
        db.commit()
    return card


def _sync_participation(db, card):
    """Record every event this token has an attendee row for. Only ever adds or
    refreshes — a line is never removed, because archiving or deleting our row
    about an event does not un-attend it."""
    if not card or not card.public_token:
        return
    rows = db.query(models.Attendee).filter(models.Attendee.public_token == card.public_token).all()
    for a in rows:
        ev = db.query(models.Event).filter(models.Event.id == a.event_id).first()
        if not ev:
            continue
        key = "e%d" % ev.id
        line = db.query(models.MemberCardEvent).filter(
            models.MemberCardEvent.card_id == card.id,
            models.MemberCardEvent.event_key == key).first()
        if not line:
            line = models.MemberCardEvent(card_id=card.id, event_key=key)
            db.add(line)
            # The session does not autoflush, so make the new line visible to
            # the next lookup rather than colliding with it at commit time.
            db.flush()
        line.event_name = ev.name or ""
        line.event_year = str(ev.start_date.year) if ev.start_date else ""
        line.starts_on = ev.start_date
        line.role = "Participant"
        line.attended = bool(a.is_checked_in)


def _participation(db, card):
    """The public history: event label and role. Nothing about tickets."""
    if not card:
        return []
    rows = db.query(models.MemberCardEvent).filter(
        models.MemberCardEvent.card_id == card.id).all()
    rows.sort(key=lambda r: (r.starts_on or datetime.min), reverse=True)
    return [{"label": badge_card.event_label(r.event_name, r.event_year), "role": r.role or "Participant"}
            for r in rows]


def _card_context(db, token: str):
    """token -> (primary attendee row, its event, the profile that owns the
    public card, bio). One token can name several rows (one per event); the
    card follows the newest edit, the event label follows the latest event."""
    token = (token or "").strip().upper()
    if not badge_card.TOKEN_RE.match(token):
        return None
    # The card is the authority. Attendee rows only decide which event the
    # card names — and there may be none left, which is fine: the badge in
    # someone's drawer must keep working after its event is gone.
    card = db.query(models.MemberCard).filter(models.MemberCard.public_token == token).first()
    rows = db.query(models.Attendee).filter(models.Attendee.public_token == token).all()
    if not card and not rows:
        return None
    if not card and rows:
        card = _member_card_for_attendee(db, rows[0])
        _sync_participation(db, card)
        db.commit()
    event = None
    if rows:
        events = {e.id: e for e in db.query(models.Event).filter(
            models.Event.id.in_([a.event_id for a in rows])).all()}

        def ev_key(a):
            e = events.get(a.event_id)
            return (0 if (e and not e.is_archived) else 1,
                    -(e.start_date.timestamp() if (e and e.start_date) else 0))
        rows.sort(key=ev_key)
        event = events.get(rows[0].event_id)
    return card, event


def _serve_card(token: str, request: FastAPIRequest, db, fmt: str):
    if _rate_limited("card:" + _client_ip(request)):
        return PlainTextResponse("Too many requests", status_code=429)
    ctx = _card_context(db, token)
    if not ctx:
        if fmt == "html":
            return HTMLResponse(badge_card.render_not_found_html(), status_code=404)
        raise HTTPException(status_code=404, detail="Card not found")
    card, event = ctx
    view = badge_card.public_view(card, event, _participation(db, card))
    tok = card.public_token
    if fmt == "vcf":
        if not view.get("public"):
            raise HTTPException(status_code=404, detail="Card not public")
        return PlainTextResponse(badge_card.vcard(view, tok), media_type="text/vcard; charset=utf-8",
                                 headers={"Content-Disposition": "attachment; filename=\"%s.vcf\"" % re.sub(r"[^A-Za-z0-9]+", "-", view["name"]).strip("-")})
    if fmt == "json":
        return view
    # A view is counted once per visitor per 10 minutes, and only on public cards.
    if card.card_public:
        key = (_client_ip(request), tok)
        now = time.time()
        with _rate_lock:
            last = _view_seen.get(key, 0)
            if now - last > 600:
                _view_seen[key] = now
                if len(_view_seen) > 20000:
                    _view_seen.clear()
                count = True
            else:
                count = False
        if count:
            card.card_views = (card.card_views or 0) + 1
            card.card_last_viewed_at = datetime.utcnow()
            db.commit()
    return HTMLResponse(badge_card.render_card_html(view, tok),
                        headers={"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex"})


@app.get("/c/{token}.vcf")
@app.get("/C/{token}.vcf")
@app.get("/C/{token}.VCF")
def public_card_vcf(token: str, request: FastAPIRequest, db: Session = Depends(get_db)):
    return _serve_card(token, request, db, "vcf")


@app.get("/c/{token}.json")
@app.get("/C/{token}.json")
def public_card_json(token: str, request: FastAPIRequest, db: Session = Depends(get_db)):
    return _serve_card(token, request, db, "json")


@app.get("/c/{token}")
@app.get("/C/{token}")
def public_card_html(token: str, request: FastAPIRequest, db: Session = Depends(get_db)):
    return _serve_card(token, request, db, "html")


@app.get(CARD_MEDIA_PATH + "{filename}")
def public_card_media(filename: str):
    from fastapi.responses import FileResponse
    safe = os.path.basename(filename)
    path = os.path.join(CARD_IMAGE_DIR, safe)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ── The owner's side (via the Gaia proxy, service token) ────────────────────
def _own_profile(db, attendee, create=False):
    prof = db.query(models.NetworkingProfile).filter(
        models.NetworkingProfile.attendee_id == attendee.id).first()
    if not prof and create:
        prof = models.NetworkingProfile(attendee_id=attendee.id, visible=False, bio="", card={}, card_public=False)
        db.add(prof)
        db.flush()
    return prof


def _own_card(db, payload, create=False):
    """The person's permanent card, from the identity the proxy proved.

    Resolved WITHOUT needing a live ticket: someone whose only event has been
    deleted still owns their card. A ticket, when there is one, is used to seed
    the card and to refresh the name and participation history.
    """
    contact_id = (payload.contact_id or "").strip() or None
    email = (payload.email or "").strip().lower() or None
    verified = bool(payload.email_verified)
    # Same rule as every other identity route: an unverified address proves
    # nothing, so it is not allowed to reach anyone's card.
    lookup_email = email if verified else None
    attendees, _ev, report = identity_lib.resolve_attendees(
        db, contact_id=contact_id, email=email, email_verified=verified)
    card = _find_member_card(db, contact_id=contact_id, email=lookup_email,
                             name=badge_card.normalized_name(attendees[0]) if attendees else None)
    attendee = None
    if attendees:
        wanted = getattr(payload, "event_id", 0) or 0
        attendee = next((a for a in attendees if a.event_id == wanted), None) or attendees[0]
        if not card:
            card = _member_card_for_attendee(db, attendee, create=create or True)
        else:
            for a in attendees:
                if not a.public_token and card.public_token:
                    a.public_token = card.public_token
    if not card:
        return None, None, report
    _sync_participation(db, card)
    db.commit()
    return card, attendee, report


def _card_owner_view(db, mcard, attendee, event):
    """What the owner sees in the app: everything they typed, the public flag,
    the printed URL, and how often the card was opened."""
    token = mcard.public_token
    prof = mcard
    card = (mcard.card if mcard.card else {}) or {}
    return {
        "ok": True,
        "token": token,
        "card_url": badge_card.card_url(token),
        "printed_payload": badge_card.printed_payload(token),
        # The very QR that is on their badge, so the app can show it in the
        # person's profile and let them share it before the badge is printed.
        "qr_image": generate_qr_code(badge_card.printed_payload(token)),
        "themes": list(badge_card.THEMES.keys()),
        "public": bool(prof.card_public),
        "claimed_at": prof.card_claimed_at,
        "views": prof.card_views or 0,
        "name": mcard.name or (("%s %s" % (attendee.first_name or "", attendee.last_name or "")).strip() if attendee else ""),
        "event_name": event.name if event else "",
        "events": _participation(db, mcard),
        "bio": (prof.bio or ""),
        "fields": {k: card.get(k, [] if k in ("tags", "services") else ("gaia" if k == "theme" else (False if k.startswith("show_") else ""))) for k in badge_card.CARD_FIELDS},
        # So the owner can see what switching these on would reveal.
        "email_on_file": (attendee.email if attendee else mcard.email) or "",
        "phone_on_file": (attendee.phone if attendee else mcard.phone) or "",
        "networking_enabled": bool(event and event.networking_enabled),
    }


@app.post("/identity/card")
def identity_card(payload: schemas.IdentityTicketLookup, db: Session = Depends(get_db),
                  _: bool = Depends(require_service_token)):
    mcard, attendee, report = _own_card(db, payload, create=True)
    if not mcard:
        return {"ok": False, "reason": "no_card_for_member", "resolution": report}
    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first() if attendee else None
    return _card_owner_view(db, mcard, attendee, event)


@app.post("/identity/card/update")
def identity_card_update(payload: schemas.CardUpdate, db: Session = Depends(get_db),
                         _: bool = Depends(require_service_token)):
    """The owner edits their card. Fields are sanitised, contact details are
    revealed only by explicit switches, and turning the card public stamps the
    claim time once."""
    mcard, attendee, report = _own_card(db, payload, create=True)
    if not mcard:
        return {"ok": False, "reason": "no_card_for_member", "resolution": report}
    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first() if attendee else None
    prof = mcard
    current = dict(prof.card or {})
    incoming = payload.dict(exclude_unset=True)
    for k in badge_card.CARD_FIELDS:
        if k in incoming and incoming[k] is not None:
            current[k] = incoming[k]
    prof.card = badge_card.clean_card(current)
    if incoming.get("bio") is not None:
        prof.bio = str(incoming["bio"] or "").strip()[:400]
    if incoming.get("public") is not None:
        prof.card_public = bool(incoming["public"])
        if prof.card_public and not prof.card_claimed_at:
            prof.card_claimed_at = datetime.utcnow()
    prof.updated_at = datetime.utcnow()
    db.commit()
    return _card_owner_view(db, mcard, attendee, event)


_CARD_IMAGE_EXT = {"image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


@app.post("/identity/card/photo")
async def identity_card_photo(request: FastAPIRequest, db: Session = Depends(get_db),
                              _: bool = Depends(require_service_token)):
    """A card photo. Normalised server-side to a 512px square JPEG so the page
    stays light and no EXIF (location, device) ever reaches the public card."""
    contact_id = (request.query_params.get("contact_id") or "").strip()
    email = (request.query_params.get("email") or "").strip().lower()
    verified = (request.query_params.get("email_verified") or "") == "1"
    try:
        event_id = int(request.query_params.get("event_id") or 0)
    except ValueError:
        event_id = 0
    mcard = _find_member_card(db, contact_id=contact_id or None,
                              email=(email or None) if verified else None)
    if not mcard:
        attendees, _e, _r = identity_lib.resolve_attendees(db, contact_id=contact_id or None,
                                                           email=email or None, email_verified=verified)
        attendee = next((a for a in attendees if a.event_id == event_id), None) or (attendees[0] if attendees else None)
        if attendee:
            mcard = _member_card_for_attendee(db, attendee)
    if not mcard:
        raise HTTPException(status_code=403, detail="No card for this member")
    ct = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ct not in _CARD_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="Only JPG, PNG or WEBP images are allowed")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > POST_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 5MB)")
    try:
        from PIL import Image as _PILImage, ImageOps as _PILOps
        im = _PILImage.open(io.BytesIO(data))
        im = _PILOps.exif_transpose(im).convert("RGB")
        im = _PILOps.fit(im, (512, 512), method=_PILImage.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=86, optimize=True)
        data = out.getvalue()
    except Exception:
        raise HTTPException(status_code=400, detail="That file does not look like an image")
    name = uuid.uuid4().hex + ".jpg"
    with open(os.path.join(CARD_IMAGE_DIR, name), "wb") as fh:
        fh.write(data)
    url = EVENT_API_PUBLIC_BASE + CARD_MEDIA_PATH + name
    card = dict(mcard.card or {})
    old = card.get("photo_url") or ""
    card["photo_url"] = url
    mcard.card = badge_card.clean_card(card)
    mcard.updated_at = datetime.utcnow()
    db.commit()
    if old.startswith(EVENT_API_PUBLIC_BASE + CARD_MEDIA_PATH):
        try:
            os.remove(os.path.join(CARD_IMAGE_DIR, os.path.basename(old)))
        except OSError:
            pass
    return {"ok": True, "url": url}


@app.post("/identity/card/owner")
def identity_card_owner(payload: schemas.ConnectByToken, db: Session = Depends(get_db),
                        _: bool = Depends(require_service_token)):
    """Does the person the proxy has proved this session to be OWN the badge
    behind this token? The public URL itself never grants anything: ownership
    is re-proved here from the session identity (GHL contact id, or an email
    the session verified by magic link) against the attendee rows that carry
    the token. A stranger who scanned the badge gets owner=false and learns
    nothing else."""
    token = (payload.token or "").strip().upper()
    if not badge_card.TOKEN_RE.match(token):
        return {"ok": True, "owner": False}
    verified = bool(payload.email_verified)
    email = (payload.email or "").strip().lower() or None
    mine = _find_member_card(db, contact_id=(payload.contact_id or "").strip() or None,
                             email=email if verified else None, token=None)
    if not mine or mine.public_token != token:
        # Fall back to the ticket rows for a card that predates this table.
        attendees, _evidence, _report = identity_lib.resolve_attendees(
            db, contact_id=payload.contact_id, email=payload.email, email_verified=verified)
        rows = [a for a in attendees if a.public_token == token]
        if not rows:
            return {"ok": True, "owner": False}
        mine = _member_card_for_attendee(db, rows[0])
        db.commit()
    # An event id only steers which ticket the editor opens against; the card
    # itself is the person's, so a card with no live event still answers here.
    rows = db.query(models.Attendee).filter(models.Attendee.public_token == token).all()
    event_id = 0
    for a in rows:
        ev = db.query(models.Event).filter(models.Event.id == a.event_id).first()
        if ev and not ev.is_archived:
            event_id = a.event_id
            break
    else:
        event_id = rows[0].event_id if rows else 0
    return {"ok": True, "owner": True, "event_id": event_id,
            "claimed": bool(mine.card_public or mine.card_claimed_at),
            "public": bool(mine.card_public)}


@app.post("/identity/networking/connect-by-token")
def identity_networking_connect_by_token(payload: schemas.ConnectByToken, db: Session = Depends(get_db),
                                         _: bool = Depends(require_service_token)):
    """Scanned a badge, tapped Connect: the token names the other person."""
    attendee, report = _resolve_own_attendee(payload, db)
    if not attendee:
        return {"ok": False, "reason": "no_ticket_for_event", "resolution": report}
    return networking_lib.connect_by_token(db, attendee, (payload.token or "").strip().upper())


# ── Admin side: label, print record, undo ───────────────────────────────────
@app.get("/events/{event_id}/attendees/{attendee_id}/badge-label.png")
def badge_label_png(event_id: int, attendee_id: int, size: str = badge_card.DEFAULT_LABEL,
                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """The sticker, rendered server-side at 203 dpi so every station prints
    the same thing. `size` is the roll; 40x50 portrait is the approved design."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    a = db.query(models.Attendee).filter(models.Attendee.id == attendee_id,
                                         models.Attendee.event_id == event_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Attendee not found")
    if (size or badge_card.DEFAULT_LABEL) not in badge_card.LABEL_SIZES:
        raise HTTPException(status_code=400, detail="Unsupported label size")
    w, h = badge_card.LABEL_SIZES[size or badge_card.DEFAULT_LABEL]
    token = badge_card.ensure_public_token(db, models, a)
    png, meta = badge_card.render_label(a.first_name, a.last_name, token, width_mm=w, height_mm=h,
                                        qr_mm=min(26, h - 6))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "private, no-store",
                             "X-Label-Payload": meta["payload"],
                             "X-Label-Size": "%dx%d" % (w, h)})


@app.post("/events/{event_id}/attendees/{attendee_id}/badge-print")
def badge_print_record(event_id: int, attendee_id: int, body: schemas.BadgePrintRecord,
                       db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """A station reports one print attempt. This never touches check-in, and a
    retry that re-sends the same client_attempt_id is recorded once."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "checkin.perform")
    a = db.query(models.Attendee).filter(models.Attendee.id == attendee_id,
                                         models.Attendee.event_id == event_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Attendee not found")
    result = (body.result or "").strip().lower()
    if result not in ("printed", "failed"):
        raise HTTPException(status_code=400, detail="result must be printed or failed")
    if body.client_attempt_id:
        dup = db.query(models.BadgePrintLog).filter(
            models.BadgePrintLog.client_attempt_id == body.client_attempt_id).first()
        if dup:
            return {"ok": True, "already": True, "attendee": schemas.Attendee.from_orm(a)}
    db.add(models.BadgePrintLog(event_id=event_id, attendee_id=a.id, station=(body.station or "")[:60] or None,
                                staff_user_id=current_user.id, result=result, error=(body.error or "")[:300] or None,
                                client_attempt_id=body.client_attempt_id))
    a.badge_last_station = (body.station or "")[:60] or None
    a.badge_last_result = result
    a.badge_last_error = (body.error or "")[:300] if result == "failed" else None
    if result == "printed":
        a.badge_printed_at = datetime.utcnow()
        a.badge_print_count = (a.badge_print_count or 0) + 1
    db.commit()
    db.refresh(a)
    a.effective_access = _effective_access(db, a)
    return {"ok": True, "already": False, "attendee": schemas.Attendee.from_orm(a)}


@app.post("/events/{event_id}/attendees/{attendee_id}/undo-checkin")
def undo_checkin(event_id: int, attendee_id: int, body: schemas.UndoCheckIn,
                 db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Reverse a wrong check-in. Audited like a scan (result UNDO, with the
    reason and the time being undone), because a check-in that can vanish
    without a trace is worse than one that cannot be corrected."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "checkin.perform")
    a = db.query(models.Attendee).filter(models.Attendee.id == attendee_id,
                                         models.Attendee.event_id == event_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Attendee not found")
    reason = (body.reason or "").strip()
    if len(reason) < 3:
        raise HTTPException(status_code=400, detail="A reason is required")
    if not a.is_checked_in:
        return {"ok": True, "already": True, "attendee": schemas.Attendee.from_orm(a)}
    was = a.checked_in_at.isoformat() if a.checked_in_at else "?"
    a.is_checked_in = False
    a.checked_in_at = None
    db.add(models.ScanLog(event_id=event_id, attendee_id=a.id, qr_code=a.qr_code, access_type="EVENT_ENTRY",
                          result="UNDO", reason=("Check-in undone (was %s): %s" % (was, reason))[:300],
                          staff_user_id=current_user.id))
    db.commit()
    db.refresh(a)
    a.effective_access = _effective_access(db, a)
    return {"ok": True, "already": False, "attendee": schemas.Attendee.from_orm(a)}


@app.get("/public/posts/media/{filename}")
def public_post_media(filename: str):
    from fastapi.responses import FileResponse
    safe = os.path.basename(filename)
    path = os.path.join(POST_IMAGE_DIR, safe)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8002)
