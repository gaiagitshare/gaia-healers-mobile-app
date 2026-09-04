from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, ForeignKey, JSON, Float, Table, UniqueConstraint
from sqlalchemy.orm import relationship
from database import Base
from datetime import datetime

# Datetime convention
# -------------------
# Event and session times are stored as naive datetimes that mean *local time at
# the venue*, and every Event carries an IANA `timezone` describing which local
# time that is. An agenda built in Dubai for a conference in Orlando therefore
# still reads 9:00 AM on the floor in Orlando. Clients render using the event's
# timezone and must not apply the viewer's own offset.

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    full_name = Column(String)
    # Platform administrator: every event, every operation. Kept as the original
    # column so existing accounts and tokens keep working unchanged.
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    roles = relationship("EventRole", back_populates="user", cascade="all, delete-orphan")


class EventRole(Base):
    """What one person may do at one event.

    Scoped deliberately. Door staff hired for a weekend conference should be
    able to check people in at that conference and nowhere else — including at
    the event running in the next hall, and including next year's. Granting a
    role is therefore always an (person, event) pair, never a global flag.

    The one exception is User.is_admin, which is the platform owner and is
    checked before this table is consulted at all.
    """
    __tablename__ = "event_roles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    # organizer | checkin_staff | exhibitor_manager
    role = Column(String, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="roles")

class Event(Base):
    __tablename__ = "events"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text)
    start_date = Column(DateTime)
    end_date = Column(DateTime)
    location = Column(String)
    is_active = Column(Boolean, default=True)
    custom_fields = Column(JSON, default=list)  # Registration form fields
    badge_template = Column(Text)  # HTML/CSS for badge
    source_url = Column(String, index=True, nullable=True)  # canonical landing page; used to match/refresh
    # A past event kept for the record. Archived events are read-only: the
    # reconciler, webhook, scanner and importer all refuse to write to them, so
    # a finished year can never silently gain or change attendees again.
    is_archived = Column(Boolean, default=False)
    locked_fields = Column(JSON, default=list)  # field names an admin edited; auto-sync must not overwrite
    timezone = Column(String, default="UTC")  # IANA name, e.g. America/New_York — see convention note above
    # The live page is switched on deliberately by an operator rather than
    # appearing on its own: a half-built agenda on a lobby screen is worse than
    # no screen at all.
    live_enabled = Column(Boolean, default=False)
    live_message = Column(Text)  # optional banner shown across the live surfaces
    hero_image_url = Column(String)  # per-event artwork; the app must not wear one event's photo for all
    # Where a visitor goes to buy or register. Deliberately separate from
    # source_url, which is only where this record is imported/synced FROM: an
    # event's landing page and its checkout are frequently not the same place.
    registration_url = Column(String)
    registration_label = Column(String)  # e.g. "Buy ticket", "Register free"
    # is_active means "operationally live" (check-in, lead scanning).
    # is_published means "visible to members in the Gaia app". A scraped event
    # arrives unpublished so a half-built agenda never leaks to attendees.
    is_published = Column(Boolean, default=False)
    # Attendance figures are commercially sensitive: an event that has sold
    # poorly should not broadcast that to anyone who loads the live page. They
    # are private by default and an organiser opts in per event — e.g. for a
    # lobby screen where a full room is the point.
    public_counters = Column(Boolean, default=False)
    # The venue plan the map pins sit on. Per event, like the hero image: one
    # conference's floor plan must never wear another's.
    map_image_url = Column(String)
    # Whether attendees may see and contact each other at this event at all.
    # Off by default: a directory of ticket buyers is something an organiser
    # turns on for a networking event, not something that happens to people.
    networking_enabled = Column(Boolean, default=False)
    # Rehearsal at the door, before opening day.
    #
    # A ticket is not valid outside its event's calendar window, and that gate
    # is not negotiable -- it is what stops last year's badge opening this
    # year's door. But staff have to be able to practise the whole flow, and
    # printers have to be tested, BEFORE the event rather than in front of a
    # queue. This lets an organiser switch the date gate off deliberately, for
    # one event, with a banner on screen the whole time it is on. Every scan
    # taken this way is recorded as a rehearsal so it can never be mistaken for
    # real attendance.
    door_test_mode = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    attendees = relationship("Attendee", back_populates="event")
    ticket_types = relationship("TicketType", back_populates="event", cascade="all, delete-orphan")
    exhibitors = relationship("Exhibitor", back_populates="event")
    sessions = relationship("Session", back_populates="event", cascade="all, delete-orphan")
    speakers = relationship("Speaker", back_populates="event", cascade="all, delete-orphan")
    sponsors = relationship("Sponsor", back_populates="event", cascade="all, delete-orphan")
    announcements = relationship("Announcement", back_populates="event", cascade="all, delete-orphan")

