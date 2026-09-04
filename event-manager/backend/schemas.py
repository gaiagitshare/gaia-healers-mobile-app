from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime

# User schemas
class UserBase(BaseModel):
    email: str
    full_name: str

class UserCreate(UserBase):
    password: str

class User(UserBase):
    id: int
    is_admin: bool
    created_at: datetime
    
    class Config:
        from_attributes = True

# Event schemas
class EventBase(BaseModel):
    name: str
    description: Optional[str] = None
    start_date: datetime
    end_date: datetime
    location: Optional[str] = None

class EventCreate(EventBase):
    custom_fields: Optional[List[Dict[str, Any]]] = []
    badge_template: Optional[str] = None
    timezone: Optional[str] = "UTC"   # IANA name; times above are local to it
    is_published: Optional[bool] = False
    hero_image_url: Optional[str] = None
    registration_url: Optional[str] = None
    registration_label: Optional[str] = None

class EventUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    location: Optional[str] = None
    is_active: Optional[bool] = None
    custom_fields: Optional[List[Dict[str, Any]]] = None
    badge_template: Optional[str] = None
    source_url: Optional[str] = None
    timezone: Optional[str] = None
    is_published: Optional[bool] = None
    live_enabled: Optional[bool] = None
    live_message: Optional[str] = None
    hero_image_url: Optional[str] = None
    registration_url: Optional[str] = None
    registration_label: Optional[str] = None
    # Operational switches: attendance counters on the public live page,
    # attendee networking, and the venue plan image.
    public_counters: Optional[bool] = None
    networking_enabled: Optional[bool] = None
    map_image_url: Optional[str] = None
    # Pass an explicit list to reset which fields are locked from auto-sync.
    # If omitted, any field edited here is auto-locked so the scraper won't clobber it.
    locked_fields: Optional[List[str]] = None

class Event(EventBase):
    # Optional on purpose: the list endpoint serialises EVERY event, so one row
    # missing any of these raised ResponseValidationError and blanked the whole
    # Events page. A partially-populated row must degrade, never erase the list.
    id: int
    # A scraped event may have no parseable date yet — tolerate null in responses
    # (EventCreate still requires real dates for manual creation).
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_active: bool
    # Exposed so the Admin can LABEL a past event rather than hide it:
    # archived means read-only, not invisible.
    is_archived: Optional[bool] = False
    custom_fields: List[Dict[str, Any]]
    badge_template: Optional[str]
    source_url: Optional[str] = None
    locked_fields: List[str] = []
    timezone: Optional[str] = None
    is_published: Optional[bool] = None
    live_enabled: Optional[bool] = None
    live_message: Optional[str] = None
    hero_image_url: Optional[str] = None
    registration_url: Optional[str] = None
    registration_label: Optional[str] = None
    # Present in the response so the admin switches render their real state.
    # A response schema that lags the write schema shows every switch as off
    # the moment the page reloads — the third bug of this class today, so:
    # any new writable field goes in BOTH schemas, always.
    public_counters: bool = False
    networking_enabled: bool = False
    map_image_url: Optional[str] = None
    # Unambiguous instants: the same moment however the reader's device is set.
    # start_date/end_date above stay venue-local for display.
    start_at: Optional[str] = None      # ISO 8601 with the venue's UTC offset
    end_at: Optional[str] = None
    server_time: Optional[str] = None   # authoritative now, same format
    created_at: datetime
    attendee_count: Optional[int] = 0
    checked_in_count: Optional[int] = 0
    # Real counts, so the app never has to invent or hardcode them.
    exhibitor_count: Optional[int] = 0
    lead_count: Optional[int] = 0
    session_count: Optional[int] = 0
    speaker_count: Optional[int] = 0

    class Config:
        from_attributes = True

class EventGrabRequest(BaseModel):
    url: str
    event_id: Optional[int] = None

class AttendeeImportResponse(BaseModel):
    imported: int
    skipped: int
    errors: List[str] = []

# Attendee schemas
class AttendeeBase(BaseModel):
    email: str
    first_name: str
    last_name: str
    company: Optional[str] = None
    job_title: Optional[str] = None
    phone: Optional[str] = None

