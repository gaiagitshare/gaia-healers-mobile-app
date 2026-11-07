import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    Divider, FormControlLabel, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow,
    TextField, Typography, useMediaQuery,
} from '@mui/material';
import {
    getReconSummary, runReconChecks, getReconIssues, getReconIssue, reconComment, reconAssign, reconStatus, reconAction,
} from '../utils/api';

/**
 * Ticket Reconciliation & Issue Resolution.
 *
 * Every problem the system finds with this event's tickets, as a record a
 * person can open, fix and close -- without knowing anything about the
 * database. The checks only find; every correction is a button that goes
 * through the same rules the desk works under (paid quantity, no silent
 * downgrades, one seat at a time), asks for a note, and asks for confirmation
 * when it changes who holds a ticket, what it grants or where it is sent.
 *
 * Nothing on this screen sends an email. The bulk ticket email stays locked
 * until the whole list passes its check AND the owner approves sending.
 */

const PRIORITIES = [
    ['critical', 'Critical', 'error'],
    ['high', 'High', 'warning'],
    ['medium', 'Medium', 'info'],
    ['low', 'Low', 'default'],
];
const PCOLOR = Object.fromEntries(PRIORITIES.map(([k, , c]) => [k, c]));
const STATUSES = [
    ['unresolved', 'Unresolved (open + in review)'],
    ['open', 'Open'],
    ['in_review', 'In review'],
    ['reviewed', 'Reviewed, kept as is'],
    ['resolved', 'Resolved'],
    ['dismissed', 'Dismissed'],
    ['all', 'All'],
];
const STATUS_LABEL = { open: 'Open', in_review: 'In review', reviewed: 'Reviewed', resolved: 'Resolved', dismissed: 'Dismissed' };
const when = (iso) => (iso ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const err = (e) => {
    const d = e?.response?.data?.detail;
    return typeof d === 'string' ? d : (e?.message || 'Something went wrong');
};
const money = (n, c) => (n == null ? '' : `${c && c !== 'USD' ? c + ' ' : '$'}${Number(n).toFixed(2)}`);

// The forms behind each correction. `sensitive` = asks the person to confirm.
const ACTIONS = {
    issue_seat: {
        label: 'Issue missing seat', sensitive: true,
        help: 'Creates ONE more ticket on this booking, for a seat the buyer already paid for. The system refuses if '
            + 'the booking already has every ticket it paid for. If the guest\'s name is not known, enter '
            + '"Guest of" and the buyer\'s name; the ticket goes to the buyer.',
        fields: [['first_name', 'Guest first name'], ['last_name', 'Guest last name'], ['email', 'Guest email (optional)'], ['phone', 'Guest phone (optional)']],
        confirm: 'I confirm the buyer paid for this seat and it is not a duplicate charge.',
    },
    fix_identity: {
        label: 'Correct name & contact', perTicket: true,
        help: 'Fixes the name, phone or email on one ticket. Changing the email changes who the ticket belongs to, '
            + 'so it needs confirmation.',
        fields: [['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'], ['email', 'Email (changes the holder)']],
        confirm: 'I confirm this is the right person for this ticket.',
    },
    change_category: {
        label: 'Correct ticket category', perTicket: true, sensitive: true,
        help: 'Changes the pass on one ticket. Only do this when a payment supports it, and say which one in the note. '
            + 'A recorded complimentary upgrade is never taken away from here.',
        fields: [['ticket_type_id', 'New pass', 'tt'], ['allow_downgrade', 'This is a downgrade (moves to a lower pass)', 'bool']],
        confirm: 'I confirm a payment supports this pass change.',
    },
    mark_duplicate: {
        label: 'Mark duplicate payment for review',
        help: 'Records that a payment looks like a duplicate and needs a decision. Nothing is refunded, cancelled or '
            + 'changed. A refund, if needed, is made in GHL.',
        fields: [],
    },
    hold: {
        label: 'Hold from email', perTicket: true,
        help: 'Keeps this ticket out of the bulk ticket email until someone releases it.', fields: [],
    },
    release: {
        label: 'Release to email list', perTicket: true, sensitive: true,
        help: 'Allows this ticket into the bulk ticket email. Nothing is sent now: the list still has to pass its check '
            + 'and be approved before any email goes out.', fields: [],
        confirm: 'I confirm this ticket may be emailed to its holder.',
    },
    rebuild_email: {
        label: 'Rebuild email record',
        help: 'Recalculates the planned email for this booking so it carries every live ticket of the booking (guest '
            + 'seats go to the paying buyer). Nothing is sent.', fields: [],
    },
    set_delivery_email: {
        label: 'Correct delivery email', sensitive: true,
        help: 'Changes the address the booking\'s ticket email will go to. Nothing is sent now.',
        fields: [['email', 'Deliver to this email']],
        confirm: 'I confirm this address belongs to the buyer or ticket holder.',
    },
};

function PriorityChip({ p }) {
    return <Chip size="small" label={(PRIORITIES.find(([k]) => k === p) || [p, p])[1]} color={PCOLOR[p] || 'default'} />;
}

export default function Reconciliation() {
    const { id } = useParams();
    const navigate = useNavigate();
    const narrow = useMediaQuery('(max-width:700px)');
    const [summary, setSummary] = useState(null);
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [filters, setFilters] = useState({ status: 'unresolved', priority: '', kind: '', q: '', assigned: '' });
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [detail, setDetail] = useState(null);
    const [act, setAct] = useState(null); // { action, ticket }
    const [form, setForm] = useState({});
    const [statusAsk, setStatusAsk] = useState(null);
    const [note, setNote] = useState('');
    const [comment, setComment] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
        Promise.all([getReconSummary(id), getReconIssues(id, params)])
            .then(([s, l]) => { setSummary(s.data); setRows(l.data.rows); setTotal(l.data.total); setError(''); })
            .catch((e) => setError(err(e)))
            .finally(() => setLoading(false));
    }, [id, filters]);
    useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

    const open = (issueId) => getReconIssue(id, issueId).then((r) => setDetail(r.data)).catch((e) => setError(err(e)));
    const refreshDetail = () => { if (detail) open(detail.id); load(); };

    const runChecks = () => {
        setRunning(true);
        runReconChecks(id).then((r) => {
            setNotice(`Checks finished: ${r.data.detected} problems found, ${r.data.created} new, ${r.data.cleared} cleared.`);
            load();
        }).catch((e) => setError(err(e))).finally(() => setRunning(false));
    };

    const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
    const kinds = summary?.kinds || {};
    const admins = summary?.admins || [];

    const submitAction = () => {
        const spec = ACTIONS[act.action];
        const body = { action: act.action, note, ...form };
        if (act.ticket) body.ticket_id = act.ticket.ticket_id;
        if ((act.action === 'hold' || act.action === 'release') && act.ticket) body.ticket_ids = [act.ticket.ticket_id];
        if (spec.sensitive || (act.action === 'fix_identity' && form.email)) body.confirm = Boolean(form.__confirm);
        delete body.__confirm;
        setBusy(true);
        reconAction(id, detail.id, body).then((r) => {
            const res = r.data.result || {};
            setNotice(`${spec.label}: done.${res.issued_ticket_id ? ` New ticket #${res.issued_ticket_id}.` : ''} ${res.note || ''} `
                + `The checks ran again${r.data.detected ? '; this issue is still found' : ' and no longer find this issue'}.`);
            setAct(null); setForm({}); setNote(''); refreshDetail();
        }).catch((e) => setError(err(e))).finally(() => setBusy(false));
    };

    const submitStatus = () => {
        setBusy(true);
        reconStatus(id, detail.id, { status: statusAsk.status, note, real_seat: statusAsk.real_seat })
            .then((r) => { setNotice(`Marked ${STATUS_LABEL[r.data.status] || r.data.status}.`); setStatusAsk(null); setNote(''); refreshDetail(); })
            .catch((e) => setError(err(e))).finally(() => setBusy(false));
    };

    const bulk = summary?.bulk_check;
    const actionsHere = useMemo(() => new Set(detail?.actions || []), [detail]);

    return (
        <Box>
            <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" alignItems={narrow ? 'stretch' : 'center'} spacing={1} sx={{ mb: 1 }}>
                <Box>
                    <Typography variant="h5">Ticket Reconciliation &amp; Issue Resolution</Typography>
                    <Typography variant="body2" color="text.secondary">
                        Problems the system found with this event's tickets. Open one to see why it was flagged, what to do, and the tools to fix it.
                        Last checked {when(summary?.last_checked_at)}.
                    </Typography>
                </Box>
                <Button variant="contained" onClick={runChecks} disabled={running}>{running ? 'Checking…' : 'Run checks now'}</Button>
            </Stack>

            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1 }}>{notice}</Alert>}

            {bulk && (
                <Alert severity={!bulk.imported ? 'info' : bulk.ok ? 'success' : 'warning'} sx={{ mb: 2 }}>
                    <b>Bulk ticket email: sending is locked.</b>{' '}
                    {!bulk.imported ? 'The email list has not been checked here yet.'
                        : bulk.ok ? 'The planned emails pass every check. Sending still needs the owner\'s separate approval.'
                            : `The planned emails do not pass yet: ${bulk.critical} problem${bulk.critical === 1 ? '' : 's'} to fix first.`}
                    {bulk.changed_since_list ? ` ${bulk.changed_since_list} planned email(s) changed since the approved list, so the list must be rebuilt and approved again.` : ''}
                    {!bulk.ok && (bulk.problems || []).slice(0, 4).map((p, n) => (
                        <div key={n}>• {p.detail} {p.ticket_ids?.length ? `(tickets ${p.ticket_ids.join(', ')})` : ''}</div>
                    ))}
                </Alert>
            )}

            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
                <Paper sx={{ p: 1.5, minWidth: 120, cursor: 'pointer' }} onClick={() => setFilters((f) => ({ ...f, priority: '', status: 'unresolved' }))}>
                    <Typography variant="caption" color="text.secondary">Unresolved</Typography>
                    <Typography variant="h5">{summary?.unresolved ?? '—'}</Typography>
                </Paper>
                {PRIORITIES.map(([k, label, color]) => (
                    <Paper key={k} sx={{ p: 1.5, minWidth: 110, cursor: 'pointer', outline: filters.priority === k ? 2 : 0 }}
                           onClick={() => setFilters((f) => ({ ...f, priority: f.priority === k ? '' : k, status: 'unresolved' }))}>
                        <Typography variant="caption" color={color === 'default' ? 'text.secondary' : `${color}.main`}>{label}</Typography>
                        <Typography variant="h5">{summary?.by_priority?.[k] ?? '—'}</Typography>
                    </Paper>
                ))}
            </Stack>

            <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 1 }}>
                <TextField size="small" label="Search buyer, attendee, email, order or ticket #" value={filters.q} onChange={set('q')} sx={{ flex: 2 }} />
                <TextField size="small" select label="Status" value={filters.status} onChange={set('status')} sx={{ minWidth: 170 }}>
                    {STATUSES.map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
                </TextField>
                <TextField size="small" select label="Issue type" value={filters.kind} onChange={set('kind')} sx={{ minWidth: 200 }}>
                    <MenuItem value="">All types</MenuItem>
                    {Object.entries(kinds).map(([k, l]) => <MenuItem key={k} value={k}>{l}{summary?.by_kind?.[k] ? ` (${summary.by_kind[k]})` : ''}</MenuItem>)}
                </TextField>
                <TextField size="small" select label="Assigned to" value={filters.assigned} onChange={set('assigned')} sx={{ minWidth: 150 }}>
                    <MenuItem value="">Anyone</MenuItem>
                    <MenuItem value="me">Me</MenuItem>
                    <MenuItem value="none">Nobody yet</MenuItem>
                    {admins.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.name}</MenuItem>)}
                </TextField>
            </Stack>

            <Paper variant="outlined">
                {loading ? <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box> : (
                    <Table size="small">
                        <TableHead><TableRow>
                            <TableCell>Priority</TableCell>
                            <TableCell>Issue</TableCell>
                            {!narrow && <TableCell>Type</TableCell>}
                            <TableCell>Status</TableCell>
                            {!narrow && <TableCell>Assigned</TableCell>}
                        </TableRow></TableHead>
                        <TableBody>
                            {rows.map((r) => (
                                <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => open(r.id)}>
                                    <TableCell><PriorityChip p={r.priority} /></TableCell>
                                    <TableCell>{r.title}{!r.detected && <Chip size="small" label="no longer found" sx={{ ml: 1 }} />}</TableCell>
                                    {!narrow && <TableCell>{r.kind_label}</TableCell>}
                                    <TableCell>{STATUS_LABEL[r.status] || r.status}</TableCell>
                                    {!narrow && <TableCell>{r.assigned_name || '—'}</TableCell>}
                                </TableRow>
                            ))}
                            {!rows.length && <TableRow><TableCell colSpan={5}>Nothing here. {filters.status === 'unresolved' ? 'No unresolved issues match.' : ''}</TableCell></TableRow>}
                        </TableBody>
                    </Table>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>{total} issue(s)</Typography>
            </Paper>

            {/* ── One issue ─────────────────────────────────────────────── */}
            <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="lg" fullScreen={narrow}>
                {detail && <>
                    <DialogTitle>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                            <PriorityChip p={detail.priority} />
                            <Chip size="small" variant="outlined" label={detail.kind_label} />
                            <Chip size="small" label={STATUS_LABEL[detail.status] || detail.status} />
                            {!detail.detected && <Chip size="small" color="success" label="The checks no longer find this" />}
                        </Stack>
                        <Typography variant="h6" sx={{ mt: 1 }}>{detail.title}</Typography>
                    </DialogTitle>
                    <DialogContent dividers>
                        <Alert severity="info" sx={{ mb: 1 }}><b>Why this was flagged.</b> {detail.explanation}</Alert>
                        <Alert severity="success" icon={false} sx={{ mb: 2 }}><b>Recommended correction.</b> {detail.recommendation}</Alert>

                        {detail.booking && (
                            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
                                <Chip label={`Bought: ${detail.booking.paid_for}`} />
                                <Chip label={`Tickets issued: ${detail.booking.issued}`} />
                                <Chip color={detail.booking.missing_seats ? 'warning' : 'default'} label={`Missing seats: ${detail.booking.missing_seats}`} />
                                <Chip label={`In the email or delivered: ${detail.tickets.filter((t) => ['in email list', 'delivered'].includes(t.email_status)).length}`} />
                                {detail.booking.possible_double_charges > 0 &&
                                    <Chip color="error" label={`Possible duplicate payments: ${detail.booking.possible_double_charges}`} />}
                            </Stack>
                        )}

                        <Typography variant="subtitle2">Tickets</Typography>
                        <Box sx={{ overflowX: 'auto', mb: 2 }}>
                            <Table size="small">
                                <TableHead><TableRow>
                                    <TableCell>#</TableCell><TableCell>Holder</TableCell><TableCell>Pass</TableCell>
                                    <TableCell>Status</TableCell><TableCell>Email</TableCell><TableCell />
                                </TableRow></TableHead>
                                <TableBody>
                                    {detail.tickets.map((t) => (
                                        <TableRow key={t.ticket_id}>
                                            <TableCell>{t.ticket_id}{t.ticket_id === detail.booking?.buyer_ticket_id ? ' (buyer)' : ''}</TableCell>
                                            <TableCell>
                                                {t.name}<br /><Typography variant="caption" color="text.secondary">{t.email}{t.phone ? ` · ${t.phone}` : ''}</Typography>
                                                {t.needs_name_check && <Chip size="small" color="warning" label="name to confirm" sx={{ ml: 0.5 }} />}
                                                {t.transferred && <Chip size="small" label="transferred" sx={{ ml: 0.5 }} />}
                                            </TableCell>
                                            <TableCell>{t.pass}</TableCell>
                                            <TableCell>{t.status}{t.checked_in ? ' · checked in' : ''}</TableCell>
                                            <TableCell>{t.email_status}{t.planned_email?.changed ? ' (changed, list rebuild needed)' : ''}</TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                                {['fix_identity', 'change_category', t.hold?.state === 'held' ? 'release' : 'hold']
                                                    .filter((a) => actionsHere.has(a))
                                                    .map((a) => <Button key={a} size="small" onClick={() => { setAct({ action: a, ticket: t }); setForm({}); setNote(''); }}>{ACTIONS[a].label}</Button>)}
                                                <Button size="small" onClick={() => navigate(`/events/${id}/attendees?q=${encodeURIComponent(t.email || t.name)}`)}>Open in Attendees</Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                    {!detail.tickets.length && <TableRow><TableCell colSpan={6}>No ticket exists for this yet.</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                        </Box>

                        <Typography variant="subtitle2">Orders and payments</Typography>
                        <Box sx={{ overflowX: 'auto', mb: 2 }}>
                            <Table size="small">
                                <TableHead><TableRow>
                                    <TableCell>Paid</TableCell><TableCell>Order</TableCell><TableCell>Product</TableCell>
                                    <TableCell>Amount</TableCell><TableCell>Status</TableCell><TableCell>On ticket</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {detail.payments.map((p) => (
                                        <TableRow key={p.id}>
                                            <TableCell>{when(p.at)}</TableCell>
                                            <TableCell>{p.order_id}</TableCell>
                                            <TableCell>{(p.products || []).join(', ')}</TableCell>
                                            <TableCell>{money(p.amount, p.currency)}{p.refunded ? ` (refunded ${money(p.refunded, p.currency)})` : ''}</TableCell>
                                            <TableCell>{p.status}</TableCell>
                                            <TableCell>{p.ticket_id ? `#${p.ticket_id}` : 'none'}</TableCell>
                                        </TableRow>
                                    ))}
                                    {!detail.payments.length && <TableRow><TableCell colSpan={6}>No payment on record for this issue.</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                            <Typography variant="caption" color="text.secondary">Payment records are shown as received and are never changed from here.</Typography>
                        </Box>

                        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Fix it</Typography>
                        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
                            {['issue_seat', 'rebuild_email', 'set_delivery_email', 'mark_duplicate'].filter((a) => actionsHere.has(a)).map((a) => (
                                <Button key={a} variant="outlined" onClick={() => { setAct({ action: a }); setForm({}); setNote(''); }}>{ACTIONS[a].label}</Button>
                            ))}
                            {detail.kind === 'possible_duplicate_payment' && <>
                                <Button variant="outlined" color="success" onClick={() => { setStatusAsk({ status: 'reviewed', real_seat: true, label: 'Reviewed: it was a real extra seat' }); setNote(''); }}>It was a real extra seat</Button>
                                <Button variant="outlined" color="warning" onClick={() => { setStatusAsk({ status: 'reviewed', real_seat: false, label: 'Reviewed: it was a duplicate charge (refund in GHL)' }); setNote(''); }}>It was a duplicate charge</Button>
                            </>}
                        </Stack>

                        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Decision</Typography>
                        <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 2 }}>
                            <TextField size="small" select label="Assigned to" value={detail.assigned_to || ''} sx={{ minWidth: 200 }}
                                       onChange={(e) => reconAssign(id, detail.id, e.target.value || null).then(refreshDetail).catch((x) => setError(err(x)))}>
                                <MenuItem value="">Nobody</MenuItem>
                                {detail.admins.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                            </TextField>
                            <Button onClick={() => { setStatusAsk({ status: 'reviewed', label: 'Reviewed: keep it as it is' }); setNote(''); }}>Mark reviewed</Button>
                            <Button color="success" onClick={() => { setStatusAsk({ status: 'resolved', label: 'Resolved' }); setNote(''); }}>Mark resolved</Button>
                            <Button color="inherit" onClick={() => { setStatusAsk({ status: 'dismissed', label: 'Dismiss (not a real problem)' }); setNote(''); }}>Dismiss</Button>
                            {!['open', 'in_review'].includes(detail.status) &&
                                <Button onClick={() => { setStatusAsk({ status: 'open', label: 'Reopen' }); setNote(''); }}>Reopen</Button>}
                        </Stack>

                        <Divider sx={{ my: 1 }} />
                        <Typography variant="subtitle2">Notes and history</Typography>
                        <Stack direction="row" spacing={1} sx={{ my: 1 }}>
                            <TextField size="small" fullWidth placeholder="Add an internal note (who you spoke to, what was decided)" value={comment}
                                       onChange={(e) => setComment(e.target.value)} />
                            <Button disabled={comment.trim().length < 2}
                                    onClick={() => reconComment(id, detail.id, comment).then(() => { setComment(''); refreshDetail(); }).catch((x) => setError(err(x)))}>Add note</Button>
                        </Stack>
                        {[...detail.history].reverse().map((h, n) => (
                            <Box key={n} sx={{ py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                                <Typography variant="caption" color="text.secondary">{when(h.at)} · {h.actor} · {h.kind}</Typography>
                                <Typography variant="body2">{h.text}</Typography>
                                {(h.before || h.after) && (
                                    <Typography variant="caption" component="pre" sx={{ whiteSpace: 'pre-wrap', color: 'text.secondary', m: 0 }}>
                                        {h.before ? `before: ${JSON.stringify(h.before)}\n` : ''}{h.after ? `after: ${JSON.stringify(h.after)}` : ''}
                                    </Typography>
                                )}
                            </Box>
                        ))}
                    </DialogContent>
                    <DialogActions><Button onClick={() => setDetail(null)}>Close</Button></DialogActions>
                </>}
            </Dialog>

            {/* ── A correction ──────────────────────────────────────────── */}
            <Dialog open={Boolean(act)} onClose={() => !busy && setAct(null)} fullWidth maxWidth="sm">
                {act && (() => {
                    const spec = ACTIONS[act.action];
                    const needsConfirm = spec.sensitive || (act.action === 'fix_identity' && form.email);
                    const dupBooking = act.action === 'issue_seat' && detail?.booking?.possible_double_charges > 0;
                    return <>
                        <DialogTitle>{spec.label}{act.ticket ? ` — ticket #${act.ticket.ticket_id} (${act.ticket.name})` : ''}</DialogTitle>
                        <DialogContent dividers>
                            <Typography variant="body2" sx={{ mb: 2 }}>{spec.help}</Typography>
                            {dupBooking && <Alert severity="error" sx={{ mb: 2 }}>This booking has a suspected duplicate payment. The seat is only
                                issued if the duplicate-payment issue was reviewed as a real seat, or you tick the box below.</Alert>}
                            {spec.fields.map(([k, label, type]) => type === 'tt' ? (
                                <TextField key={k} select fullWidth size="small" label={label} sx={{ mb: 1 }} value={form[k] || ''}
                                           onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}>
                                    {(detail?.ticket_types || []).map((tt) => <MenuItem key={tt.id} value={tt.id}>{tt.name}</MenuItem>)}
                                </TextField>
                            ) : type === 'bool' ? (
                                <FormControlLabel key={k} control={<Checkbox checked={Boolean(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />} label={label} />
                            ) : (
                                <TextField key={k} fullWidth size="small" label={label} sx={{ mb: 1 }} value={form[k] || ''}
                                           onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                            ))}
                            <TextField fullWidth multiline minRows={2} label="Note: why (required, kept in the history)" value={note}
                                       onChange={(e) => setNote(e.target.value)} sx={{ mt: 1 }} />
                            {dupBooking && (
                                <FormControlLabel control={<Checkbox checked={Boolean(form.confirm_real_seat)} onChange={(e) => setForm((f) => ({ ...f, confirm_real_seat: e.target.checked }))} />}
                                                  label="The buyer confirmed this was a real, separately paid seat." />
                            )}
                            {needsConfirm && (
                                <FormControlLabel control={<Checkbox checked={Boolean(form.__confirm)} onChange={(e) => setForm((f) => ({ ...f, __confirm: e.target.checked }))} />}
                                                  label={spec.confirm || 'I confirm this change.'} />
                            )}
                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>No email or message is sent by this change.</Typography>
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={() => setAct(null)} disabled={busy}>Cancel</Button>
                            <Button variant="contained" onClick={submitAction}
                                    disabled={busy || note.trim().length < 3 || (needsConfirm && !form.__confirm)}>{busy ? 'Working…' : spec.label}</Button>
                        </DialogActions>
                    </>;
                })()}
            </Dialog>

            {/* ── A decision ────────────────────────────────────────────── */}
            <Dialog open={Boolean(statusAsk)} onClose={() => !busy && setStatusAsk(null)} fullWidth maxWidth="sm">
                {statusAsk && <>
                    <DialogTitle>{statusAsk.label}</DialogTitle>
                    <DialogContent dividers>
                        <TextField fullWidth multiline minRows={3} label="Note explaining the decision (required)" value={note} onChange={(e) => setNote(e.target.value)} />
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                            The checks run again afterwards. If they still find the problem, a "resolved" issue reopens by itself.
                        </Typography>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setStatusAsk(null)} disabled={busy}>Cancel</Button>
                        <Button variant="contained" onClick={submitStatus} disabled={busy || (statusAsk.status !== 'open' && note.trim().length < 3)}>Save</Button>
                    </DialogActions>
                </>}
            </Dialog>
        </Box>
    );
}