class Attendee(Base):
    __tablename__ = "attendees"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"))
    email = Column(String, index=True)
    first_name = Column(String)
    last_name = Column(String)
    company = Column(String)
    job_title = Column(String)
    phone = Column(String)
    custom_data = Column(JSON, default=dict)  # Dynamic form data
    qr_code = Column(String, unique=True, index=True)
    # The PERSON's public alias, printed on the badge as a short URL. Random,
    # information-free, reused across events for the same human (so it is NOT
    # unique per row - one person, two events, one token). qr_code above stays
    # the canonical ticket identity; this is only ever resolved back to it.
    public_token = Column(String, index=True, nullable=True)
    # Badge printing is its own state, deliberately separate from check-in: a
    # dead printer must never cost a successful check-in, and a reprint must
    # never check anyone in twice.
    badge_printed_at = Column(DateTime, nullable=True)
    badge_print_count = Column(Integer, default=0)
    badge_last_station = Column(String, nullable=True)
    badge_last_result = Column(String, nullable=True)   # printed | failed
    badge_last_error = Column(String, nullable=True)
    is_checked_in = Column(Boolean, default=False)
    checked_in_at = Column(DateTime, nullable=True)
    registration_status = Column(String, default="registered")  # registered, cancelled, no-show
    # What this person actually bought, as a row rather than a string.
    # custom_data["pass_type"] still holds whatever the seller called it and is
    # kept for display during migration, but it is never the authority: names
    # get re-worded every season and access must not move when they do.
    ticket_type_id = Column(Integer, ForeignKey("ticket_types.id"), nullable=True, index=True)
    # What this attendee has agreed an exhibitor may keep after scanning their
    # badge. Nothing is assumed: buying a ticket is not consent to have your
    # phone number handed to every stand in the hall. Both default to False and
    # only the attendee can turn them on.
    share_email_with_exhibitors = Column(Boolean, default=False)
    share_phone_with_exhibitors = Column(Boolean, default=False)
    consent_updated_at = Column(DateTime, nullable=True)

    # --- How they got here, and why they get a badge ------------------
    # THREE separate ideas, deliberately not one field:
    #
    #   registration_source - how this attendee row was FIRST created for this
    #       event. Immutable. A GHL order arriving later reconciles onto the row
    #       and is recorded alongside; it never rewrites how the person actually
    #       arrived, because the history has to stay true.
    #   attendance_type     - why they are entitled to a badge at all. Being a
    #       walk-in says nothing about whether anyone paid.
    #   door_payment_*      - money taken at the door, by us, on our own till.
    #       GAIA-RECORDED, never GHL-verified: it is never written into the
    #       entitlement ledger and never added to GHL revenue.
    registration_source = Column(String, index=True)   # ghl_order|ghl_webhook|walk_in|admin|import
    attendance_type = Column(String, index=True)       # paid|complimentary|staff|speaker|exhibitor
    # When a genuine GHL order first reconciled onto this row. Presence of this
    # is what "verified" means; registration_source stays as it was.
    ghl_linked_at = Column(DateTime, nullable=True)

    # Door payment — Gaia's own record of cash/card taken at the desk.
    # status: none | pending | collected | waived | needs_review
    door_payment_status = Column(String, index=True)
    door_payment_method = Column(String)               # cash|card_terminal|payment_link|other
    door_payment_amount = Column(Float, nullable=True)
    door_payment_currency = Column(String)
    door_payment_reference = Column(String)            # till receipt number
    door_payment_by = Column(Integer, nullable=True)   # staff user id
    door_payment_at = Column(DateTime, nullable=True)
    door_payment_note = Column(String)

    # --- Acquisition / purchase source -------------------------------
    # WHERE and WHEN the ticket was actually bought, captured from the GHL
    # order at reconcile time. custom_data.source stays as it was: that is
    # the internal ingestion method (ghl_reconcile), not the sales source.
    # Deliberately NOT stored: ip, user agent, fbclid/fbc/fbp - tracking
    # identifiers we have no need to keep in order to run a door.
    acq_purchased_at = Column(String, nullable=True)
    acq_order_id = Column(String, nullable=True)
    acq_contact_id = Column(String, nullable=True)
    acq_product_id = Column(String, nullable=True)
    acq_product_name = Column(String, nullable=True)
    acq_price = Column(Float, nullable=True)
    acq_funnel_name = Column(String, nullable=True)
    acq_funnel_id = Column(String, nullable=True)
    acq_checkout_type = Column(String, nullable=True)
    acq_page_id = Column(String, nullable=True)
    acq_page_url = Column(String, nullable=True)
    acq_domain = Column(String, nullable=True)
    acq_landing_url = Column(String, nullable=True)
    acq_referrer = Column(String, nullable=True)
    acq_session_source = Column(String, nullable=True)
    acq_contact_source = Column(String, nullable=True)
    acq_utm_source = Column(String, nullable=True)
    acq_utm_medium = Column(String, nullable=True)
    acq_utm_campaign = Column(String, nullable=True)
    acq_utm_content = Column(String, nullable=True)
    acq_utm_term = Column(String, nullable=True)
    acq_kind = Column(String, nullable=True)
    acq_order_status = Column(String, nullable=True)
    # Resolved for humans: which funnel PAGE they paid on (from the GHL funnel
    # step), the full purchase URL, and where they came from before that.
    acq_page_name = Column(String, nullable=True)
    acq_purchase_url = Column(String, nullable=True)
    acq_referrer_domain = Column(String, nullable=True)
    acq_saw_on = Column(String, nullable=True)
    # The acquisition source AND the evidence it rests on. Kept apart so the
    # UI can never present a contact-level guess as if it were proof that
    # this particular purchase came from that place.
    acq_source_value = Column(String, nullable=True)
    acq_source_basis = Column(String, nullable=True)
    # Three DIFFERENT moments, never conflated:
    #   acq_purchased_at  - the GHL completed-order time (authoritative)
    #   acq_issued_at     - when Gaia minted this QR, ONLY when provable
    #   created_at        - when the Gaia row appeared (may be a backfill)
    acq_issued_at = Column(String, nullable=True)
    acq_issuance_method = Column(String, nullable=True)
    # A person can buy more than once (base ticket, then an upgrade). The
    # first purchase is their acquisition; the last shows recent activity.
    # Neither replaces the other, and neither equals the attendee count.
    acq_last_purchased_at = Column(String, nullable=True)
    acq_purchase_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event", back_populates="attendees")
    leads = relationship("Lead", back_populates="attendee")
    ticket_type = relationship("TicketType", back_populates="attendees")
    identities = relationship("AttendeeIdentity", back_populates="attendee",
                              cascade="all, delete-orphan")
    saved_sessions = relationship("SavedSession", back_populates="attendee",
                                  cascade="all, delete-orphan")