class AttendeeCreate(AttendeeBase):
    event_id: int
    ticket_type_id: Optional[int] = None
    custom_data: Optional[Dict[str, Any]] = {}

class AttendeeUpdate(BaseModel):
    # Email is editable so an operator can fix a typo taken at registration.
    # It is the key the registration webhook matches on, so correcting it here
    # also repairs future syncs for that person.
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    company: Optional[str] = None
    job_title: Optional[str] = None
    phone: Optional[str] = None
    custom_data: Optional[Dict[str, Any]] = None
    registration_status: Optional[str] = None
    # The canonical pass. Access flows from the ticket type row, never the name.
    ticket_type_id: Optional[int] = None
    # Consent is the attendee's, but an operator may record a change the
    # attendee asks for at the desk.
    share_email_with_exhibitors: Optional[bool] = None
    share_phone_with_exhibitors: Optional[bool] = None

class Attendee(AttendeeBase):
    id: int
    event_id: int
    qr_code: str
    public_token: Optional[str] = None
    badge_printed_at: Optional[datetime] = None
    badge_print_count: Optional[int] = 0
    badge_last_station: Optional[str] = None
    badge_last_result: Optional[str] = None
    badge_last_error: Optional[str] = None
    # The printed badge card: its permanent link and whether the owner has
    # set it up. unclaimed | private | public
    card_url: Optional[str] = None
    card_state: Optional[str] = None
    # How they arrived (immutable), why they get a badge, and any money taken
    # at our own desk — never GHL-verified revenue.
    registration_source: Optional[str] = None
    attendance_type: Optional[str] = None
    ghl_linked_at: Optional[datetime] = None
    door_payment_status: Optional[str] = None
    door_payment_method: Optional[str] = None
    door_payment_amount: Optional[float] = None
    door_payment_currency: Optional[str] = None
    door_payment_reference: Optional[str] = None
    door_payment_at: Optional[datetime] = None
    door_payment_note: Optional[str] = None
    is_checked_in: bool
    checked_in_at: Optional[datetime]
    registration_status: str
    custom_data: Dict[str, Any]
    # The canonical pass, so the admin editor can show and change it.
    ticket_type_id: Optional[int] = None
    effective_access: Optional[Dict[str, Any]] = None
    created_at: datetime
    
    class Config:
        from_attributes = True

    # Acquisition / purchase source (see models.Attendee). All Optional:
    # GHL does not capture a referrer or UTM for every buyer.
    acq_purchased_at: Optional[str] = None
    acq_order_id: Optional[str] = None
    acq_contact_id: Optional[str] = None
    acq_product_id: Optional[str] = None
    acq_product_name: Optional[str] = None
    acq_price: Optional[float] = None
    acq_funnel_name: Optional[str] = None
    acq_funnel_id: Optional[str] = None
    acq_checkout_type: Optional[str] = None
    acq_page_id: Optional[str] = None
    acq_page_url: Optional[str] = None
    acq_domain: Optional[str] = None
    acq_landing_url: Optional[str] = None
    acq_referrer: Optional[str] = None
    acq_session_source: Optional[str] = None
    acq_contact_source: Optional[str] = None
    acq_utm_source: Optional[str] = None
    acq_utm_medium: Optional[str] = None
    acq_utm_campaign: Optional[str] = None
    acq_utm_content: Optional[str] = None
    acq_utm_term: Optional[str] = None
    acq_kind: Optional[str] = None
    acq_order_status: Optional[str] = None
    acq_page_name: Optional[str] = None
    acq_purchase_url: Optional[str] = None
    acq_referrer_domain: Optional[str] = None
    acq_saw_on: Optional[str] = None
    acq_source_value: Optional[str] = None
    acq_source_basis: Optional[str] = None
    acq_issued_at: Optional[str] = None
    acq_issuance_method: Optional[str] = None
    acq_last_purchased_at: Optional[str] = None
    acq_purchase_count: Optional[int] = None

class AttendeeDetail(Attendee):
    event: Optional[Event] = None
    effective_access: Optional[Dict[str, Any]] = None
    entitlement_history: Optional[List[Dict[str, Any]]] = None

class CheckInRequest(BaseModel):
    qr_code: str

