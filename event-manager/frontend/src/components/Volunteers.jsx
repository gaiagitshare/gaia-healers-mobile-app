import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    FormControlLabel, MenuItem, Paper, Snackbar, Stack, Tab, Tabs, TextField, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import {
    getVolunteerOverview, updateVolunteerProgram, addVolunteer, updateVolunteer, addVolunteerShift,
    updateVolunteerShift, assignVolunteer, updateVolunteerBooking, exportVolunteers, previewVolunteerInvites,
    sendVolunteerInvites, refreshVolunteerInvites, addVolunteerAnnouncement, updateVolunteerAnnouncement,
} from '../utils/api';
import { byDay, dayLabel, shiftTime } from '../utils/volunteerTime';

/**
 * Volunteers — the event's volunteer team and schedule, for the people who run
 * it. Everything a volunteer does arrives here as a request that holds a place;
 * an admin approves, declines, edits or moves it. Volunteers use their own
 * private link (copied from here and sent by hand): nothing is ever emailed or
 * texted from this screen.
 */

const err = (e) => { const d = e?.response?.data?.detail; return typeof d === 'string' ? d : (e?.message || 'Something went wrong'); };
const linkFor = (token) => `${window.location.origin}/event/volunteer/${token}`;
const joinLinkFor = (token) => `${window.location.origin}/event/volunteer-join/${token}`;
const teamLinkFor = (token) => `${window.location.origin}/event/volunteer-team/${token}`;
const INVITE = {
    not_sent: ['Not invited', 'default'], sent: ['Invitation sent', 'info'], opened: ['Email opened', 'info'],
    accepted: ['Opened their page', 'success'], failed: ['Could not send', 'error'],
};
const missingInfo = (v) => !v.email || !v.phone || !(v.last_name || '').trim();
const STATUS_CHIP = { confirmed: ['Confirmed', 'success'], requested: ['Requested', 'warning'] };
const V_CHIP = { approved: ['On the team', 'success'], pending: ['Waiting for approval', 'warning'], rejected: ['Not on the team', 'default'] };
const EMPTY_SHIFT = { day: '2026-11-20', start_time: '09:00', end_time: '12:00', role: '', location: '', capacity: 1, description: '', lead_role: false };