class Exhibitor(Base):
    __tablename__ = "exhibitors"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"))
    company_name = Column(String)
    booth_number = Column(String)
    contact_email = Column(String)
    contact_phone = Column(String)
    access_token = Column(String, unique=True, index=True)  # For QR scanning
    # Directory profile — what attendees and other exhibitors actually see.
    # contact_email/contact_phone stay internal and are never exposed publicly.
    description = Column(Text)
    logo_url = Column(String)
    website = Column(String)
    category = Column(String, index=True)
    sort_order = Column(Integer, default=0)
    is_published = Column(Boolean, default=False)
    # Whether this stand may scan badges at all. Previously every exhibitor row
    # was issued a working token on creation, so scanning was a side effect of
    # existing rather than something an organiser sold and granted.
    can_scan_leads = Column(Boolean, default=False)
    # What they bought, and whether they have paid for it.
    #
    # This lived in a spreadsheet column of free text and a green highlight,
    # which is fine for planning and cannot be what gates lead retrieval on the
    # day. `package` is the seller's own wording; `payment_status` is the thing
    # anything may branch on.
    # Where this stand is in the conversation, not what it has paid.
    #
    # The sheet keeps prospects, maybes and refusals in the same list as the
    # confirmed stands, separated only by a heading -- which is right, because a
    # maybe becomes confirmed the day they pay. Carrying that across means the
    # whole board lives in one place and nobody re-types a vendor on conversion.
    #
    # Only `confirmed` should ever be published or given a scanner; the rest are
    # imported switched off, and the UI groups by this so a "not aligned" stand
    # is not one stray click from the attendee directory.
    stage = Column(String, default="confirmed", index=True)
    package = Column(String)                        # "The Connector $5000", "Partners", ...
    payment_status = Column(String, default="unpaid", index=True)  # paid|partial|unpaid|comp
    amount_due = Column(Float)
    amount_paid = Column(Float)
    payment_note = Column(Text)                     # "$2500 Paid - $2500 remaining balance"
    # A stand's own contact details are business details, and plenty of vendors
    # want them in the directory -- but that is their call, not a default, and
    # some of these addresses are a personal mailbox. Off unless switched on.
    show_contact_publicly = Column(Boolean, default=False)
    # PUBLIC contact, taken from the company's own website — separate from
    # contact_email/contact_phone above, which is the person who booked the
    # booth and is frequently their personal mobile. A directory that published
    # the booking contact would be handing out someone's private number; these
    # are the details the company itself already publishes.
    public_email = Column(String)
    public_phone = Column(String)
    address = Column(String)
    tagline = Column(String)          # the one line the company leads with
    # Vendor self-setup. An organiser sends a link; the stand fills in its own
    # description, logo and links, and publishes itself.
    #
    # Deliberately NOT access_token: that one makes a scanner work, and is sold.
    # A link for writing a directory entry must never be a link for reading
    # attendees, so they are different secrets with different lifetimes. Only a
    # hash is stored, so a copy of this table opens nobody's page.
    setup_token_hash = Column(String, index=True)
    setup_sent_at = Column(DateTime, nullable=True)
    setup_expires_at = Column(DateTime, nullable=True)
    activated_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event", back_populates="exhibitors")
    leads = relationship("Lead", back_populates="exhibitor")