class AuthorizeRequest(BaseModel):
    qr_code: str
    access_type: str = 'EVENT_ENTRY'   # EVENT_ENTRY|EXHIBIT|CONFERENCE|WORKSHOP|VIP|SESSION
    at: Optional[str] = None            # ISO date override for testing (else event-local today)
    session_id: Optional[int] = None

class AddonDay(BaseModel):
    addon_code: str = 'ONE_DAY_CONFERENCE'
    day_label: str                      # human, e.g. 'Saturday, Nov 21'
    day_date: str                       # ISO, e.g. '2026-11-21'
    reason: Optional[str] = None

class CheckInResponse(BaseModel):
    success: bool
    attendee: Optional[Attendee] = None
    message: str

# Exhibitor schemas
class ExhibitorBase(BaseModel):
    company_name: str
    booth_number: Optional[str] = None
    contact_email: str
    contact_phone: Optional[str] = None

class ExhibitorCreate(ExhibitorBase):
    event_id: int
    description: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    category: Optional[str] = None
    sort_order: Optional[int] = 0
    # An operator adding a vendor wants attendees to find it, so it goes into the
    # directory unless they say otherwise.
    is_published: Optional[bool] = True
    stage: Optional[str] = None                   # confirmed | waiting | unsure | ...
    public_email: Optional[str] = None            # from their own website
    public_phone: Optional[str] = None
    address: Optional[str] = None
    tagline: Optional[str] = None
    logo_on_dark: Optional[bool] = None
    package: Optional[str] = None
    payment_status: Optional[str] = None          # paid | partial | unpaid | comp
    amount_due: Optional[float] = None
    amount_paid: Optional[float] = None
    payment_note: Optional[str] = None
    show_contact_publicly: Optional[bool] = None

class ExhibitorUpdate(BaseModel):
    company_name: Optional[str] = None
    booth_number: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    description: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    category: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None
    # Scanning is sold and granted, not implied by existing.
    can_scan_leads: Optional[bool] = None
    stage: Optional[str] = None                   # confirmed | waiting | unsure | ...
    public_email: Optional[str] = None            # from their own website
    public_phone: Optional[str] = None
    address: Optional[str] = None
    tagline: Optional[str] = None
    logo_on_dark: Optional[bool] = None
    package: Optional[str] = None
    payment_status: Optional[str] = None          # paid | partial | unpaid | comp
    amount_due: Optional[float] = None
    amount_paid: Optional[float] = None
    payment_note: Optional[str] = None
    show_contact_publicly: Optional[bool] = None

class Exhibitor(ExhibitorBase):
    id: int
    event_id: int
    access_token: str
    created_at: datetime
    lead_count: Optional[int] = 0
    description: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    category: Optional[str] = None
    sort_order: int = 0
    is_published: bool = False
    # Admin-facing only (ExhibitorPublic below never carries it): whether this
    # stand's scanner link actually works.
    can_scan_leads: bool = False
    stage: Optional[str] = "confirmed"
    public_email: Optional[str] = None
    public_phone: Optional[str] = None
    address: Optional[str] = None
    tagline: Optional[str] = None
    logo_on_dark: Optional[bool] = None
    package: Optional[str] = None
    payment_status: Optional[str] = "unpaid"
    amount_due: Optional[float] = None
    amount_paid: Optional[float] = None
    payment_note: Optional[str] = None
    show_contact_publicly: bool = False

    class Config:
        from_attributes = True

class VendorSetup(BaseModel):
    """What a stand may write about itself through a setup link.

    Note what is absent: package, amount_due, amount_paid, payment_status,
    booth_number and can_scan_leads. Those are the organiser's, and leaving them
    out of the payload is a stronger guarantee than checking for them.
    """
    company_name: Optional[str] = None
    description: Optional[str] = None
    website: Optional[str] = None
    logo_url: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    show_contact_publicly: Optional[bool] = None
    publish: bool = False


class ExhibitorPublic(BaseModel):
    """Directory entry. Never carries the scanning access_token, the package,
    what they paid, or anything else the organiser holds.

    Contact details appear only where the stand asked for them to -- some of
    these addresses are a personal mailbox, so the organiser switches it on per
    vendor rather than the directory assuming a business is happy to publish."""
    id: int
    company_name: str
    booth_number: Optional[str] = None
    description: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    category: Optional[str] = None
    tagline: Optional[str] = None
    address: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None

    class Config:
        from_attributes = True

