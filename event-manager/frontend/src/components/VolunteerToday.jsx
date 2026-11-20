import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { dayLabel, timeLabel } from '../utils/volunteerTime';

/**
 * Today (20 Nov 2026): the volunteer coordinator's live view for the event
 * day: who is on duty right now and where, who comes next, which places are
 * empty, and everyone working that day with a phone number to tap. It reads
 * the same admin overview the rest of the page uses (refreshed every 30 s),
 * so a change made anywhere shows here within half a minute.
 *
 * Shift times are the venue's wall-clock text; "now" is Orlando time.
 */

const TZ = 'America/New_York';
const mins = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };

function venueNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

const tel = (phone) => String(phone || '').replace(/[^\d+]/g, '');

function Person({ p, vol }) {
    const phone = vol?.phone;
    return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
            {p.status === 'requested' && <Chip size="small" color="warning" label="not confirmed" />}
            {phone
                ? <Button size="small" href={`tel:${tel(phone)}`} sx={{ minWidth: 0, py: 0 }}>{phone}</Button>
                : <Typography variant="body2" color="text.secondary">no phone</Typography>}
        </Stack>
    );
}

function ShiftRow({ s, vols, state }) {
    const short = s.confirmed < (s.capacity || 0);
    const border = state === 'now' ? (short ? '#eb6e6e' : '#7cc23f') : 'divider';
    return (
        <Paper variant="outlined" sx={{ p: 1.25, mb: 1, borderColor: border, borderWidth: state === 'now' ? 2 : 1, opacity: state === 'done' ? 0.6 : 1 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
                <Box sx={{ minWidth: 220 }}>
                    <Typography variant="subtitle2">{timeLabel(s.start_time)} – {timeLabel(s.end_time)}{s.lead_role ? ' · all-day lead' : ''}</Typography>
                    <Typography sx={{ fontWeight: 700 }}>{s.role}</Typography>
                    <Typography variant="body2" color="text.secondary">{s.location || 'No place set'}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                    {s.people.map((p) => <Person key={p.booking_id} p={p} vol={vols[p.volunteer_id]} />)}
                    {!s.people.length && <Typography color="error.main" sx={{ fontWeight: 700 }}>Nobody on this shift</Typography>}
                    {s.people.length > 0 && short && <Typography variant="body2" color="warning.main">
                        {s.capacity - s.confirmed} more needed ({s.confirmed}/{s.capacity})</Typography>}
                </Box>
            </Stack>
        </Paper>
    );
}

export default function VolunteerToday({ shifts, volunteers }) {
    const [clock, setClock] = useState(venueNow());
    useEffect(() => { const t = setInterval(() => setClock(venueNow()), 30000); return () => clearInterval(t); }, []);
    const days = useMemo(() => Array.from(new Set(shifts.filter((s) => s.active).map((s) => s.day))).sort(), [shifts]);
    const defaultDay = days.includes(clock.day) ? clock.day : (days.find((d) => d >= clock.day) || days[days.length - 1]);
    const [picked, setPicked] = useState(null);
    const day = picked || defaultDay;
    const isToday = day === clock.day;
    const vols = useMemo(() => Object.fromEntries(volunteers.map((v) => [v.id, v])), [volunteers]);

    const list = shifts.filter((s) => s.active && s.day === day)
        .sort((a, b) => mins(a.start_time) - mins(b.start_time) || Number(b.lead_role) - Number(a.lead_role) || a.role.localeCompare(b.role));
    const stateOf = (s) => {
        if (!isToday) return day < clock.day ? 'done' : 'next';
        if (clock.min >= mins(s.end_time)) return 'done';
        if (clock.min >= mins(s.start_time)) return 'now';
        return 'next';
    };
    const now = list.filter((s) => stateOf(s) === 'now');
    const next = list.filter((s) => stateOf(s) === 'next');
    const done = list.filter((s) => stateOf(s) === 'done');
    const gaps = list.filter((s) => stateOf(s) !== 'done' && s.confirmed < (s.capacity || 0));

    const people = {};
    list.forEach((s) => s.people.forEach((p) => {
        const r = people[p.volunteer_id] || (people[p.volunteer_id] = { name: p.name, vol: vols[p.volunteer_id], shifts: [] });
        r.shifts.push(s);
    }));
    const roster = Object.values(people).sort((a, b) => a.name.localeCompare(b.name));
    const onNowIds = new Set(now.flatMap((s) => s.people.map((p) => p.volunteer_id)));

    const section = (title, rows, state, empty) => (
        <Box sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>{title} ({rows.length})</Typography>
            {rows.map((s) => <ShiftRow key={s.id} s={s} vols={vols} state={state} />)}
            {!rows.length && <Typography variant="body2" color="text.secondary">{empty}</Typography>}
        </Box>
    );

    return (
        <Box>
            <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', gap: 1, alignItems: 'center' }} className="no-print">
                {days.map((d) => <Chip key={d} label={dayLabel(d)} color={d === day ? 'primary' : 'default'}
                                       variant={d === day ? 'filled' : 'outlined'} onClick={() => setPicked(d)} />)}
                <Box sx={{ flex: 1 }} />
                <Button size="small" variant="outlined" onClick={() => window.print()}>Print this day</Button>
            </Stack>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>Volunteers · {dayLabel(day)}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {isToday ? `Orlando time now ${timeLabel(`${Math.floor(clock.min / 60)}:${clock.min % 60}`)} · updates every 30 seconds` : 'Orlando time'}
                {' · '}{roster.length} people working this day
            </Typography>
            {gaps.length > 0 && <Alert severity="warning" sx={{ mb: 1.5 }}>
                {gaps.length} shift{gaps.length > 1 ? 's' : ''} still short: {gaps.map((s) => `${timeLabel(s.start_time)} ${s.role}`).join(' · ')}
            </Alert>}
            {isToday && section('On duty now', now, 'now', 'Nobody is scheduled right now.')}
            {section(isToday ? 'Coming up' : 'Shifts', next, 'next', isToday ? 'No more shifts today.' : 'No shifts.')}

            <Box sx={{ mb: 2 }}>
                <Typography variant="h6" sx={{ mb: 1 }}>Who is working {isToday ? 'today' : 'this day'}</Typography>
                <Paper variant="outlined">
                    {roster.map((r) => (
                        <Stack key={r.name} direction={{ xs: 'column', sm: 'row' }} spacing={1}
                               sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: { sm: 'center' } }}>
                            <Box sx={{ minWidth: 220 }}>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                    <Typography sx={{ fontWeight: 600 }}>{r.name}</Typography>
                                    {onNowIds.has(r.vol?.id) && <Chip size="small" color="success" label="on now" />}
                                </Stack>
                                {r.vol?.phone
                                    ? <Button size="small" href={`tel:${tel(r.vol.phone)}`} sx={{ minWidth: 0, p: 0 }}>{r.vol.phone}</Button>
                                    : <Typography variant="body2" color="text.secondary">no phone</Typography>}
                            </Box>
                            <Typography variant="body2" sx={{ flex: 1 }}>
                                {r.shifts.map((s) => `${timeLabel(s.start_time)}–${timeLabel(s.end_time)} ${s.role} (${s.location || '—'})`).join(' · ')}
                            </Typography>
                        </Stack>
                    ))}
                    {!roster.length && <Typography sx={{ p: 1 }} color="text.secondary">Nobody booked.</Typography>}
                </Paper>
            </Box>
            {isToday && done.length > 0 && section('Finished today', done, 'done', '')}
        </Box>
    );
}
