// Which event "Events" opens (7 Nov 2026): the event running now, else the
// nearest upcoming one. Archived and finished events are never chosen; they
// stay reachable from All Events.
const DAY = 24 * 60 * 60 * 1000;

const ts = (v) => {
    if (!v) return NaN;
    const s = String(v);
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
};

export function pickCurrentEvent(events, now = Date.now()) {
    const live = (events || []).filter((e) => e && !e.is_archived && e.is_active !== false)
        .map((e) => {
            const start = ts(e.start_date);
            // An event counts as running through the whole of its last day.
            const end = Number.isFinite(ts(e.end_date)) ? ts(e.end_date) + DAY : start + DAY;
            return { e, start, end };
        })
        .filter((x) => Number.isFinite(x.start) && x.end > now);
    const running = live.filter((x) => x.start <= now).sort((a, b) => a.end - b.end);
    if (running.length) return running[0].e;
    const upcoming = live.sort((a, b) => a.start - b.start);
    return upcoming.length ? upcoming[0].e : null;
}