# Lead schemas
class LeadBase(BaseModel):
    notes: Optional[str] = None
    rating: Optional[int] = None

class LeadCreate(LeadBase):
    attendee_id: int

class Lead(LeadBase):
    id: int
    exhibitor_id: int
    attendee_id: int
    scanned_at: datetime
    attendee: Optional[Attendee] = None
    
    class Config:
        from_attributes = True


class LeadPublic(LeadBase):
    # The exhibitor-scanner-safe lead. attendee is the consent-filtered dict from
    # authz.lead_public_view — never the ORM Attendee (which carries email/phone).
    id: int
    exhibitor_id: int
    attendee_id: int
    scanned_at: datetime
    attendee: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True

# QR Code scan for exhibitors
class QRScanRequest(BaseModel):
    qr_code: str
    access_token: str

class QRScanResponse(BaseModel):
    success: bool
    # A consent-filtered dict, not the Attendee model. Typing it as Attendee is
    # exactly how the full record — email and phone included — used to reach any
    # holder of a scanner token.
    attendee: Optional[Dict[str, Any]] = None
    message: str
    lead_id: Optional[int] = None

class LeadPublicUpdate(BaseModel):
    access_token: str
    notes: Optional[str] = None
    rating: Optional[int] = None

# Speaker schemas
class SpeakerBase(BaseModel):
    name: str
    role: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    photo_url: Optional[str] = None
    links: Optional[Dict[str, Any]] = {}
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = False

    is_featured: Optional[bool] = False

class SpeakerCreate(SpeakerBase):
    pass

class SpeakerUpdate(BaseModel):
    name: Optional[str] = None
    is_featured: Optional[bool] = None
    role: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    photo_url: Optional[str] = None
    links: Optional[Dict[str, Any]] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None

class Speaker(SpeakerBase):
    id: int
    event_id: int
    created_at: datetime

    class Config:
        from_attributes = True

class SpeakerSession(BaseModel):
    """Just enough of a session to link to it from a speaker."""
    id: int
    title: str
    start_time: Optional[datetime] = None
    room: Optional[str] = None

    class Config:
        from_attributes = True

class SpeakerPublic(BaseModel):
    id: int
    name: str
    role: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    photo_url: Optional[str] = None
    links: Dict[str, Any] = {}
    is_featured: bool = False
    sessions: List[SpeakerSession] = []

    class Config:
        from_attributes = True

# Session (agenda) schemas
class SessionBase(BaseModel):
    title: str
    description: Optional[str] = None
    session_type: Optional[str] = "talk"   # talk | workshop | panel | break | social
    track: Optional[str] = None
    room: Optional[str] = None
    # Venue-local times. The event's `timezone` says which zone that is.
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    capacity: Optional[int] = None
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = False

    is_featured: Optional[bool] = False

class SessionCreate(SessionBase):
    speaker_ids: Optional[List[int]] = []
    external_id: Optional[str] = None

class SessionUpdate(BaseModel):
    title: Optional[str] = None
    is_featured: Optional[bool] = None
    description: Optional[str] = None
    session_type: Optional[str] = None
    track: Optional[str] = None
    room: Optional[str] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    capacity: Optional[int] = None
    requires_registration: Optional[bool] = None
    needs_workshop_pass: Optional[bool] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None
    speaker_ids: Optional[List[int]] = None

class Session(SessionBase):
    id: int
    event_id: int
    external_id: Optional[str] = None
    # Present in the response so the admin edit dialog hydrates the switches it
    # saved — a response schema that lags the write schema shows every session
    # as walk-in the moment you reopen it.
    requires_registration: bool = False
    needs_workshop_pass: bool = False
    created_at: datetime
    speakers: List[SpeakerPublic] = []

    class Config:
        from_attributes = True

