// Shift times are the event's wall-clock time stored as text ("09:00" on
// "2026-11-20"); they are formatted as text and never pass through a time zone.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function dayLabel(day) {
    const [y, m, d] = String(day || '').split('-').map(Number);
    if (!y) return day;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${DAYS[dow]}, ${MONTHS[m - 1]} ${d}`;
}

export function timeLabel(hhmm) {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function shiftTime(s) {
    if (s.lead_role) return `All day lead (${timeLabel(s.start_time)} – ${timeLabel(s.end_time)})`;
    return `${timeLabel(s.start_time)} – ${timeLabel(s.end_time)}`;
}

export function byDay(shifts) {
    const out = [];
    for (const s of shifts) {
        let g = out.find((x) => x.day === s.day);
        if (!g) { g = { day: s.day, shifts: [] }; out.push(g); }
        g.shifts.push(s);
    }
    return out;
}