# Sessions may have several speakers, and a speaker may hold several slots.
session_speakers = Table(
    "session_speakers",
    Base.metadata,
    Column("session_id", Integer, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("speaker_id", Integer, ForeignKey("speakers.id", ondelete="CASCADE"), primary_key=True),
)


class Speaker(Base):
    __tablename__ = "speakers"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    name = Column(String, index=True)
    role = Column(String)       # e.g. "Energy Diagnostics & Holistic Innovation"
    company = Column(String)
    bio = Column(Text)
    photo_url = Column(String)
    links = Column(JSON, default=dict)  # {"website": "...", "instagram": "..."}
    sort_order = Column(Integer, default=0)
    # Featured reuses this same record — a speaker is never duplicated to be
    # highlighted somewhere.
    is_featured = Column(Boolean, default=False)
    is_published = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event", back_populates="speakers")
    sessions = relationship("Session", secondary=session_speakers, back_populates="speakers")


class Sponsor(Base):
    """A paying partner. Tier drives placement and rotation weight on the live
    surfaces, so Diamond logos are seen more often than Bronze ones."""
    __tablename__ = "sponsors"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    name = Column(String, index=True)
    tier = Column(String, default="partner", index=True)  # headline | gold | silver | partner
    logo_url = Column(String)
    website = Column(String)
    blurb = Column(Text)
    sort_order = Column(Integer, default=0)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event", back_populates="sponsors")


class Announcement(Base):
    """A short message pushed to the live page during the event — room changes,
    delays, "lunch is served"."""
    __tablename__ = "event_announcements"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    title = Column(String)
    body = Column(Text)
    is_pinned = Column(Boolean, default=False)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    # A future publish time (announce in advance) and an optional audience
    # filter, e.g. {"type": "ticket_type", "ticket_type_id": 3}.
    scheduled_for = Column(DateTime, nullable=True, index=True)
    audience = Column(JSON, nullable=True)

    event = relationship("Event", back_populates="announcements")


class Session(Base):
    """One slot on the agenda: talk, workshop, panel or break.

    start_time/end_time are venue-local — see the convention note at the top.
    """
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    title = Column(String, index=True)
    description = Column(Text)
    session_type = Column(String, default="talk")  # talk | workshop | panel | break | social
    track = Column(String, index=True)             # e.g. "Main Stage", "Practitioner"
    room = Column(String)                          # e.g. "Grand Ballroom A"
    start_time = Column(DateTime, index=True)
    end_time = Column(DateTime)
    capacity = Column(Integer, nullable=True)
    # Set when a session originates from an imported/scraped source, so a
    # re-import updates the same row instead of duplicating the agenda.
    external_id = Column(String, index=True, nullable=True)
    # Whether people must claim a place rather than just walk in. Ordinary
    # talks stay walk-in; this is for the workshop with twenty chairs.
    requires_registration = Column(Boolean, default=False)
    # When True, only ticket types that grant workshop access may register.
    # A per-session switch rather than anything inferred from the session's
    # name or type, for the same reason pass access never reads pass names.
    needs_workshop_pass = Column(Boolean, default=False)
    # Ordering is by start_time; sort_order only breaks ties and places
    # untimed items relative to each other.
    sort_order = Column(Integer, default=0)
    is_featured = Column(Boolean, default=False)
    is_published = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    event = relationship("Event", back_populates="sessions")
    speakers = relationship("Speaker", secondary=session_speakers, back_populates="sessions")

class Lead(Base):
    __tablename__ = "leads"
    
    id = Column(Integer, primary_key=True, index=True)
    exhibitor_id = Column(Integer, ForeignKey("exhibitors.id"))
    attendee_id = Column(Integer, ForeignKey("attendees.id"))
    notes = Column(Text)
    rating = Column(Integer)  # 1-5 star rating
    # Interested | Hot Lead | Follow Up | Customer — free-form so an organiser
    # can use their own vocabulary; nothing branches on it.
    status = Column(String, nullable=True)
    # What the attendee's consent actually permitted at the moment of the scan,
    # recorded rather than recomputed. Consent can be withdrawn later, and the
    # honest record is what was true when the exchange happened.
    consent_snapshot = Column(JSON, default=dict)
    scanned_at = Column(DateTime, default=datetime.utcnow)
    
    exhibitor = relationship("Exhibitor", back_populates="leads")
    attendee = relationship("Attendee", back_populates="leads")


class TicketType(Base):
    """A pass level for one event — General, VIP, Exhibitor, Speaker.

    `code` is the canonical identity and the only thing authorization may
    branch on. It is meant to hold the seller's own product/price identifier
    (a GHL price id, a Shopify variant id), because that is the one value that
    survives a marketing rename. `name` is display only.
    """
    __tablename__ = "ticket_types"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    code = Column(String, index=True)      # canonical; unique per event
    name = Column(String)                  # what the attendee sees
    description = Column(Text)
    # Access this pass carries. Kept as explicit flags rather than inferred
    # from the name, so "VIP Gold Plus" and "vip" cannot disagree.
    is_vip = Column(Boolean, default=False)
    grants_workshops = Column(Boolean, default=False)
    grants_conference = Column(Boolean, default=False)
    # A pass that is valid on ONE calendar day only (venue-local, YYYY-MM-DD).
    # NULL means the pass is valid for the whole event, which is what every
    # existing tier is — so adding this changes nothing for them.
    valid_day = Column(String, nullable=True)  # conference/speaker sessions
    sort_order = Column(Integer, default=0)
    upgrade_rank = Column(Integer, default=0)  # higher = more premium; upgrade precedence
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event", back_populates="ticket_types")
    attendees = relationship("Attendee", back_populates="ticket_type")


class AttendeeIdentity(Base):
    """The link between one signed-in Gaia person and one attendee record.

    An attendee row stays event-scoped — that is correct, a ticket is for one
    event. This table is what lets a person sign in once and see every event
    they hold a ticket for, without merging those rows into a single account.

    `evidence` records *why* we believe the link, and only deterministic
    evidence is ever accepted. Names are never matched: two people called
    Sarah Miller at the same conference is not a hypothetical, and handing one
    of them the other's QR code is the worst failure this system could have.
    """
    __tablename__ = "attendee_identities"

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id"), index=True)
    # Whichever identifiers the Gaia session could prove.
    gaia_contact_id = Column(String, index=True, nullable=True)
    gaia_email = Column(String, index=True, nullable=True)
    # contact_id | verified_email | claimed — in descending order of strength.
    evidence = Column(String, default="verified_email")
    created_at = Column(DateTime, default=datetime.utcnow)

    attendee = relationship("Attendee", back_populates="identities")


class SavedSession(Base):
    """A session an attendee has saved into their own schedule.

    Keyed on the attendee rather than on a device. Someone plans their
    conference on a laptop the night before and works from a phone in the
    corridor the next morning; a schedule kept in localStorage would not make
    that trip, and rebuilding it in a hallway is exactly when nobody will.

    Unique on (attendee, session): saving twice is not an error worth showing a
    person, it just means saved.
    """
    __tablename__ = "saved_sessions"
    __table_args__ = (UniqueConstraint("attendee_id", "session_id", name="uq_saved_attendee_session"),)

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    attendee = relationship("Attendee", back_populates="saved_sessions")
    session = relationship("Session")


class SessionRegistration(Base):
    """A claimed place in a session that requires one.

    `status` is either "registered" (a confirmed chair) or "waitlisted".
    The waitlist is strictly first-come: promotion on a cancellation takes the
    earliest waitlisted row, because any cleverer policy is a policy someone
    has to defend at a registration desk.
    """
    __tablename__ = "session_registrations"
    __table_args__ = (UniqueConstraint("attendee_id", "session_id", name="uq_reg_attendee_session"),)

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    status = Column(String, default="registered", index=True)  # registered | waitlisted
    created_at = Column(DateTime, default=datetime.utcnow)

    attendee = relationship("Attendee")
    session = relationship("Session")


class SessionAttendance(Base):
    """One person actually walking into one session.

    Separate from registration on purpose: walk-in sessions have attendance and
    no registrations, and a registered no-show has a registration and no
    attendance. Conflating the two makes both numbers wrong.
    """
    __tablename__ = "session_attendance"
    __table_args__ = (UniqueConstraint("attendee_id", "session_id", name="uq_att_attendee_session"),)

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    scanned_at = Column(DateTime, default=datetime.utcnow)

    attendee = relationship("Attendee")
    session = relationship("Session")


class VenuePlace(Base):
    """One findable spot at one event's venue.

    Coordinates are percentages of the map image (0-100 from the top-left), so
    the same pin lands on the same wall whether the plan renders at 320px on a
    phone or 1200px on a lobby screen. No projection, no geo — a conference map
    is a picture of a building, and a picture needs picture coordinates.

    A booth may point at an exhibitor, which is what makes "Find on map" work
    from the directory. Rooms are matched to sessions by name at read time —
    the agenda already says "Room 2", so the place called "Room 2" is where
    that session is.
    """
    __tablename__ = "venue_places"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    # room | booth | stage | registration | restroom | food | entrance | help | other
    kind = Column(String, default="other", index=True)
    name = Column(String)
    description = Column(Text)
    x = Column(Integer, default=50)   # percent from the left
    y = Column(Integer, default=50)   # percent from the top
    exhibitor_id = Column(Integer, ForeignKey("exhibitors.id"), nullable=True, index=True)
    sort_order = Column(Integer, default=0)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    event = relationship("Event")
    exhibitor = relationship("Exhibitor")


class NetworkingProfile(Base):
    """An attendee's choice to be visible to other attendees.

    The default is that this row does not exist — nobody is in the directory
    by virtue of buying a ticket. `visible` can be turned off again at any
    time, which removes them from the directory immediately; existing accepted
    connections keep what was already exchanged, because you cannot unshake a
    hand.
    """
    __tablename__ = "networking_profiles"
    __table_args__ = (UniqueConstraint("attendee_id", name="uq_networking_attendee"),)

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    visible = Column(Boolean, default=False)
    # A line about themselves, written by them. Company and role come from the
    # attendee record; email and phone are never part of the directory.
    bio = Column(Text)
    # The digital badge card behind the printed QR. Off until the person
    # claims it; every field inside `card` was typed by them and is shown only
    # while card_public is on. Checkout data never leaks in by default.
    card_public = Column(Boolean, default=False)
    card = Column(JSON, default=dict)
    card_claimed_at = Column(DateTime, nullable=True)
    card_updated_at = Column(DateTime, nullable=True)
    card_views = Column(Integer, default=0)
    card_last_viewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    attendee = relationship("Attendee")


class UnmappedSale(Base):
    """A successful GHL payment whose product is NOT mapped to a ticket.

    Recorded, never acted on. Somebody paid, so this must be visible — but a
    product is not turned into event access because its name sounds like one.
    Staff map the product deliberately, and only then does the sale become an
    attendee. This exists because four people bought a day pass that had been
    created that morning and nobody found out until an audit.
    """
    __tablename__ = "unmapped_sales"
    __table_args__ = (UniqueConstraint("reference", name="uq_unmapped_reference"),)

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=True, index=True)
    reference = Column(String, index=True)      # the order or invoice id
    source = Column(String)                     # ghl_order | ghl_invoice
    product_id = Column(String, index=True)
    product_name = Column(String)
    buyer_name = Column(String)
    buyer_email = Column(String, index=True)
    contact_id = Column(String)
    amount = Column(Float)
    currency = Column(String)
    quantity = Column(Integer, default=1)
    paid_at = Column(String)
    funnel = Column(String)
    status = Column(String, default="pending", index=True)   # pending | mapped | dismissed
    resolved_by = Column(Integer, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    note = Column(String)
    # Triage only: does this belong in the Event review panel at all. It NEVER
    # decides access -- a product still becomes a ticket only when a human maps
    # it. Bio-Well devices and sponsorships are real sales, just not this event's.
    relevance = Column(String, default="event_like", index=True)   # event_like | unrelated
    relevance_reason = Column(String)
    first_seen = Column(DateTime, default=datetime.utcnow)


class MemberCard(Base):
    """The digital business card, owned by the PERSON — not by a ticket.

    This is the row the printed QR resolves to. It deliberately does not belong
    to an event: an event can end, be archived, or be deleted outright, and the
    badge in someone's drawer keeps working because nothing it depends on lived
    on that event's attendee row.

    `person_key` is the stable identity Gaia already resolves people by — the
    GHL contact id where we have one, otherwise the verified email. It is the
    only join between a card and a human; ticket, order and GHL identifiers are
    never part of what this row publishes.
    """
    __tablename__ = "member_cards"

    id = Column(Integer, primary_key=True, index=True)
    # "contact:<ghl id>" or "email:<lowercased address>"
    person_key = Column(String, unique=True, index=True)
    # The value printed on every badge this person has ever been given. Once
    # assigned it is never reissued: a reprint is the only way to change it.
    public_token = Column(String, unique=True, index=True)

    # A snapshot, so the card still has a name when every attendee row that
    # ever carried it has been deleted. Refreshed from live rows when they exist.
    name = Column(String)
    email = Column(String, index=True)
    phone = Column(String)
    contact_id = Column(String, index=True)

    card = Column(JSON, default=dict)
    bio = Column(Text)
    card_public = Column(Boolean, default=False)
    # When this card came to life, stamped by the person's FIRST check-in.
    #
    # Every attendee has a card and a permanent token from the moment their
    # ticket lands, months before the event. Until they walk through the door
    # that card is real but dormant: the page says so rather than presenting an
    # empty profile as though the person had nothing to say. Checking in is what
    # activates it -- one scan opens the door and switches the card on, because
    # it is the same QR either way.
    activated_at = Column(DateTime, nullable=True)
    # When the OWNER last said, themselves, whether this card is public.
    #
    # card_claimed_at cannot answer that: it records the first time a card went
    # public, so someone who deliberately chose PRIVATE looks identical to
    # someone who has never opened the editor. Activation used that, and
    # published an attendee who had chosen to stay private.
    visibility_set_at = Column(DateTime, nullable=True)
    card_claimed_at = Column(DateTime, nullable=True)
    card_views = Column(Integer, default=0)
    card_last_viewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MemberCardEvent(Base):
    """One line of "Gaia Healers events" on a permanent card.

    Written from a genuine attendee record and then KEPT. Refreshed while the
    event still exists; left standing when it is archived or deleted, because
    the person did attend, and deleting our own row about an event does not
    un-attend it. Nothing here identifies a ticket, an order or a payment.
    """
    __tablename__ = "member_card_events"
    __table_args__ = (UniqueConstraint("card_id", "event_key", name="uq_card_event"),)

    id = Column(Integer, primary_key=True, index=True)
    card_id = Column(Integer, ForeignKey("member_cards.id", ondelete="CASCADE"), index=True)
    # Survives the event row: the id if we had one, else a slug of the name.
    event_key = Column(String, index=True)
    event_name = Column(String)
    event_year = Column(String)
    starts_on = Column(DateTime, nullable=True)
    role = Column(String, default="Participant")
    attended = Column(Boolean, default=False)
    recorded_at = Column(DateTime, default=datetime.utcnow)


class Connection(Base):
    """One attendee asking to exchange contact details with another.

    Acceptance IS the consent: only an accepted connection reveals emails, in
    both directions at once — an exchange, not an extraction. A declined
    request tells the requester nothing beyond "not accepted".
    """
    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("requester_id", "target_id", name="uq_connection_pair"),)

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    requester_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    target_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    status = Column(String, default="pending", index=True)  # pending | accepted | declined
    created_at = Column(DateTime, default=datetime.utcnow)
    responded_at = Column(DateTime, nullable=True)

    requester = relationship("Attendee", foreign_keys=[requester_id])
    target = relationship("Attendee", foreign_keys=[target_id])