class SessionPublic(BaseModel):
    id: int
    title: str
    description: Optional[str] = None
    session_type: str = "talk"
    track: Optional[str] = None
    room: Optional[str] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    is_featured: bool = False
    speakers: List[SpeakerPublic] = []
    # Registration state, present only on sessions that take registrations.
    # Counts, never names: "3 places left" is programme information, the list
    # of who claimed them is not.
    availability: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True

class AgendaDay(BaseModel):
    """Sessions grouped by venue-local calendar day, in start order."""
    date: str          # YYYY-MM-DD, venue-local
    label: str         # e.g. "Friday, November 20"
    sessions: List[SessionPublic] = []

class Agenda(BaseModel):
    event_id: int
    event_name: str
    timezone: str
    days: List[AgendaDay] = []
    # Published sessions with no time yet. They cannot sit on a day, but hiding
    # them entirely made operators think they had been lost.
    unscheduled: List[SessionPublic] = []

# Sponsor schemas
class SponsorBase(BaseModel):
    name: str
    tier: Optional[str] = "partner"   # headline | gold | silver | partner
    logo_url: Optional[str] = None
    website: Optional[str] = None
    blurb: Optional[str] = None
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = True

class SponsorCreate(SponsorBase):
    pass

class SponsorUpdate(BaseModel):
    name: Optional[str] = None
    tier: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    blurb: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None

class Sponsor(SponsorBase):
    id: int
    event_id: int
    created_at: datetime

    class Config:
        from_attributes = True

class SponsorPublic(BaseModel):
    id: int
    name: str
    tier: str = "partner"
    logo_url: Optional[str] = None
    website: Optional[str] = None
    blurb: Optional[str] = None

    class Config:
        from_attributes = True

# Announcement schemas
class AnnouncementBase(BaseModel):
    title: str
    body: Optional[str] = None
    is_pinned: Optional[bool] = False
    is_published: Optional[bool] = True
    scheduled_for: Optional[datetime] = None
    audience: Optional[dict] = None

class AnnouncementCreate(AnnouncementBase):
    pass

class AnnouncementUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    is_pinned: Optional[bool] = None
    is_published: Optional[bool] = None
    scheduled_for: Optional[datetime] = None
    audience: Optional[dict] = None

class Announcement(AnnouncementBase):
    id: int
    event_id: int
    created_at: datetime

    class Config:
        from_attributes = True

class AnnouncementPublic(BaseModel):
    id: int
    title: str
    body: Optional[str] = None
    is_pinned: bool = False
    created_at: datetime

    class Config:
        from_attributes = True

# Live event surface
class LiveSession(SessionPublic):
    """A session on the live page, with the countdown the display needs."""
    minutes_remaining: Optional[int] = None   # set for sessions running now
    minutes_until: Optional[int] = None       # set for sessions still to come

class LiveCounters(BaseModel):
    # Nullable on purpose: None means "not published for this event", which the
    # client renders by omitting the tile. Zero would be a claim — that nobody
    # has registered — and that is a different statement entirely.
    attendees: Optional[int] = None
    checked_in: Optional[int] = None
    check_in_rate: Optional[int] = None
    exhibitors: int = 0
    sponsors: int = 0
    speakers: int = 0
    leads: int = 0
    sessions_today: int = 0

class LiveEvent(BaseModel):
    event_id: int
    event_name: str
    timezone: str
    live_enabled: bool
    live_message: Optional[str] = None
    # Venue-local clock the display counts against, so a screen with a wrong
    # system clock still agrees with the schedule.
    server_time: str
    today: Optional[str] = None
    status: str = "before"      # before | running | ended
    now: List[LiveSession] = []
    next: List[LiveSession] = []
    counters: LiveCounters = LiveCounters()
    announcements: List[AnnouncementPublic] = []
    sponsors: List[SponsorPublic] = []

class BulkAction(BaseModel):
    """publish | unpublish | feature | unfeature | delete. Empty ids means every
    row of that entity within the event."""
    action: str
    ids: Optional[List[int]] = None

# Registration form
class RegistrationForm(BaseModel):
    event_id: int
    first_name: str
    last_name: str
    email: str
    company: Optional[str] = None
    job_title: Optional[str] = None
    phone: Optional[str] = None
    custom_data: Optional[Dict[str, Any]] = {}


