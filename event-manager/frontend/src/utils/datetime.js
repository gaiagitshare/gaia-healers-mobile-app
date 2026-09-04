// Check-in times are stored as naive UTC. They have to be marked as UTC before
// parsing, then rendered in the event's own timezone — an operator working the
// door reads the time on the venue clock, not on whatever clock their laptop is
// set to. Any screen showing an attendee timestamp goes through here.
export function formatVenueTime(value, timezone) {
    if (!value) return '';
    const stamp = new Date(`${String(value).replace(' ', 'T').replace(/Z$/, '')}Z`);
    if (Number.isNaN(stamp.getTime())) return '';
    try {
        return stamp.toLocaleString(undefined, {
            timeZone: timezone || undefined,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch (error) {
        // An unknown IANA name should not cost the operator the timestamp.
        return stamp.toLocaleString();
    }
}

// The stored registration statuses, mapped to what an operator should read.
// Anything the backend adds later still renders — it falls through to its raw
// value rather than disappearing.
export const STATUS_LABELS = {
    registered: 'Registered',
    cancelled: 'Cancelled',
    'no-show': 'No Show',
};

export const statusLabel = (attendee) => (
    STATUS_LABELS[attendee?.registration_status] || attendee?.registration_status || 'Registered'
);

// Cancelled and no-show registrations are the ones an operator must notice
// before admitting somebody, so they are called out rather than shown flat.
export const isFlaggedStatus = (attendee) => (
    ['cancelled', 'no-show'].includes(attendee?.registration_status)
);