export default function Volunteers() {
    const { id } = useParams();
    const narrow = useMediaQuery('(max-width:700px)');
    const [data, setData] = useState(null);
    const [tab, setTab] = useState('overview');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [warn, setWarn] = useState('');
    const [busy, setBusy] = useState(false);
    const [dlg, setDlg] = useState(null);      // { kind, ... }
    const [form, setForm] = useState({});
    const [q, setQ] = useState('');
    const [sel, setSel] = useState([]);
    const [vfilter, setVfilter] = useState('all');
    const [preview, setPreview] = useState(null);   // { ids, resend, data }

    const load = useCallback(() => getVolunteerOverview(id).then((r) => { setData(r.data); })
        .catch((e) => setError(err(e))), [id]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

    const run = (job, ok) => {
        setBusy(true);
        return job.then((r) => {
            if (ok) setNotice(typeof ok === 'function' ? ok(r) : ok);
            const w = r?.data?.warnings;
            setWarn(Array.isArray(w) && w.length ? `Done, but please check: ${w.join(' ')}` : '');
            setDlg(null); setForm({}); return load();
        })
            .catch((e) => setError(err(e))).finally(() => setBusy(false));
    };
    const copy = (text, what) => {
        const done = () => setNotice(`${what} copied.`);
        try { navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this link:', text)); } catch (e) { window.prompt('Copy this link:', text); }
    };
    const exportCsv = () => exportVolunteers(id).then((r) => {
        const url = URL.createObjectURL(r.data); const a = document.createElement('a');
        a.href = url; a.download = 'volunteer-schedule.csv'; a.click(); URL.revokeObjectURL(url);
    }).catch((e) => setError(err(e)));

    const openInvite = (ids, resend = false) => {
        setBusy(true);
        previewVolunteerInvites(id, { volunteer_ids: ids, resend }).then((r) => setPreview({ ids, resend, data: r.data }))
            .catch((e) => setError(err(e))).finally(() => setBusy(false));
    };
    const doInvite = () => {
        const p = preview;
        run(sendVolunteerInvites(id, { volunteer_ids: p.ids, resend: p.resend, confirm_count: p.data.can_send, base_url: window.location.origin }),
            (r) => `${r.data.sent} invitation(s) sent.${r.data.results.some((x) => !x.ok) ? ' Some could not be sent; see each volunteer.' : ''}`)
            .then(() => { setPreview(null); setSel([]); });
    };
    const vols = useMemo(() => data?.volunteers || [], [data]);
    const approved = vols.filter((v) => v.status === 'approved');
    const days = useMemo(() => byDay((data?.shifts || []).filter((s) => s.active)), [data]);
    if (!data) return error ? <Alert severity="error">{error}</Alert> : <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress size={28} /></Box>;
    const st = data.stats;

    const Stat = ({ label, value, color }) => (
        <Paper sx={{ p: 1.5, minWidth: 120, flex: '1 1 120px' }}>
            <Typography variant="caption" color={color || 'text.secondary'}>{label}</Typography>
            <Typography variant="h5">{value}</Typography>
        </Paper>
    );

    const shiftCard = (s) => (
        <Paper key={s.id} variant="outlined" sx={{ p: 1.5, mb: 1, breakInside: 'avoid' }}>
            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" spacing={1}>
                <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{s.role}</Typography>
                    <Typography variant="body2">{shiftTime(s)}{s.location ? ` · ${s.location}` : ''}</Typography>
                    <Typography variant="body2" color={s.confirmed < s.capacity ? 'warning.main' : 'success.main'}>
                        {s.confirmed} of {s.capacity} confirmed{s.requested ? ` · ${s.requested} requested` : ''}{s.open ? ` · ${s.open} open` : ' · full'}
                    </Typography>
                </Box>
                <Stack direction="row" spacing={1} className="no-print" sx={{ alignItems: 'flex-start' }}>
                    <Button size="small" variant="outlined" disabled={!s.open} onClick={() => { setDlg({ kind: 'assign', shift: s }); setForm({}); }}>Assign</Button>
                    <Button size="small" onClick={() => { setDlg({ kind: 'shift', shift: s }); setForm({ ...s }); }}>Edit</Button>
                </Stack>
            </Stack>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                {s.people.map((p) => (
                    <Chip key={p.booking_id} size="small" color={STATUS_CHIP[p.status]?.[1]} variant={p.status === 'confirmed' ? 'filled' : 'outlined'}
                          label={`${p.name}${p.status === 'requested' ? ' (requested)' : ''}`}
                          onClick={() => { setDlg({ kind: 'booking', shift: s, person: p }); setForm({ move_to: '' }); }} />
                ))}
                {!s.people.length && <Typography variant="caption" color="text.secondary">Nobody yet</Typography>}
            </Stack>
        </Paper>
    );

    const filtered = vols.filter((v) => !q || `${v.first_name} ${v.last_name} ${v.email || ''} ${v.phone || ''}`.toLowerCase().includes(q.toLowerCase()));

    return (
        <Box>
            <style>{`@media print { .no-print, header, nav, .MuiDrawer-root { display: none !important; } .print-only { display: block !important; } }`}</style>
            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" spacing={1} sx={{ mb: 1 }} className="no-print">
                <Box>
                    <Typography variant="h5">Volunteers</Typography>
                    <Typography variant="body2" color="text.secondary">
                        The volunteer team and schedule. Invitations are emailed only when you review and press Send. Nothing is ever texted.
                    </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                    <Button variant="contained" onClick={() => { setDlg({ kind: 'add' }); setForm({}); }}>Add volunteer</Button>
                    <Button onClick={() => { setTab('schedule'); setTimeout(() => window.print(), 300); }}>Print</Button>
                    <Button onClick={exportCsv}>Export</Button>
                </Stack>
            </Stack>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }} className="no-print">{error}</Alert>}
            <Snackbar open={!!warn} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} className="no-print">
                <Alert severity="warning" variant="filled" onClose={() => setWarn('')} sx={{ maxWidth: 560 }}>{warn}</Alert>
            </Snackbar>
            {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1 }} className="no-print">{notice}</Alert>}

            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }} className="no-print">
                <Stat label="Volunteers" value={st.volunteers} />
                <Stat label="Waiting for approval" value={st.pending_volunteers + data.requests.length} color={(st.pending_volunteers + data.requests.length) ? 'warning.main' : undefined} />
                <Stat label="Shifts" value={st.shifts} />
                <Stat label="Places confirmed" value={`${st.filled} / ${st.positions}`} />
                <Stat label="Open places" value={st.open} />
                <Stat label="Understaffed shifts" value={st.understaffed} color={st.understaffed ? 'warning.main' : undefined} />
            </Stack>

            <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }} className="no-print">
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Invitations</Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {Object.entries(INVITE).map(([k, [label, color]]) => (
                        <Chip key={k} color={color} variant={k === 'not_sent' ? 'outlined' : 'filled'} label={`${label}: ${data.onboarding?.[k] ?? 0}`}
                              onClick={() => { setTab('volunteers'); setVfilter(k); }} />
                    ))}
                    <Button size="small" onClick={() => run(refreshVolunteerInvites(id), (r) => `Checked ${r.data.checked} sent invitation(s).`)}>Refresh status</Button>
                </Stack>
                {!data.program.sending_enabled && <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
                    Sending invitations by email is switched off until the owner approves it. Until then, use "Copy link".</Typography>}
            </Paper>

            <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" sx={{ mb: 2 }} className="no-print">
                <Tab value="overview" label={`To approve (${st.pending_volunteers + data.requests.length})`} />
                <Tab value="schedule" label="Schedule" />
                <Tab value="volunteers" label={`Volunteers (${vols.length})`} />
                <Tab value="news" label={`Announcements (${(data.announcements || []).filter((a) => a.active).length})`} />
                <Tab value="settings" label="Team & registration links" />
            </Tabs>

            {tab === 'overview' && (
                <Box>
                    {!data.requests.length && !st.pending_volunteers && !st.needs_review &&
                        <Alert severity="success">Nothing waiting. New requests appear here as volunteers pick shifts.</Alert>}
                    {vols.filter((v) => v.status === 'pending').map((v) => (
                        <Paper key={v.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" spacing={1}>
                                <Box>
                                    <Typography sx={{ fontWeight: 600 }}>New volunteer: {v.first_name} {v.last_name}</Typography>
                                    <Typography variant="body2" color="text.secondary">{v.email} · {v.phone}{v.notes ? ` · "${v.notes}"` : ''}</Typography>
                                </Box>
                                <Stack direction="row" spacing={1}>
                                    <Button variant="contained" color="success" disabled={busy} onClick={() => run(updateVolunteer(id, v.id, { status: 'approved' }), `${v.first_name} is on the team.`)}>Approve</Button>
                                    <Button color="inherit" disabled={busy} onClick={() => { setDlg({ kind: 'reject', vol: v }); }}>Reject</Button>
                                </Stack>
                            </Stack>
                        </Paper>
                    ))}
                    {data.requests.map((r) => (
                        <Paper key={r.booking_id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" spacing={1}>
                                <Box>
                                    <Typography sx={{ fontWeight: 600 }}>{r.volunteer} asks for {r.role}</Typography>
                                    <Typography variant="body2" color="text.secondary">{dayLabel(r.day)} · {shiftTime(r)}</Typography>
                                </Box>
                                <Stack direction="row" spacing={1}>
                                    <Button variant="contained" color="success" disabled={busy} onClick={() => run(updateVolunteerBooking(id, r.booking_id, { status: 'confirmed' }), 'Confirmed.')}>Approve</Button>
                                    <Button disabled={busy} onClick={() => { const s = data.shifts.find((x) => x.id === r.shift_id); setDlg({ kind: 'booking', shift: s, person: { booking_id: r.booking_id, name: r.volunteer, status: 'requested' } }); setForm({ move_to: '' }); }}>Edit / move</Button>
                                    <Button color="inherit" disabled={busy} onClick={() => run(updateVolunteerBooking(id, r.booking_id, { status: 'declined' }), 'Declined; the place is free again.')}>Decline</Button>
                                </Stack>
                            </Stack>
                        </Paper>
                    ))}
                    {vols.filter((v) => v.needs_review).map((v) => (
                        <Alert key={`r${v.id}`} severity="info" sx={{ mb: 1 }}
                               action={<Button size="small" onClick={() => { setDlg({ kind: 'edit', vol: v }); setForm({ ...v }); }}>Open</Button>}>
                            <b>{v.first_name} {v.last_name}:</b> {v.needs_review}
                        </Alert>
                    ))}
                </Box>
            )}

            {tab === 'schedule' && (
                <Box>
                    <Stack direction="row" spacing={1} sx={{ mb: 1 }} className="no-print">
                        <Button size="small" variant="outlined" onClick={() => { setDlg({ kind: 'shift' }); setForm({ ...EMPTY_SHIFT }); }}>Add shift</Button>
                    </Stack>
                    <Typography className="print-only" variant="h5" sx={{ display: 'none', mb: 1 }}>{data.program.title} — schedule</Typography>
                    {days.map((g) => (
                        <Box key={g.day} sx={{ mb: 3 }}>
                            <Typography variant="h6" sx={{ mb: 1 }}>{dayLabel(g.day)}</Typography>
                            <Box sx={{ columnCount: narrow ? 1 : 2, columnGap: 2 }}>{g.shifts.map(shiftCard)}</Box>
                        </Box>
                    ))}
                </Box>
            )}

            {tab === 'volunteers' && (() => {
                const shown = filtered.filter((v) => vfilter === 'all' ? true : vfilter === 'missing' ? missingInfo(v)
                    : (v.invite_status || 'not_sent') === vfilter && v.status === 'approved');
                const all = shown.filter((v) => v.status === 'approved').map((v) => v.id);
                return <Box>
                    <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 1 }}>
                        <TextField size="small" fullWidth label="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
                        <TextField size="small" select label="Show" value={vfilter} onChange={(e) => setVfilter(e.target.value)} sx={{ minWidth: 200 }}>
                            <MenuItem value="all">Everyone</MenuItem>
                            <MenuItem value="missing">Missing email, phone or last name</MenuItem>
                            {Object.entries(INVITE).map(([k, [l]]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
                        </TextField>
                    </Stack>
                    <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                        <FormControlLabel control={<Checkbox checked={all.length > 0 && all.every((x) => sel.includes(x))}
                            onChange={(e) => setSel(e.target.checked ? Array.from(new Set([...sel, ...all])) : sel.filter((x) => !all.includes(x)))} />} label="Select all shown" />
                        <Button variant="contained" disabled={!sel.length || busy} onClick={() => openInvite(sel)}>Invite selected ({sel.length})</Button>
                        <Button disabled={!sel.length || busy} onClick={() => openInvite(sel, true)}>Resend to selected</Button>
                    </Stack>
                    {shown.map((v) => (
                        <Paper key={v.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" spacing={1}>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                                    <Checkbox sx={{ p: 0.5 }} disabled={v.status !== 'approved'} checked={sel.includes(v.id)}
                                              onChange={(e) => setSel(e.target.checked ? [...sel, v.id] : sel.filter((x) => x !== v.id))} />
                                    <Box>
                                        <Typography sx={{ fontWeight: 600 }}>{v.first_name} {v.last_name}{' '}
                                            <Chip size="small" label={V_CHIP[v.status]?.[0]} color={V_CHIP[v.status]?.[1]} />{' '}
                                            {v.status === 'approved' && <Chip size="small" variant="outlined" color={INVITE[v.invite_status || 'not_sent'][1]} label={INVITE[v.invite_status || 'not_sent'][0]} />}</Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            {[v.email || 'no email', v.phone || 'no phone'].join(' · ')} · {v.confirmed} confirmed, {v.requested} requested
                                        </Typography>
                                        {v.invite_error && v.invite_status === 'failed' && <Typography variant="caption" color="error.main" display="block">Could not send: {v.invite_error}</Typography>}
                                        {v.needs_review && <Typography variant="caption" color="warning.main" display="block">{v.needs_review}</Typography>}
                                    </Box>
                                </Stack>
                                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                                    {v.status === 'approved' && v.token && (['sent', 'opened', 'accepted'].includes(v.invite_status)
                                        ? <Button size="small" onClick={() => openInvite([v.id], true)}>Resend</Button>
                                        : <Button size="small" variant="outlined" onClick={() => openInvite([v.id])}>Send invitation</Button>)}
                                    {v.token && v.status === 'approved' ? <Button size="small" onClick={() => copy(linkFor(v.token), `${v.first_name}'s link`)}>Copy link</Button>
                                        : v.status !== 'rejected' && <Button size="small" onClick={() => run(updateVolunteer(id, v.id, { new_link: true }), 'New link made.')}>Make link</Button>}
                                    <Button size="small" onClick={() => { setDlg({ kind: 'edit', vol: v }); setForm({ ...v }); }}>{missingInfo(v) ? 'Complete info' : 'Edit'}</Button>
                                    {v.status === 'pending' && <Button size="small" color="success" onClick={() => run(updateVolunteer(id, v.id, { status: 'approved' }), 'Approved. Send them their invitation when ready.')}>Approve</Button>}
                                </Stack>
                            </Stack>
                        </Paper>
                    ))}
                    {!shown.length && <Alert severity="info">Nobody matches.</Alert>}
                </Box>;
            })()}

            {tab === 'news' && (
                <Box>
                    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                        <Typography variant="subtitle1" sx={{ mb: 1 }}>New announcement (shown in every volunteer's portal; never emailed)</Typography>
                        <TextField fullWidth size="small" label="Title" sx={{ mb: 1 }} value={form.ann_title || ''} onChange={(e) => setForm((f) => ({ ...f, ann_title: e.target.value }))} />
                        <TextField fullWidth multiline minRows={3} size="small" label="Message" sx={{ mb: 1 }} value={form.ann_body || ''} onChange={(e) => setForm((f) => ({ ...f, ann_body: e.target.value }))} />
                        <FormControlLabel control={<Checkbox checked={Boolean(form.ann_pinned)} onChange={(e) => setForm((f) => ({ ...f, ann_pinned: e.target.checked }))} />} label="Pin to the top" />
                        <Button variant="contained" disabled={busy || !(form.ann_title || '').trim()} onClick={() => run(addVolunteerAnnouncement(id, { title: form.ann_title, body: form.ann_body, pinned: Boolean(form.ann_pinned) }), 'Posted.')}>Post</Button>
                    </Paper>
                    {(data.announcements || []).map((a) => (
                        <Paper key={a.id} variant="outlined" sx={{ p: 1.5, mb: 1, opacity: a.active ? 1 : 0.5 }}>
                            <Stack direction="row" justifyContent="space-between">
                                <Box><Typography sx={{ fontWeight: 600 }}>{a.pinned ? '📌 ' : ''}{a.title}{a.active ? '' : ' (hidden)'}</Typography>
                                    <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>{a.body}</Typography>
                                    <Typography variant="caption" color="text.secondary">{a.created_by}</Typography></Box>
                                <Stack direction="row" sx={{ alignItems: 'flex-start' }}>
                                    <Button size="small" onClick={() => run(updateVolunteerAnnouncement(id, a.id, { pinned: !a.pinned }), 'Updated.')}>{a.pinned ? 'Unpin' : 'Pin'}</Button>
                                    <Button size="small" color="inherit" onClick={() => run(updateVolunteerAnnouncement(id, a.id, { active: !a.active }), 'Updated.')}>{a.active ? 'Hide' : 'Show'}</Button>
                                </Stack>
                            </Stack>
                        </Paper>
                    ))}
                </Box>
            )}

            {tab === 'settings' && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>Team link (for your volunteer group chat)</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Shows the whole team schedule and announcements, read-only. Requesting or cancelling shifts needs each volunteer's own
                        invitation link; once they have opened it, this page offers "Open my volunteer page" on their phone.
                    </Typography>
                    <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 3 }}>
                        {data.program.team_token && <Button variant="contained" onClick={() => copy(teamLinkFor(data.program.team_token), 'Team link')}>Copy team link</Button>}
                    </Stack>
                    <Typography variant="subtitle1" sx={{ mb: 1 }}>Registration link (for NEW volunteers)</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        New people fill in their details and wait under "To approve". They get no access until you approve them and send their invitation.
                    </Typography>
                    <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 2 }}>
                        <FormControlLabel control={<Checkbox checked={data.program.join_open} onChange={(e) => run(updateVolunteerProgram(id, { join_open: e.target.checked }), e.target.checked ? 'Registration is open.' : 'Registration is closed.')} />} label="Registration open" />
                        {data.program.join_token && <Button variant="outlined" onClick={() => copy(joinLinkFor(data.program.join_token), 'Registration link')}>Copy registration link</Button>}
                        {data.program.join_token && <Button color="inherit" onClick={() => run(updateVolunteerProgram(id, { new_join_link: true }), 'A new registration link was made; the old one stopped working.')}>Make a new registration link</Button>}
                    </Stack>
                    <TextField fullWidth label="Title" sx={{ mb: 1 }} value={form.title ?? data.program.title ?? ''} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
                    <TextField fullWidth multiline minRows={10} label="Welcome, reminders and dress code (volunteers see this)" value={form.intro ?? data.program.intro ?? ''} onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))} />
                    <TextField type="number" label="Shifts expected per day" sx={{ mt: 1, width: 220 }} value={form.expected_per_day ?? data.program.expected_per_day ?? 2} onChange={(e) => setForm((f) => ({ ...f, expected_per_day: e.target.value }))} />
                    <Box sx={{ mt: 1 }}>
                        <Button variant="contained" disabled={busy} onClick={() => run(updateVolunteerProgram(id, { title: form.title ?? data.program.title, intro: form.intro ?? data.program.intro, expected_per_day: form.expected_per_day ?? data.program.expected_per_day }), 'Saved.')}>Save</Button>
                    </Box>
                    <Typography variant="subtitle2" sx={{ mt: 3 }}>Recent changes</Typography>
                    {data.log.slice(0, 15).map((l, n) => (
                        <Typography key={n} variant="caption" display="block" color="text.secondary">
                            {new Date(String(l.at).endsWith('Z') ? l.at : l.at + 'Z').toLocaleString()} · {l.actor} · {String(l.action).replace(/_/g, ' ')}
                        </Typography>
                    ))}
                </Paper>
            )}

            {/* ── Dialogs ───────────────────────────────────────────────── */}
            <Dialog open={Boolean(dlg)} onClose={() => !busy && setDlg(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {dlg?.kind === 'add' && <>
                    <DialogTitle>Add a volunteer</DialogTitle>
                    <DialogContent dividers>
                        {[['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['notes', 'Notes (only admins see these)']].map(([k, l]) => (
                            <TextField key={k} fullWidth size="small" label={l} sx={{ mb: 1 }} value={form[k] || ''} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                        ))}
                        <Typography variant="caption" color="text.secondary">They get their own private link. "Save & send invitation" shows who will receive the email before anything is sent.</Typography>
                    </DialogContent>
                    <DialogActions><Button onClick={() => setDlg(null)}>Cancel</Button>
                        <Button disabled={busy || !(form.first_name || '').trim()} onClick={() => run(addVolunteer(id, form), `${form.first_name} saved. Send the invitation when ready.`)}>Save</Button>
                        <Button variant="contained" disabled={busy || !(form.first_name || '').trim() || !(form.email || '').trim()} onClick={() => {
                            setBusy(true);
                            addVolunteer(id, form).then((r) => { setDlg(null); load(); openInvite([r.data.id]); }).catch((e) => { setError(err(e)); setBusy(false); });
                        }}>Save &amp; send invitation</Button></DialogActions>
                </>}
                {dlg?.kind === 'edit' && <>
                    <DialogTitle>{dlg.vol.first_name} {dlg.vol.last_name}</DialogTitle>
                    <DialogContent dividers>
                        {[['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['notes', 'Notes (only admins see these)']].map(([k, l]) => (
                            <TextField key={k} fullWidth size="small" label={l} sx={{ mb: 1 }} value={form[k] || ''} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                        ))}
                        {dlg.vol.needs_review && <Alert severity="info" sx={{ mb: 1 }}>{dlg.vol.needs_review}
                            <Button size="small" onClick={() => run(updateVolunteer(id, dlg.vol.id, { needs_review: null }), 'Marked as checked.')}>Mark checked</Button></Alert>}
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                            {dlg.vol.status !== 'approved' && <Button color="success" onClick={() => run(updateVolunteer(id, dlg.vol.id, { status: 'approved' }), 'On the team.')}>Approve</Button>}
                            <Button onClick={() => run(updateVolunteer(id, dlg.vol.id, { new_link: true }), (r) => { copy(linkFor(r.data.token), 'New link'); return 'New link made and copied; the old one stopped working.'; })}>New link</Button>
                            {dlg.vol.token && <Button color="inherit" onClick={() => run(updateVolunteer(id, dlg.vol.id, { revoke_link: true }), 'Link switched off.')}>Switch off link</Button>}
                            {dlg.vol.status !== 'rejected' && <Button color="error" onClick={() => setDlg({ kind: 'reject', vol: dlg.vol })}>Remove from team</Button>}
                        </Stack>
                    </DialogContent>
                    <DialogActions><Button onClick={() => setDlg(null)}>Close</Button>
                        <Button variant="contained" disabled={busy} onClick={() => run(updateVolunteer(id, dlg.vol.id, { first_name: form.first_name, last_name: form.last_name, email: form.email, phone: form.phone, notes: form.notes }), 'Saved.')}>Save</Button></DialogActions>
                </>}
                {dlg?.kind === 'reject' && <>
                    <DialogTitle>Remove {dlg.vol.first_name} {dlg.vol.last_name}?</DialogTitle>
                    <DialogContent dividers><Typography>Their shifts are released and their link stops working. Nothing is sent to them.</Typography></DialogContent>
                    <DialogActions><Button onClick={() => setDlg(null)}>Cancel</Button>
                        <Button color="error" variant="contained" disabled={busy} onClick={() => run(updateVolunteer(id, dlg.vol.id, { status: 'rejected' }), (r) => `Removed; ${r.data.released} place(s) released.`)}>Remove</Button></DialogActions>
                </>}
                {dlg?.kind === 'assign' && <>
                    <DialogTitle>Assign to {dlg.shift.role}</DialogTitle>
                    <DialogContent dividers>
                        <Typography variant="body2" sx={{ mb: 1 }}>{dayLabel(dlg.shift.day)} · {shiftTime(dlg.shift)} · {dlg.shift.open} open</Typography>
                        <TextField select fullWidth size="small" label="Volunteer" value={form.volunteer_id || ''} onChange={(e) => setForm({ volunteer_id: e.target.value })}>
                            {approved.concat(vols.filter((v) => v.status === 'pending')).map((v) => <MenuItem key={v.id} value={v.id}>{v.first_name} {v.last_name}{v.status === 'pending' ? ' (waiting for approval)' : ''}</MenuItem>)}
                        </TextField>
                        <Typography variant="caption" color="text.secondary">Assigned shifts are confirmed straight away. Overlaps and full shifts are refused.</Typography>
                    </DialogContent>
                    <DialogActions><Button onClick={() => setDlg(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy || !form.volunteer_id} onClick={() => run(assignVolunteer(id, { shift_id: dlg.shift.id, volunteer_id: form.volunteer_id }), 'Assigned and confirmed.')}>Assign</Button></DialogActions>
                </>}
                {dlg?.kind === 'booking' && <>
                    <DialogTitle>{dlg.person.name} · {dlg.shift.role}</DialogTitle>
                    <DialogContent dividers>
                        <Typography variant="body2" sx={{ mb: 1 }}>{dayLabel(dlg.shift.day)} · {shiftTime(dlg.shift)} · {STATUS_CHIP[dlg.person.status]?.[0]}</Typography>
                        <TextField select fullWidth size="small" label="Move to another shift" value={form.move_to || ''} onChange={(e) => setForm({ move_to: e.target.value })} sx={{ mb: 1 }}>
                            {data.shifts.filter((s) => s.active && s.id !== dlg.shift.id && s.open > 0).map((s) => (
                                <MenuItem key={s.id} value={s.id}>{dayLabel(s.day)} · {shiftTime(s)} · {s.role} ({s.open} open)</MenuItem>))}
                        </TextField>
                    </DialogContent>
                    <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
                        <Button onClick={() => setDlg(null)}>Close</Button>
                        {form.move_to && <Button variant="contained" disabled={busy} onClick={() => run(updateVolunteerBooking(id, dlg.person.booking_id, { move_to_shift_id: form.move_to }), 'Moved and confirmed.')}>Move</Button>}
                        {dlg.person.status === 'requested' && <Button color="success" variant="contained" disabled={busy} onClick={() => run(updateVolunteerBooking(id, dlg.person.booking_id, { status: 'confirmed' }), 'Confirmed.')}>Approve</Button>}
                        {dlg.person.status === 'requested'
                            ? <Button color="inherit" disabled={busy} onClick={() => run(updateVolunteerBooking(id, dlg.person.booking_id, { status: 'declined' }), 'Declined; the place is free again.')}>Decline</Button>
                            : <Button color="error" disabled={busy} onClick={() => run(updateVolunteerBooking(id, dlg.person.booking_id, { status: 'cancelled' }), 'Removed from the shift.')}>Remove from shift</Button>}
                    </DialogActions>
                </>}
                {dlg?.kind === 'shift' && <>
                    <DialogTitle>{dlg.shift ? 'Edit shift' : 'Add a shift'}</DialogTitle>
                    <DialogContent dividers>
                        <TextField fullWidth size="small" label="Role" sx={{ mb: 1 }} value={form.role || ''} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} />
                        <TextField fullWidth size="small" label="Location" sx={{ mb: 1 }} value={form.location || ''} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
                        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                            <TextField size="small" type="date" label="Day" InputLabelProps={{ shrink: true }} value={form.day || ''} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} />
                            <TextField size="small" type="time" label="Start (Orlando)" InputLabelProps={{ shrink: true }} value={form.start_time || ''} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} />
                            <TextField size="small" type="time" label="End" InputLabelProps={{ shrink: true }} value={form.end_time || ''} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} />
                        </Stack>
                        <TextField size="small" type="number" label="Places" sx={{ mb: 1 }} value={form.capacity || 1} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} />
                        <TextField fullWidth multiline minRows={2} size="small" label="What they do" sx={{ mb: 1 }} value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                        <FormControlLabel control={<Checkbox checked={Boolean(form.lead_role)} onChange={(e) => setForm((f) => ({ ...f, lead_role: e.target.checked }))} />}
                                          label="All-day lead role (does not block other shifts)" />
                    </DialogContent>
                    <DialogActions>
                        {dlg.shift && <Tooltip title="Only possible when nobody holds the shift"><span>
                            <Button color="error" disabled={busy || dlg.shift.taken > 0} onClick={() => run(updateVolunteerShift(id, dlg.shift.id, { active: false }), 'Shift removed.')}>Remove shift</Button></span></Tooltip>}
                        <Button onClick={() => setDlg(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy} onClick={() => {
                            const body = { day: form.day, start_time: form.start_time, end_time: form.end_time, role: form.role, location: form.location, capacity: form.capacity, description: form.description, lead_role: Boolean(form.lead_role) };
                            run(dlg.shift ? updateVolunteerShift(id, dlg.shift.id, body) : addVolunteerShift(id, body), 'Saved.');
                        }}>Save</Button>
                    </DialogActions>
                </>}
            </Dialog>
            <Dialog open={Boolean(preview)} onClose={() => !busy && setPreview(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {preview && <>
                    <DialogTitle>{preview.resend ? 'Resend invitations' : 'Send invitations'}: review the recipients</DialogTitle>
                    <DialogContent dividers>
                        {!preview.data.sending_enabled && <Alert severity="warning" sx={{ mb: 1 }}>Sending by email is switched off until the owner approves it. Use "Copy link" for now.</Alert>}
                        <Typography sx={{ mb: 1 }}><b>{preview.data.can_send}</b> will receive the invitation email:</Typography>
                        {preview.data.recipients.filter((r) => r.can_send).map((r) => <Typography key={r.id} variant="body2">✓ {r.name} · {r.email}</Typography>)}
                        {preview.data.recipients.some((r) => !r.can_send) && <>
                            <Typography sx={{ mt: 2, mb: 0.5 }}>Not emailed (copy their link instead, or fix the reason):</Typography>
                            {preview.data.recipients.filter((r) => !r.can_send).map((r) => <Typography key={r.id} variant="body2" color="text.secondary">✗ {r.name}: {r.reason}</Typography>)}
                        </>}
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setPreview(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy || !preview.data.sending_enabled || !preview.data.can_send} onClick={doInvite}>
                            Send {preview.data.can_send} invitation{preview.data.can_send === 1 ? '' : 's'}</Button>
                    </DialogActions>
                </>}
            </Dialog>
            {busy && <Box sx={{ position: 'fixed', bottom: 16, right: 16 }}><CircularProgress size={24} /></Box>}
        </Box>
    );
}