class IdentityLookup(BaseModel):
    """Who the Gaia proxy has proved this person to be.

    `email_verified` is not decoration. The proxy sets it only when the session
    was established through a magic link to that address; a merely claimed
    email must not unlock a ticket, and the resolver refuses to fall back.
    """
    contact_id: Optional[str] = None
    email: Optional[str] = None
    email_verified: bool = False
    # Whether to persist the resulting links. Read-only callers pass False.
    record_links: bool = True


class IdentityTicketLookup(IdentityLookup):
    event_id: int


class ScheduleChange(IdentityTicketLookup):
    """Saving or removing one session from an attendee's own schedule."""
    session_id: int


class PlaceCreate(BaseModel):
    kind: str = "other"
    name: str
    description: Optional[str] = None
    x: int = 50
    y: int = 50
    exhibitor_id: Optional[int] = None
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = True


class PlaceUpdate(BaseModel):
    kind: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    exhibitor_id: Optional[int] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None


class NetworkingProfileChange(IdentityTicketLookup):
    visible: bool = False
    bio: Optional[str] = None


class ConnectionRequest(IdentityTicketLookup):
    target_attendee_id: int


class ConnectionResponse(IdentityTicketLookup):
    connection_id: int
    accept: bool


class FeedbackSubmit(IdentityTicketLookup):
    # NULL session_id rates the event as a whole.
    session_id: Optional[int] = None
    rating: int
    comment: Optional[str] = None


class TicketTypeCreate(BaseModel):
    valid_day: Optional[str] = None
    code: str                    # canonical (a price id), never display copy
    name: str
    description: Optional[str] = None
    is_vip: bool = False
    grants_workshops: bool = False
    sort_order: Optional[int] = 0


class TicketTypeUpdate(BaseModel):
    # Editable, so a day pass can be corrected without a database write.
    valid_day: Optional[str] = None
    code: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    is_vip: Optional[bool] = None
    grants_workshops: Optional[bool] = None
    sort_order: Optional[int] = None


class RoleGrant(BaseModel):
    email: str
    role: str                    # organizer | checkin_staff | exhibitor_manager
    # Set only when the account does not exist yet; ignored otherwise.
    password: Optional[str] = None
    full_name: Optional[str] = None


class PushSubscribe(BaseModel):
    contact_id: Optional[str] = None
    email: Optional[str] = None
    email_verified: bool = False
    event_id: int
    subscription: dict


class PushUnsubscribe(BaseModel):
    contact_id: Optional[str] = None
    email: Optional[str] = None
    email_verified: bool = False
    endpoint: str


class NotificationSend(BaseModel):
    title: str
    body: str
    url: Optional[str] = None
    audience: Optional[dict] = None
    also_announce: bool = True


class EventInfoBase(BaseModel):
    section: Optional[str] = "faq"
    title: str
    body: Optional[str] = None
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = True

class EventInfoCreate(EventInfoBase):
    pass

class EventInfoUpdate(BaseModel):
    section: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None

class EventInfo(EventInfoBase):
    id: int
    event_id: int
    class Config:
        from_attributes = True


class EventResourceBase(BaseModel):
    title: str
    description: Optional[str] = None
    url: Optional[str] = None
    category: Optional[str] = "general"
    sort_order: Optional[int] = 0
    is_published: Optional[bool] = True

class EventResourceCreate(EventResourceBase):
    pass

class EventResourceUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    category: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None

class EventResource(EventResourceBase):
    id: int
    event_id: int
    class Config:
        from_attributes = True


class TicketMappingBase(BaseModel):
    provider: Optional[str] = "ghl"
    external_product_id: str
    external_price_id: Optional[str] = None
    ticket_type_id: Optional[int] = None
    is_upgrade: Optional[bool] = False
    label: Optional[str] = None
    is_active: Optional[bool] = True
    checkout_url: Optional[str] = None
    from_ticket_type_id: Optional[int] = None
    entitlement_type: Optional[str] = None
    addon_code: Optional[str] = None


class RefundTicket(BaseModel):
    event_id: Optional[int] = None
    email: Optional[str] = None
    order_id: Optional[str] = None
    invoice_id: Optional[str] = None
    transaction_id: Optional[str] = None
    amount: Optional[float] = None
    amount_refunded: Optional[float] = None
    full: Optional[bool] = True
    reason: Optional[str] = None
    actor: Optional[str] = "reconcile"


