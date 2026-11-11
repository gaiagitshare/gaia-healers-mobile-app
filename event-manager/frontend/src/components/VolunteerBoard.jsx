import React, { useMemo, useState } from 'react';
import {
    Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Tooltip, Typography,
} from '@mui/material';
import { dayLabel, timeLabel } from '../utils/volunteerTime';

/**
 * Volunteer board (11 Nov 2026): one day at a time, a row for every place,
 * hours across the top, and each shift as a block at its time -- green when
 * full, amber when partly filled, red when nobody is on it yet, with the
 * names on it. The list view stays; this is for seeing the day at a glance,
 * finding the gaps, and printing one page for the volunteer desk.
 *
 * Shift times are the venue's wall-clock text ("09:00"), never converted.
 */

const PX_PER_HOUR = 112;
const LANE_H = 66;
const LABEL_W = 168;

const mins = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const hourLabel = (h) => `${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '?';

function fill(s) {
    const cap = s.capacity || 0;
    if (cap && s.confirmed >= cap) return { key: 'full', bg: 'rgba(124,194,63,0.20)', border: '#7cc23f', text: '#cfeeb0', label: 'Full' };
    if (s.confirmed > 0 || s.requested > 0) return { key: 'part', bg: 'rgba(230,185,92,0.18)', border: '#e6b95c', text: '#f3dca6', label: 'Partly filled' };
    return { key: 'empty', bg: 'rgba(235,110,110,0.16)', border: '#eb6e6e', text: '#f6b9b9', label: 'Nobody yet' };
}

// Shifts in one place that overlap in time go on separate lanes.
function lanesFor(shifts) {
    const sorted = [...shifts].sort((a, b) => mins(a.start_time) - mins(b.start_time) || mins(a.end_time) - mins(b.end_time));
    const laneEnds = [];
    const placed = sorted.map((s) => {
        const st = mins(s.start_time);
        let lane = laneEnds.findIndex((end) => end <= st);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = mins(s.end_time);
        return { s, lane };
    });
    return { placed, count: Math.max(1, laneEnds.length) };
}

export default function VolunteerBoard({ days, renderShift }) {
    const [dayKey, setDayKey] = useState(days[0]?.day || '');
    const [openId, setOpenId] = useState(null);
    const day = days.find((d) => d.day === dayKey) || days[0];
    const shifts = useMemo(() => (day ? day.shifts : []), [day]);

    const { startH, endH, rows, totals } = useMemo(() => {
        if (!shifts.length) return { startH: 8, endH: 18, rows: [], totals: { cap: 0, conf: 0, open: 0, empty: 0 } };
        const lo = Math.min(...shifts.map((s) => mins(s.start_time)));
        const hi = Math.max(...shifts.map((s) => mins(s.end_time)));
        const byPlace = {};
        shifts.forEach((s) => { const k = (s.location || '').trim() || 'No place set'; (byPlace[k] = byPlace[k] || []).push(s); });
        const rowsOut = Object.entries(byPlace)
            .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
            .map(([place, list]) => ({ place, ...lanesFor(list),
                cap: list.reduce((n, s) => n + (s.capacity || 0), 0),
                conf: list.reduce((n, s) => n + (s.confirmed || 0), 0) }));
        return {
            startH: Math.floor(lo / 60), endH: Math.ceil(hi / 60), rows: rowsOut,
            totals: {
                cap: shifts.reduce((n, s) => n + (s.capacity || 0), 0),
                conf: shifts.reduce((n, s) => n + (s.confirmed || 0), 0),
                open: shifts.reduce((n, s) => n + (s.open || 0), 0),
                empty: shifts.filter((s) => fill(s).key === 'empty').length,
            },
        };
    }, [shifts]);

    const hours = [];
    for (let h = startH; h <= endH; h += 1) hours.push(h);
    const width = (endH - startH) * PX_PER_HOUR;
    const x = (hhmm) => ((mins(hhmm) - startH * 60) / 60) * PX_PER_HOUR;
    const open = shifts.find((s) => s.id === openId) || null;

    if (!days.length) return <Typography color="text.secondary">No shifts yet.</Typography>;

    return (
        <Box className="vboard">
            <style>{`@media print {
                .vboard-days .MuiChip-root:not(.MuiChip-filled) { display: none !important; }
                .vboard-scroll { overflow: visible !important; }
                .vboard-grid { zoom: 0.62; }
                .vboard-legend { display: none !important; }
            }`}</style>

            {/* Day tabs */}
            <Stack direction="row" spacing={1} className="vboard-days" sx={{ mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
                {days.map((d) => (
                    <Chip key={d.day} label={`${dayLabel(d.day)} · ${d.shifts.length}`} clickable onClick={() => setDayKey(d.day)}
                          color={d.day === day.day ? 'primary' : 'default'} variant={d.day === day.day ? 'filled' : 'outlined'}
                          sx={d.day === day.day ? { bgcolor: '#7cc23f', color: '#0d1a06', fontWeight: 700, '&:hover': { bgcolor: '#a9e05a' } } : undefined} />
                ))}
                <Box sx={{ flex: 1 }} />
                <Button size="small" className="no-print" onClick={() => window.print()}>Print this day</Button>
            </Stack>

            {/* The day in numbers */}
            <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
                <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
                    <Typography variant="caption" color="text.secondary">Places filled</Typography>
                    <Typography variant="h6">{totals.conf} / {totals.cap}</Typography>
                </Paper>
                <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
                    <Typography variant="caption" color="text.secondary">Open places</Typography>
                    <Typography variant="h6" color={totals.open ? 'warning.main' : 'success.main'}>{totals.open}</Typography>
                </Paper>
                <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
                    <Typography variant="caption" color="text.secondary">Shifts with nobody</Typography>
                    <Typography variant="h6" color={totals.empty ? 'error.main' : 'success.main'}>{totals.empty}</Typography>
                </Paper>
                <Stack direction="row" spacing={1.5} alignItems="center" className="vboard-legend" sx={{ ml: 'auto', flexWrap: 'wrap' }}>
                    {[fill({ capacity: 1, confirmed: 1 }), fill({ capacity: 2, confirmed: 1 }), fill({ capacity: 1, confirmed: 0 })].map((f) => (
                        <Stack key={f.key} direction="row" spacing={0.75} alignItems="center">
                            <Box sx={{ width: 14, height: 14, borderRadius: 0.75, bgcolor: f.bg, border: `2px solid ${f.border}` }} />
                            <Typography variant="caption" color="text.secondary">{f.label}</Typography>
                        </Stack>
                    ))}
                </Stack>
            </Stack>

            {/* The board: places down the side, hours across, scrolling sideways on its own */}
            <Paper variant="outlined" className="vboard-scroll" sx={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <Box className="vboard-grid" sx={{ minWidth: LABEL_W + width + 16, position: 'relative' }}>
                    {/* hour header */}
                    <Box sx={{ display: 'flex', borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, zIndex: 2, bgcolor: 'background.paper' }}>
                        <Box sx={{ width: LABEL_W, flex: `0 0 ${LABEL_W}px`, px: 1.5, py: 1, position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 3 }}>
                            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: '.04em' }}>PLACE</Typography>
                        </Box>
                        <Box sx={{ position: 'relative', width, height: 34 }}>
                            {hours.map((h) => (
                                <Typography key={h} variant="caption" color="text.secondary"
                                            sx={{ position: 'absolute', left: (h - startH) * PX_PER_HOUR + 4, top: 8, whiteSpace: 'nowrap' }}>
                                    {hourLabel(h)}
                                </Typography>
                            ))}
                        </Box>
                    </Box>

                    {rows.map((r) => (
                        <Box key={r.place} sx={{ display: 'flex', borderBottom: 1, borderColor: 'divider' }}>
                            <Box sx={{ width: LABEL_W, flex: `0 0 ${LABEL_W}px`, px: 1.5, py: 1, position: 'sticky', left: 0, zIndex: 1,
                                       bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider' }}>
                                <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>{r.place}</Typography>
                                <Typography variant="caption" color={r.conf < r.cap ? 'warning.main' : 'success.main'}>{r.conf} / {r.cap} filled</Typography>
                            </Box>
                            <Box sx={{ position: 'relative', width, height: r.count * LANE_H + 8 }}>
                                {hours.map((h) => (
                                    <Box key={h} sx={{ position: 'absolute', left: (h - startH) * PX_PER_HOUR, top: 0, bottom: 0,
                                                       borderLeft: '1px dashed', borderColor: 'divider', opacity: 0.6 }} />
                                ))}
                                {r.placed.map(({ s, lane }) => {
                                    const f = fill(s);
                                    const names = (s.people || []).map((p) => firstName(p.name) + (p.status === 'requested' ? '?' : ''));
                                    const left = x(s.start_time) + 2;
                                    const w = Math.max(48, x(s.end_time) - x(s.start_time) - 4);
                                    return (
                                        <Tooltip key={s.id} placement="top"
                                                 title={`${s.role} · ${timeLabel(s.start_time)}–${timeLabel(s.end_time)} · ${s.confirmed}/${s.capacity}${names.length ? ' · ' + names.join(', ') : ''}`}>
                                            <Box role="button" tabIndex={0} aria-label={`${s.role}, ${r.place}, ${s.confirmed} of ${s.capacity}`}
                                                 onClick={() => setOpenId(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(s.id); }}
                                                 sx={{ position: 'absolute', left, width: w, top: 4 + lane * LANE_H, height: LANE_H - 6,
                                                       bgcolor: f.bg, border: `2px solid ${f.border}`, borderRadius: 1.5, px: 1, py: 0.5,
                                                       overflow: 'hidden', cursor: 'pointer', '&:hover': { filter: 'brightness(1.25)' } }}>
                                                <Stack direction="row" justifyContent="space-between" spacing={0.5}>
                                                    <Typography variant="caption" sx={{ fontWeight: 700, color: f.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {s.role}{s.lead_role ? ' (lead)' : ''}
                                                    </Typography>
                                                    <Typography variant="caption" sx={{ fontWeight: 700, color: f.text, whiteSpace: 'nowrap' }}>{s.confirmed}/{s.capacity}</Typography>
                                                </Stack>
                                                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                                                    {timeLabel(s.start_time)}–{timeLabel(s.end_time)}
                                                </Typography>
                                                <Typography variant="caption" sx={{ display: 'block', color: 'text.primary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3 }}>
                                                    {names.length ? names.join(', ') : 'Nobody yet'}
                                                </Typography>
                                            </Box>
                                        </Tooltip>
                                    );
                                })}
                            </Box>
                        </Box>
                    ))}
                </Box>
            </Paper>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }} className="no-print">
                Tap a shift to assign, move or edit. A name with “?” has asked for the shift and waits for approval.
            </Typography>

            <Dialog open={Boolean(open)} onClose={() => setOpenId(null)} fullWidth maxWidth="sm">
                <DialogTitle>{open ? `${open.role} · ${(open.location || '').trim() || 'No place set'}` : ''}</DialogTitle>
                <DialogContent>{open && renderShift(open)}</DialogContent>
                <DialogActions><Button onClick={() => setOpenId(null)}>Close</Button></DialogActions>
            </Dialog>
        </Box>
    );
}