class Feedback(Base):
    """One attendee's rating of the event or of one session.

    One row per (attendee, target) — a second submission updates rather than
    stacks, because a changed mind is one opinion, not two. Responses are
    private: attendees see only their own, organisers see aggregates, and no
    endpoint returns another attendee's individual rating with their name on it.
    """
    __tablename__ = "feedback"
    __table_args__ = (UniqueConstraint("attendee_id", "session_id", name="uq_feedback_target"),)

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    # NULL means the rating is for the event as a whole.
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=True, index=True)
    rating = Column(Integer)          # 1..5
    comment = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    attendee = relationship("Attendee")


class PushSubscription(Base):
    """A device web-push subscription tied to one attendee (hence one event).
    Multi-event: a person subscribes per event they open; a targeted send only
    reaches subscriptions whose attendee is in that event."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id", ondelete="CASCADE"), index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String, nullable=False)
    auth = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("attendee_id", "endpoint", name="uq_push_att_endpoint"),)


class EventInfo(Base):
    """One FAQ / help / info card for an event — parking, Wi-Fi, "Need help?" and
    the like. `section` groups them; the app renders each group as a list."""
    __tablename__ = "event_info"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    section = Column(String, default="faq")  # faq | help | info
    title = Column(String)
    body = Column(Text)
    sort_order = Column(Integer, default=0)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    event = relationship("Event")


class ExportAudit(Base):
    """Who exported attendee data, when, and how many rows — the audit trail the
    spec asks for so attendee data leaving the system is always accountable."""
    __tablename__ = "export_audit"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    kind = Column(String, default="attendees")
    count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class EventResource(Base):
    """A downloadable file or link the organiser publishes for an event —
    programme PDF, venue map, exhibitor kit, hotel booking link. Managed from
    the Event Builder, no code needed for a new one."""
    __tablename__ = "event_resources"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    title = Column(String)
    description = Column(Text)
    url = Column(String)
    category = Column(String, default="general")
    sort_order = Column(Integer, default=0)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    event = relationship("Event")


class TicketMapping(Base):
    """Maps an external seller's product (e.g. a GHL product id) to an event +
    ticket type. Stable ids, not display names — so recognition survives a
    renamed product, and a new event is wired up in the admin, not in code."""
    __tablename__ = "ticket_mappings"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    provider = Column(String, default="ghl")
    external_product_id = Column(String, index=True)
    external_price_id = Column(String, nullable=True)
    ticket_type_id = Column(Integer, ForeignKey("ticket_types.id"), nullable=True)
    is_upgrade = Column(Boolean, default=False)
    label = Column(String)
    checkout_url = Column(String, nullable=True)  # authoritative GHL checkout for this upgrade product
    from_ticket_type_id = Column(Integer, nullable=True)  # per-source upgrade pricing: show only to this current tier
    # Explicit destination discriminator so separation is DECLARED, not implicit.
    # EVENT_TICKET | EVENT_UPGRADE (only event types are honored by the ticket path).
    entitlement_type = Column(String, default="EVENT_TICKET")
    addon_code = Column(String, nullable=True)  # for EVENT_ADDON: the additive grant code (e.g. ONE_DAY_CONFERENCE)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# Event community feed — a moderated public message board per event.
# Signed-in members post; everyone reads; organizers pin announcements and
# moderate. Identity is proven by the proxy (service token), never the browser.
# ---------------------------------------------------------------------------
class EventPost(Base):
    __tablename__ = "event_posts"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    author_key = Column(String, index=True)        # stable member id (GHL contact id)
    author_name = Column(String)                   # display name shown on the post
    author_photo = Column(String)                  # avatar url or ""
    author_contact_id = Column(String)             # true GHL id (admins see who it really is)
    body = Column(Text)
    image_url = Column(String)                     # optional attached image
    parent_id = Column(Integer, index=True, nullable=True)  # a reply points at its parent post
    is_announcement = Column(Boolean, default=False, index=True)
    is_pinned = Column(Boolean, default=False, index=True)
    is_hidden = Column(Boolean, default=False, index=True)
    like_count = Column(Integer, default=0)
    report_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
        # A GHL product id gets reused for next year's event. A mapping therefore
    # only grants its ticket for orders placed inside its own sales window, so
    # reusing a funnel cannot mix next year's buyers into this year's event.
    valid_from = Column(String, nullable=True)
    valid_until = Column(String, nullable=True)

    event = relationship("Event")


class EventPostLike(Base):
    __tablename__ = "event_post_likes"
    id = Column(Integer, primary_key=True)
    post_id = Column(Integer, ForeignKey("event_posts.id"), index=True)
    member_key = Column(String, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("post_id", "member_key", name="uq_post_like"),)


class EventPostReport(Base):
    __tablename__ = "event_post_reports"
    id = Column(Integer, primary_key=True)
    post_id = Column(Integer, ForeignKey("event_posts.id"), index=True)
    reporter_key = Column(String, index=True)
    reason = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("post_id", "reporter_key", name="uq_post_report"),)


class EventCommunityBan(Base):
    __tablename__ = "event_community_bans"
    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    member_key = Column(String, index=True)
    author_name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("event_id", "member_key", name="uq_event_ban"),)


class ScanLog(Base):
    """Additive access-control audit — every zone scan, granted or not. It never
    replaces attendee.is_checked_in; it records what happened alongside it."""
    __tablename__ = "scan_logs"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id"), nullable=True, index=True)
    qr_code = Column(String, index=True)
    access_type = Column(String)      # EVENT_ENTRY | EXHIBIT | CONFERENCE | WORKSHOP | VIP | SESSION
    result = Column(String)           # GRANTED | LIMITED | DENIED
    reason = Column(String)
    staff_user_id = Column(Integer, nullable=True)
    session_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class BadgePrintLog(Base):
    """Every badge print ATTEMPT, success or failure, per station. Additive like
    ScanLog: it explains attendee.badge_* but never replaces it."""
    __tablename__ = "badge_print_logs"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id"), index=True)
    station = Column(String, nullable=True)
    staff_user_id = Column(Integer, nullable=True)
    result = Column(String)            # printed | failed
    error = Column(String, nullable=True)
    # A retry re-sends the same id; the log keeps one row per attempt, not per click.
    client_attempt_id = Column(String, nullable=True, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class MapReconcileRun(Base):
    """One Map & Reconcile action, kept so the question "who let this product in,
    and what did it create?" always has an answer. The preview that staff
    approved is stored alongside the result, so a surprising outcome can be
    compared against what they were shown."""
    __tablename__ = "map_reconcile_runs"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    product_id = Column(String, index=True)        # immutable GHL product id
    product_name = Column(String)                  # display only, never matched on
    ticket_type_id = Column(Integer, ForeignKey("ticket_types.id"))
    is_upgrade = Column(Boolean, default=False)
    entitlement_type = Column(String, default="EVENT_TICKET")
    preview = Column(JSON)                         # exactly what was shown before approval
    result = Column(JSON)                          # what the replay actually did
    created = Column(Integer, default=0)
    updated = Column(Integer, default=0)
    skipped = Column(Integer, default=0)
    failed = Column(Integer, default=0)
    actor_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)


class CardVerification(Base):
    """A one-time code proving somebody is who they say they are before they
    change the identity on their card.

    The code is never stored. Only a salted SHA-256 of it is kept, so a copy of
    this table does not let anyone complete a verification, and nothing here is
    ever returned through the public card API.

    Two purposes, and the difference is the whole point of the feature:

      identity   -- prove you are the CURRENT owner, using a contact method
                    already on file. The code goes to the OLD address.
      new_email  -- prove the NEW address really belongs to you, after the
      new_phone    identity step has already passed. Until this succeeds the
                    trusted contact value is not replaced.

    That ordering is what stops somebody who finds an unlocked session from
    quietly swapping the recovery email for their own.
    """
    __tablename__ = "card_verifications"

    id = Column(Integer, primary_key=True, index=True)
    card_id = Column(Integer, ForeignKey("member_cards.id"), index=True)
    purpose = Column(String, index=True)          # identity | new_email | new_phone
    dest_kind = Column(String)                    # email | phone
    dest_masked = Column(String)                  # what the user was shown
    code_hash = Column(String)                    # sha256(salt + code); never the code
    salt = Column(String)
    pending_value = Column(String)                # the new address, for new_* only
    attempts = Column(Integer, default=0)
    max_attempts = Column(Integer, default=5)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    expires_at = Column(DateTime, index=True)
    consumed_at = Column(DateTime, nullable=True)


class CardVerificationSession(Base):
    """A short-lived permit to edit the protected fields, minted only by a
    successful identity verification. The token itself is hashed, so the row
    cannot be replayed by anyone reading the database."""
    __tablename__ = "card_verification_sessions"

    id = Column(Integer, primary_key=True, index=True)
    card_id = Column(Integer, ForeignKey("member_cards.id"), index=True)
    token_hash = Column(String, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, index=True)
    revoked_at = Column(DateTime, nullable=True)