class RevokeTicket(BaseModel):
    reason: Optional[str] = None


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


class ChangePass(BaseModel):
    ticket_type_id: int
    reason: Optional[str] = None
    complimentary: Optional[bool] = True
    allow_downgrade: Optional[bool] = False
    label: Optional[str] = None
    is_active: Optional[bool] = True

class TicketMappingCreate(TicketMappingBase):
    pass

class TicketMappingUpdate(BaseModel):
    external_product_id: Optional[str] = None
    external_price_id: Optional[str] = None
    ticket_type_id: Optional[int] = None
    is_upgrade: Optional[bool] = None
    label: Optional[str] = None
    is_active: Optional[bool] = None
    checkout_url: Optional[str] = None
    from_ticket_type_id: Optional[int] = None

class TicketMapping(TicketMappingBase):
    id: int
    event_id: int
    class Config:
        from_attributes = True

class UnmappedSaleIn(BaseModel):
    """Reported by the sync when a paid product has no ticket mapping."""
    event_id: Optional[int] = None
    reference: str
    source: str = "ghl_order"
    product_id: Optional[str] = None
    product_name: Optional[str] = None
    buyer_name: Optional[str] = None
    buyer_email: Optional[str] = None
    contact_id: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[str] = "USD"
    quantity: Optional[int] = 1
    paid_at: Optional[str] = None
    funnel: Optional[str] = None


class ReconcileInvoice(BaseModel):
    """A PAID GHL invoice for an event ticket. Distinct from an order: it has
    its own id, and no order id is ever invented for it."""
    event_id: int
    email: str
    invoice_id: str
    transaction_id: Optional[str] = None
    contact_id: Optional[str] = None
    product_id: Optional[str] = None
    price_id: Optional[str] = None
    amount: Optional[float] = None
    quantity: Optional[int] = 1
    status: Optional[str] = "paid"
    first_name: Optional[str] = ""
    last_name: Optional[str] = ""
    phone: Optional[str] = None
    issued_at: Optional[str] = None


class MapReconcileRequest(BaseModel):
    """Map ONE immutable GHL product id to ONE Gaia ticket type, and optionally
    replay its history. product_id is the whole key: names are display only,
    because a renamed product must not become a second, separate thing."""
    product_id: str
    ticket_type_id: Optional[int] = None
    is_upgrade: bool = False
    entitlement_type: str = "EVENT_TICKET"
    addon_code: Optional[str] = None
    label: Optional[str] = None
    valid_day: Optional[str] = None
    confirm: bool = False          # apply requires an explicit yes
    preview_token: Optional[str] = None   # ties an apply to the preview shown


class ReconcileAttendee(BaseModel):
    event_id: int
    email: str
    ticket_type_id: Optional[int] = None
    first_name: Optional[str] = ""
    last_name: Optional[str] = ""
    phone: Optional[str] = None
    contact_id: Optional[str] = None
    order_id: Optional[str] = None
    product_id: Optional[str] = None
    price_id: Optional[str] = None
    quantity: Optional[int] = 1
    purchased_at: Optional[str] = None   # when GHL took the money
    amount: Optional[float] = None
    is_upgrade: Optional[bool] = False
    addon_code: Optional[str] = None
    day: Optional[str] = None
    day_date: Optional[str] = None


# --- Event community feed ---
class PostCreate(IdentityLookup):
    body: str = ""
    author_name: Optional[str] = None
    author_photo: Optional[str] = None
    image_url: Optional[str] = None
    parent_id: Optional[int] = None


class PostInteract(IdentityLookup):
    reason: Optional[str] = None


class PostFeedRequest(IdentityLookup):
    since: int = 0
    limit: int = 60


class BadgePrintRecord(BaseModel):
    """One print attempt reported by a station. Never touches check-in."""
    result: str                       # printed | failed
    station: Optional[str] = None
    error: Optional[str] = None
    client_attempt_id: Optional[str] = None


class UndoCheckIn(BaseModel):
    reason: str


class DoorTestMode(BaseModel):
    enabled: bool = False


class CardVerifyStart(IdentityTicketLookup):
    """Ask for a code at a contact method already on file. The destination is
    chosen by opaque id, never by typing an address: the caller cannot name a
    destination the person does not already have."""
    destination_id: Optional[str] = None


class CardVerifyConfirm(IdentityTicketLookup):
    code: Optional[str] = None


class CardVerifyNewStart(IdentityTicketLookup):
    """Second step. The permit from step one is required, so a new address can
    never be verified before the current owner has proved themselves."""
    verification_token: Optional[str] = None
    kind: Optional[str] = None            # email | phone
    value: Optional[str] = None


class CardVerifyNewConfirm(IdentityTicketLookup):
    verification_token: Optional[str] = None
    kind: Optional[str] = None
    code: Optional[str] = None


class CardUpdate(IdentityTicketLookup):
    """The owner editing their own digital card. Every field optional; the
    Event Manager sanitises and stores only what it recognises."""
    public: Optional[bool] = None
    bio: Optional[str] = None
    company: Optional[str] = None
    title: Optional[str] = None
    city: Optional[str] = None
    website: Optional[str] = None
    instagram: Optional[str] = None
    linkedin: Optional[str] = None
    whatsapp: Optional[str] = None
    photo_url: Optional[str] = None
    show_email: Optional[bool] = None
    show_phone: Optional[bool] = None
    # A list, or one comma-separated string - the sanitiser accepts both.
    tags: Optional[Any] = None
    display_name: Optional[str] = None
    headline: Optional[str] = None
    # Protected: the fields that make the card an identity.
    #
    # full_name is written here, with a permit from a completed identity
    # verification. Email and phone are NOT: they are deliberately named
    # new_email / new_phone rather than email / phone, because this payload
    # already carries `email` as the identity of the CALLER -- one field
    # meaning both "who I am" and "who I want to become" is how a card update
    # would quietly change which account it was editing. They exist here only
    # so a client that tries the shortcut gets pointed at the two-step flow.
    full_name: Optional[str] = None
    new_email: Optional[str] = None
    new_phone: Optional[str] = None
    verification_token: Optional[str] = None
    booking_url: Optional[str] = None
    facebook: Optional[str] = None
    tiktok: Optional[str] = None
    youtube: Optional[str] = None
    services: Optional[Any] = None
    theme: Optional[str] = None


class WalkInCheck(BaseModel):
    """Only enough to ask "do we already know this person?" -- nothing is
    written, so nothing beyond a name and an address is demanded."""
    first_name: Optional[str] = ""
    last_name: Optional[str] = ""
    email: Optional[str] = ""
    phone: Optional[str] = None


class WalkInCreate(BaseModel):
    """Someone registering at the door. Email is required: it is how we tell
    them apart from an existing member and how their claim link reaches them."""
    first_name: str
    last_name: str = ""
    email: str
    # Required on CREATE, and only there. Every attendee's card carries a name,
    # an email and a phone; a walk-in registered without one produces a card
    # that can never be published -- found out later, at the worst moment.
    #
    # The duplicate CHECK deliberately does not require it: staff type a name
    # and an address, and the system answers "we already know this person"
    # before they have finished filling anything else in. Demanding a phone to
    # ask that question is how a queue forms. See WalkInCheck below.
    phone: str
    ticket_type_id: Optional[int] = None
    note: Optional[str] = None
    # WHY they need a badge. Being a walk-in says nothing about payment, so
    # this is asked explicitly and never inferred.
    attendance_type: Optional[str] = "paid"
    # Money taken by us, at our desk. Never a GHL transaction.
    door_payment_status: Optional[str] = None      # none|pending|collected|waived
    door_payment_method: Optional[str] = None      # cash|card_terminal|payment_link|other
    door_payment_amount: Optional[float] = None
    door_payment_currency: Optional[str] = "USD"
    door_payment_reference: Optional[str] = None
    # Staff answered "no, this is somebody new" to the duplicate warning.
    confirm_new: bool = False
    # Staff picked one of the offered matches: reuse that person's card.
    link_token: Optional[str] = None
    check_in: bool = False


class ConnectByToken(IdentityTicketLookup):
    token: str
