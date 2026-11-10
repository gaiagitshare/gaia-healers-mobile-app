import React, { useEffect, useState } from 'react';
import {
    Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions,
    DialogContent, DialogTitle, FormControlLabel, Menu, MenuItem, Paper, Radio, RadioGroup, Stack, Step, StepLabel, Stepper,
    Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ecIssueAssign, ecIssueComment, ecIssueFix, ecIssuePropose, ecIssueProposePreview, ecPassOptions, ecReviewers } from '../utils/api';
import { errText, gst, money, SeverityChip } from './EmailCenterShared';

/**
 * The fix workflow inside the Review panel: the 5-step bar, one card per
 * reconciliation problem with its actions, and the action forms. Also the
 * pieces the Approvals and Needs Attention tabs share (proposal chips,
 * value/step formatting, the re-check result, assignment).
 * Contract: docs/EMAIL_CENTER_API.md, "Fix workflow".
 */

// ── Shared vocabulary ───────────────────────────────────────────────────────
export const ROOT_CAUSES = [
    ['one_off', 'Just this order'],
    ['mapping', 'Wrong product-to-ticket mapping'],
    ['ticket_generation', 'Ticket not created at purchase'],
    ['guest_assignment', 'Guest seat assigned wrongly'],
    ['payment_sync', 'Payment not synced'],
    ['unknown', 'Not sure'],
];
export const rootCauseLabel = (k) => (ROOT_CAUSES.find(([v]) => v === k) || [null, k || '—'])[1];

export const PROPOSAL_STATE = {
    proposed: ['Waiting for approval', 'warning'],
    applying: ['Being applied…', 'info'],
    applied: ['Applied — fixed', 'success'],
    applied_still_flagged: ['Applied — still flagged', 'warning'],
    failed: ['Failed', 'error'],
    rejected: ['Rejected', 'default'],
    withdrawn: ['Withdrawn', 'default'],
};
export function ProposalChip({ s }) {
    const [label, color] = PROPOSAL_STATE[s] || [s || '—', 'default'];
    return <Chip size="small" label={label} color={color} />;
}

const ACTION_LABEL = {
    correct_holder: 'Correct holder name / phone', set_delivery_email: 'Correct delivery email', rebuild_email: 'Rebuild the email record',
    hold: 'Hold from email', release_contact: 'Release hold (address confirmed)', flag_duplicate: 'Flag payments for an admin',
    acknowledge: 'Mark reviewed (keep as is)', issue_seat: 'Create a missing ticket', decide_duplicate: 'Decide: real seat or double charge',
    change_category: 'Change the pass', correct_ticket_email: 'Change the ticket email', release: 'Release the email hold',
    request_admin: 'Ask an admin to act',
};
const ids = (xs) => (xs || []).map((x) => `#${x}`).join(', ');

/** One proposal step {action, issue_id, body} in plain words. */
export function stepText(s) {
    const b = s?.body || {};
    switch (s?.action) {
        case 'issue_seat': return `Create one missing ticket for ${[b.first_name, b.last_name].filter(Boolean).join(' ') || 'a guest'}${b.email ? ` (${b.email})` : ''} with a new QR code.`;
        case 'decide_duplicate': return `Record the payments as ${b.real_seat ? 'a real extra seat' : 'a double charge (refund in GHL)'}.`;
        case 'change_category': return `Change ticket #${b.ticket_id}'s pass (new pass #${b.ticket_type_id}).`;
        case 'correct_ticket_email': return `Change ticket #${b.ticket_id}'s email to ${b.email}.`;
        case 'release': case 'release_contact': return `Release ticket(s) ${ids(b.ticket_ids)} from the email hold.`;
        case 'hold': return `Hold ticket(s) ${ids(b.ticket_ids)} out of every email.`;
        case 'set_delivery_email': return `Send the ticket email to ${b.email}.`;
        case 'correct_holder': return `Correct ticket #${b.ticket_id}'s holder to ${[b.first_name, b.last_name].filter(Boolean).join(' ')}.`;
        default: return `${ACTION_LABEL[s?.action] || String(s?.action || '').replace(/_/g, ' ')}.`;
    }
}

const VAL_LABEL = { tickets: 'tickets', paid_for: 'paid for', ticket: 'ticket', pass: 'pass', email: 'email', held: 'held tickets' };
/** current_value / proposed_value (a list of small objects) as one line. */
export function valueText(v) {
    if (v == null || (Array.isArray(v) && !v.length)) return '—';
    const one = (o) => {
        if (o == null || typeof o !== 'object') return String(o ?? '—');
        return Object.entries(o).map(([k, x]) => {
            if (k === 'ticket') return `ticket #${x}`;
            if (Array.isArray(x)) return `${VAL_LABEL[k] || k}: ${x.length ? ids(x) : 'none'}`;
            return `${VAL_LABEL[k] || k}: ${x ?? '—'}`;
        }).join(', ');
    };
    return Array.isArray(v) ? v.map(one).join(' · ') : one(v);
}

export function ChangeLine({ from, to }) {
    return (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ my: 1 }}>
            <Paper variant="outlined" sx={{ p: 1, flex: 1, bgcolor: 'action.hover' }}>
                <Typography variant="caption" color="text.secondary">Now</Typography>
                <Typography variant="body2">{from || '—'}</Typography>
            </Paper>
            <Typography variant="h6" sx={{ textAlign: 'center' }} aria-hidden>→</Typography>
            <Paper variant="outlined" sx={{ p: 1, flex: 1, borderColor: 'success.main' }}>
                <Typography variant="caption" color="text.secondary">After</Typography>
                <Typography variant="body2" fontWeight={600}>{to || '—'}</Typography>
            </Paper>
        </Stack>
    );
}

/** The {issues, booking} re-check result in plain words. */
export function ValidationResult({ v, issueId }) {
    if (!v) return null;
    const issues = Object.entries(v.issues || {}).sort(([a], [b]) => (String(b) === String(issueId)) - (String(a) === String(issueId)));
    const bk = v.booking;
    return (
        <Box sx={{ mt: 1 }}>
            {issues.map(([id, x]) => (
                <Alert key={id} severity={x.still_found ? 'warning' : 'success'} sx={{ mb: 1 }}>
                    {x.still_found ? <>Re-check: still found — {x.title || 'the checks still see this problem'}.</> : <>Re-check: problem fixed ✓</>}
                </Alert>
            ))}
            {bk && (
                <Alert severity={bk.blockers?.length ? 'warning' : 'info'} icon={false}>
                    <Typography variant="body2"><b>The order now:</b> paid for {bk.paid_for} · generated {bk.generated} · QR {bk.qr_ok ? 'OK' : 'problem'}
                        {' '}· {bk.can_approve ? 'can be approved' : 'cannot be approved yet'}</Typography>
                    {bk.recipients?.length > 0 && <Typography variant="body2">Email goes to: {bk.recipients.filter(Boolean).join(', ')}</Typography>}
                    {bk.blockers?.length > 0
                        ? bk.blockers.map((t, i) => <Typography key={i} variant="body2">• Still blocking: {t}</Typography>)
                        : <Typography variant="body2">No blockers left.</Typography>}
                </Alert>
            )}
        </Box>
    );
}

// ── Workflow bar ────────────────────────────────────────────────────────────
const FLOW = ['Review', 'Fix', 'Verify', 'Approve', 'Send'];
const FLOW_AT = { fix: 1, approve: 3, send: 4 };
export function WorkflowBar({ stage }) {
    const active = FLOW_AT[stage] ?? 0;
    return (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, overflowX: 'auto' }}>
            <Stepper activeStep={active} alternativeLabel sx={{ minWidth: 380 }}>
                {FLOW.map((l) => <Step key={l}><StepLabel>{l}</StepLabel></Step>)}
            </Stepper>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 1 }}>
                {stage === 'fix' ? 'Fix the problems below first. "Re-check now" is the Verify step.'
                    : stage === 'approve' ? 'No blockers left: check the order and approve it.'
                        : stage === 'send' ? 'Approved: the ticket email can be sent.' : 'Read the order below.'}
            </Typography>
        </Paper>
    );
}

// ── Problem stage stepper ───────────────────────────────────────────────────
const STAGES = ['Flagged', 'Investigating', 'Correction proposed', 'Confirmed', 'Corrected', 'Revalidated'];
const STAGE_AT = { flagged: 0, investigating: 1, correction_proposed: 2, confirmed: 3, reviewed: 3, corrected_still_flagged: 4, revalidated: 5 };
function StageStepper({ stage }) {
    const at = STAGE_AT[stage] ?? 0;
    const labels = STAGES.map((l, i) => (i === 3 && stage === 'reviewed' ? 'Reviewed (kept as is)' : l));
    return (
        <Box sx={{ overflowX: 'auto', my: 1 }}>
            <Stepper activeStep={stage === 'revalidated' ? 6 : at} alternativeLabel sx={{ minWidth: 520 }}>
                {labels.map((l, i) => (
                    <Step key={l} completed={i < at || stage === 'revalidated'}>
                        <StepLabel error={i === 4 && stage === 'corrected_still_flagged'}
                                   optional={i === 4 && stage === 'corrected_still_flagged' ? <Typography variant="caption" color="error">still flagged</Typography> : null}>
                            <Typography variant="caption">{l}</Typography>
                        </StepLabel>
                    </Step>
                ))}
            </Stepper>
        </Box>
    );
}

// ── Evidence ────────────────────────────────────────────────────────────────
/** The headline sentence, when the numbers tell the story. */
export function evidenceSentence(ev) {
    if (!ev) return '';
    const out = [];
    const n = (x, w) => `${x} ${w}${x === 1 ? '' : 's'}`;
    if (ev.paid_for != null && ev.issued != null) {
        out.push(ev.paid_for === ev.issued
            ? `Customer purchased ${n(ev.paid_for, 'ticket')}, and ${ev.issued} ${ev.issued === 1 ? 'was' : 'were'} generated.`
            : ev.issued < ev.paid_for
                ? `Customer purchased ${n(ev.paid_for, 'ticket')}, but only ${ev.issued} ${ev.issued === 1 ? 'was' : 'were'} generated.`
                : `Customer purchased ${n(ev.paid_for, 'ticket')}, but ${ev.issued} were generated.`);
    }
    if (ev.possible_double_charges) out.push(`${n(ev.possible_double_charges, 'payment')} may be a double charge.`);
    return out.join(' ');
}

export function EvidenceTables({ ev }) {
    if (!ev) return null;
    return (
        <Box>
            <Typography variant="caption" color="text.secondary">Payments</Typography>
            <Box sx={{ overflowX: 'auto', mb: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small">
                    <TableHead><TableRow>
                        <TableCell>Order</TableCell><TableCell>Products</TableCell><TableCell>Amount</TableCell>
                        <TableCell>Status</TableCell><TableCell>Paid</TableCell><TableCell>Ticket</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                        {(ev.payments || []).map((p, i) => (
                            <TableRow key={`${p.transaction || p.order_id}-${i}`}>
                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{p.order_id || '—'}{p.transaction ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{p.transaction}</Typography> : null}</TableCell>
                                <TableCell sx={{ minWidth: 160 }}>{(p.products || []).join(', ') || '—'}</TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{money(p.amount)}{p.refunded ? ` (refunded ${money(p.refunded)})` : ''}</TableCell>
                                <TableCell>{p.status}</TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(p.paid_at)}</TableCell>
                                <TableCell>{p.ticket_id ? `#${p.ticket_id}` : '—'}</TableCell>
                            </TableRow>
                        ))}
                        {!ev.payments?.length && <TableRow><TableCell colSpan={6}>No payment found.</TableCell></TableRow>}
                    </TableBody>
                </Table>
            </Box>
            <Typography variant="caption" color="text.secondary">Tickets</Typography>
            <Box sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small">
                    <TableHead><TableRow>
                        <TableCell>Ticket</TableCell><TableCell>Holder</TableCell><TableCell>Email</TableCell>
                        <TableCell>Pass</TableCell><TableCell>Status</TableCell><TableCell>Seat</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                        {(ev.tickets || []).map((t) => (
                            <TableRow key={t.id}>
                                <TableCell>#{t.id}</TableCell>
                                <TableCell sx={{ minWidth: 120 }}>{t.name}{t.needs_name_check ? <Chip size="small" color="warning" label="Name to confirm" sx={{ ml: 0.5 }} /> : null}</TableCell>
                                <TableCell>{t.email || '—'}</TableCell>
                                <TableCell sx={{ minWidth: 120 }}>{t.pass || '—'}</TableCell>
                                <TableCell>{t.status}</TableCell>
                                <TableCell>{t.seat ?? '—'}</TableCell>
                            </TableRow>
                        ))}
                        {!ev.tickets?.length && <TableRow><TableCell colSpan={6}>No ticket.</TableCell></TableRow>}
                    </TableBody>
                </Table>
            </Box>
        </Box>
    );
}

// ── Assignment ──────────────────────────────────────────────────────────────
/** "Assign to me" + "Assign…" (people from /reviewers). Only for items with an issue id. */
export function AssignControls({ eventId, issueId, assignedTo, myId, size = 'small', onDone, onError }) {
    const [anchor, setAnchor] = useState(null);
    const [people, setPeople] = useState(null);
    const [busy, setBusy] = useState(false);
    const assign = (body) => {
        setBusy(true); setAnchor(null);
        ecIssueAssign(eventId, issueId, body).then(() => onDone && onDone()).catch((e) => onError && onError(errText(e))).finally(() => setBusy(false));
    };
    const openMenu = (e) => {
        setAnchor(e.currentTarget);
        if (!people) ecReviewers(eventId).then((r) => setPeople(r.data.items || [])).catch((er) => { setPeople([]); onError && onError(errText(er)); });
    };
    return (
        <>
            {assignedTo !== myId && <Button size={size} variant="outlined" disabled={busy} onClick={() => assign({ me: true })}>Assign to me</Button>}
            <Button size={size} disabled={busy} onClick={openMenu}>Assign…</Button>
            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
                {!people && <MenuItem disabled><CircularProgress size={16} /></MenuItem>}
                {(people || []).map((p) => (
                    <MenuItem key={p.id} selected={p.id === assignedTo} onClick={() => assign({ user_id: p.id })}>
                        {p.name}{p.admin ? ' (admin)' : ''}{p.id === myId ? ' — me' : ''}
                    </MenuItem>
                ))}
                {people && !people.length && <MenuItem disabled>No reviewers found</MenuItem>}
            </Menu>
        </>
    );
}

// ── Action dialog (direct fix or proposal) ──────────────────────────────────
const NO_FIELDS = new Set(['rebuild_email', 'release_contact', 'flag_duplicate', 'acknowledge', 'release', 'request_admin']);

function initialForm(action, problem, booking) {
    const tickets = problem?.evidence?.tickets || [];
    const lastName = booking?.purchaser_name || '';
    switch (action?.key) {
        case 'correct_holder': return { ticket_id: tickets.length === 1 ? tickets[0].id : '', first_name: '', last_name: '', phone: '' };
        case 'set_delivery_email': return { email: '' };
        case 'hold': return { ticket_ids: tickets.map((t) => t.id) };
        case 'issue_seat': return { first_name: 'Guest of', last_name: lastName, email: '', count: 1 };
        case 'decide_duplicate': return { real_seat: '' };
        case 'change_category': return { ticket_id: tickets.length === 1 ? tickets[0].id : '', ticket_type_id: '' };
        case 'correct_ticket_email': return { ticket_id: tickets.length === 1 ? tickets[0].id : '', email: '' };
        default: return {};
    }
}

const EMAIL_OK = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

/** The request body for an action, exactly as the table in the contract. */
function bodyFor(key, f, action) {
    switch (key) {
        case 'correct_holder': return { ticket_id: Number(f.ticket_id), first_name: f.first_name.trim(), last_name: f.last_name.trim(), phone: f.phone.trim() };
        case 'set_delivery_email': return { email: f.email.trim() };
        case 'hold': return { ticket_ids: f.ticket_ids };
        case 'release_contact': case 'release': return { ticket_ids: action.ticket_ids || [] };
        case 'issue_seat': return { first_name: f.first_name.trim(), last_name: f.last_name.trim(), email: f.email.trim(), count: Number(f.count) };
        case 'decide_duplicate': return { real_seat: f.real_seat === 'real' };
        case 'change_category': return { ticket_id: Number(f.ticket_id), ticket_type_id: Number(f.ticket_type_id) };
        case 'correct_ticket_email': return { ticket_id: Number(f.ticket_id), email: f.email.trim() };
        default: return {};
    }
}

function formMissing(key, f) {
    switch (key) {
        case 'correct_holder': return !f.ticket_id || !(f.first_name.trim() || f.last_name.trim() || f.phone.trim());
        case 'set_delivery_email': return !EMAIL_OK(f.email);
        case 'hold': return !f.ticket_ids?.length;
        case 'issue_seat': return !f.first_name.trim() || !(Number(f.count) >= 1) || (f.email.trim() && !EMAIL_OK(f.email));
        case 'decide_duplicate': return !f.real_seat;
        case 'change_category': return !f.ticket_id || !f.ticket_type_id;
        case 'correct_ticket_email': return !f.ticket_id || !EMAIL_OK(f.email);
        default: return false;
    }
}

/** Current → new, in words, for the confirmation screen. */
function changeFor(key, f, action, problem, booking, passes) {
    const tickets = problem?.evidence?.tickets || [];
    const t = tickets.find((x) => String(x.id) === String(f.ticket_id));
    const recipients = [...new Set((booking?.units || []).map((u) => u.recipient).filter(Boolean))].join(', ');
    switch (key) {
        case 'correct_holder': {
            const name = [f.first_name, f.last_name].map((x) => x.trim()).filter(Boolean).join(' ');
            return { from: `#${f.ticket_id} ${t?.name || ''}`, to: `#${f.ticket_id} ${name || t?.name || ''}${f.phone.trim() ? ` · phone ${f.phone.trim()}` : ''}`, tickets: [f.ticket_id] };
        }
        case 'set_delivery_email': return { from: recipients || 'No delivery email', to: f.email.trim(), tickets: tickets.map((x) => x.id) };
        case 'rebuild_email': return { from: 'The current email record', to: "Every ticket of the booking in the buyer's email", tickets: tickets.map((x) => x.id) };
        case 'hold': return { from: 'Can be emailed', to: 'Held out of every email', tickets: f.ticket_ids };
        case 'release_contact': case 'release': return { from: `Held: ${ids(action.ticket_ids)}`, to: 'Released — can be emailed', tickets: action.ticket_ids || [] };
        case 'flag_duplicate': return { from: 'Possible double charge, undecided', to: 'Payments marked for an admin to look at', tickets: [] };
        case 'acknowledge': return { from: `Problem ${problem?.status || 'open'}`, to: 'Reviewed — kept as is (the checks keep running)', tickets: [] };
        case 'issue_seat': {
            const ev = problem?.evidence || {};
            const n = Number(f.count) || 1;
            return { from: `${ev.issued ?? tickets.length} ticket(s) for ${ev.paid_for ?? '?'} paid`,
                     to: `${(ev.issued ?? tickets.length) + n} ticket(s) — ${n} new for ${[f.first_name, f.last_name].map((x) => x.trim()).filter(Boolean).join(' ')}`, tickets: [] };
        }
        case 'decide_duplicate': return { from: 'Undecided', to: f.real_seat === 'real' ? 'A real extra seat' : 'A double charge (refund in GHL)', tickets: [] };
        case 'change_category': {
            const p = passes?.find((x) => String(x.id) === String(f.ticket_type_id));
            return { from: `#${f.ticket_id} ${t?.pass || ''}`, to: `#${f.ticket_id} ${p?.name || ''}`, tickets: [f.ticket_id] };
        }
        case 'correct_ticket_email': return { from: `#${f.ticket_id} ${t?.email || '—'}`, to: `#${f.ticket_id} ${f.email.trim()}`, tickets: [f.ticket_id] };
        case 'request_admin': return { from: '—', to: 'An admin is asked to act, with your notes', tickets: [] };
        default: return { from: '—', to: ACTION_LABEL[key] || key, tickets: [] };
    }
}

function TicketSelect({ tickets, value, onChange }) {
    return (
        <TextField select fullWidth size="small" label="Ticket" value={value} onChange={(e) => onChange(e.target.value)} sx={{ mb: 2 }}>
            {tickets.map((t) => <MenuItem key={t.id} value={t.id}>#{t.id} · {t.name}{t.pass ? ` · ${t.pass}` : ''}{t.email ? ` · ${t.email}` : ''}</MenuItem>)}
        </TextField>
    );
}

export function ActionDialog({ eventId, action, problem, booking, onClose, onDone }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const open = Boolean(action);
    const key = action?.key;
    const direct = action?.mode === 'direct';
    const tickets = problem?.evidence?.tickets || [];
    const [f, setF] = useState(() => initialForm(action, problem, booking)); // mounted fresh for every opened action
    const [note, setNote] = useState('');
    const [root, setRoot] = useState('');
    const [phase, setPhase] = useState('form'); // form | confirm | done
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [passes, setPasses] = useState(null);

    useEffect(() => {
        if (open && key === 'change_category' && !passes) ecPassOptions(eventId).then((r) => setPasses(r.data.items || [])).catch((e) => setError(errText(e)));
    }, [open, key, passes, eventId]);

    // Proposal preview (dry run): the server's exact summary and steps, refreshed
    // 500 ms after the form stops changing. Browser wording is the fallback.
    const [pv, setPv] = useState(null); // {loading} | {proposal} | {failed}
    const previewable = open && !direct && !formMissing(key, f);
    const previewBody = previewable ? JSON.stringify(bodyFor(key, f, action)) : '';
    useEffect(() => {
        if (!previewBody) { setPv(null); return undefined; }
        let live = true;
        setPv((x) => ({ ...(x || {}), loading: true }));
        const t = setTimeout(() => {
            ecIssueProposePreview(eventId, problem.id, { action: key, body: JSON.parse(previewBody), reason: note.trim(), root_cause: root || 'unknown' })
                .then((r) => { if (live) setPv({ proposal: r.data.proposal }); })
                .catch((e) => { if (live) setPv({ failed: errText(e) }); });
        }, 500);
        return () => { live = false; clearTimeout(t); };
        // the reason text does not change the steps: no refresh while typing it
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewBody, root, key, eventId, problem?.id]);

    if (!open) return null;
    const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
    const noteOk = direct ? note.trim().length >= 5 : note.trim().length >= 10;
    const missing = formMissing(key, f) || !noteOk || (!direct && !root);
    const change = changeFor(key, f, action, problem, booking, passes);

    const submit = () => {
        setBusy(true); setError('');
        const body = bodyFor(key, f, action);
        const p = direct
            ? ecIssueFix(eventId, problem.id, { action: key, body, note: note.trim() })
            : ecIssuePropose(eventId, problem.id, { action: key, body, reason: note.trim(), root_cause: root });
        p.then((r) => { setResult(r.data); setPhase('done'); onDone && onDone(r.data); })
            .catch((e) => setError(errText(e)))
            .finally(() => setBusy(false));
    };

    const fields = () => {
        switch (key) {
            case 'correct_holder': return <>
                <TicketSelect tickets={tickets} value={f.ticket_id ?? ''} onChange={set('ticket_id')} />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
                    <TextField size="small" fullWidth label="First name" value={f.first_name || ''} onChange={(e) => set('first_name')(e.target.value)} />
                    <TextField size="small" fullWidth label="Last name" value={f.last_name || ''} onChange={(e) => set('last_name')(e.target.value)} />
                </Stack>
                <TextField size="small" fullWidth label="Phone (optional)" value={f.phone || ''} onChange={(e) => set('phone')(e.target.value)} sx={{ mb: 2 }} />
            </>;
            case 'set_delivery_email': return (
                <TextField size="small" fullWidth type="email" label="New delivery email" value={f.email || ''} onChange={(e) => set('email')(e.target.value)} sx={{ mb: 2 }}
                           error={Boolean(f.email) && !EMAIL_OK(f.email)} helperText="Only where the ticket email is sent changes. The ticket and its holder stay the same." />);
            case 'hold': return (
                <Box sx={{ mb: 2 }}>
                    <Typography variant="body2">Tickets to hold:</Typography>
                    {tickets.map((t) => (
                        <FormControlLabel key={t.id} sx={{ display: 'flex' }} label={`#${t.id} · ${t.name}`}
                                          control={<Checkbox checked={(f.ticket_ids || []).includes(t.id)}
                                                             onChange={(e) => set('ticket_ids')(e.target.checked ? [...(f.ticket_ids || []), t.id] : (f.ticket_ids || []).filter((x) => x !== t.id))} />} />
                    ))}
                </Box>);
            case 'issue_seat': return <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
                    <TextField size="small" fullWidth label="First name" value={f.first_name || ''} onChange={(e) => set('first_name')(e.target.value)} />
                    <TextField size="small" fullWidth label="Last name" value={f.last_name || ''} onChange={(e) => set('last_name')(e.target.value)} />
                </Stack>
                <TextField size="small" fullWidth type="email" label="Guest email (optional)" value={f.email || ''} onChange={(e) => set('email')(e.target.value)} sx={{ mb: 2 }}
                           error={Boolean(f.email) && !EMAIL_OK(f.email)} />
                <TextField select size="small" label="How many tickets" value={f.count || 1} onChange={(e) => set('count')(e.target.value)} sx={{ mb: 2, minWidth: 180 }}
                           helperText={`At most ${action.max_count || 1} — the number of paid tickets still missing.`}>
                    {Array.from({ length: Math.max(1, action.max_count || 1) }, (_, i) => i + 1).map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
                </TextField>
            </>;
            case 'decide_duplicate': return (
                <RadioGroup value={f.real_seat || ''} onChange={(e) => set('real_seat')(e.target.value)} sx={{ mb: 2 }}>
                    <FormControlLabel value="real" control={<Radio />} label="Real extra seat — the customer meant to buy another ticket" />
                    <FormControlLabel value="double" control={<Radio />} label="Double charge — refund it in GHL (nothing is refunded from here)" />
                </RadioGroup>);
            case 'change_category': return <>
                <TicketSelect tickets={tickets} value={f.ticket_id ?? ''} onChange={set('ticket_id')} />
                <TextField select fullWidth size="small" label="Correct pass" value={f.ticket_type_id ?? ''} onChange={(e) => set('ticket_type_id')(e.target.value)} sx={{ mb: 2 }}
                           helperText="The QR code stays the same; only the access changes.">
                    {!passes && <MenuItem disabled value="">Loading…</MenuItem>}
                    {(passes || []).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
                </TextField>
            </>;
            case 'correct_ticket_email': return <>
                <TicketSelect tickets={tickets} value={f.ticket_id ?? ''} onChange={set('ticket_id')} />
                <TextField size="small" fullWidth type="email" label="New ticket email" value={f.email || ''} onChange={(e) => set('email')(e.target.value)} sx={{ mb: 2 }}
                           error={Boolean(f.email) && !EMAIL_OK(f.email)} helperText="Changes who the ticket belongs to (its email), not only where it is sent." />
            </>;
            default: return NO_FIELDS.has(key) && (key === 'release' || key === 'release_contact')
                ? <Typography variant="body2" sx={{ mb: 2 }}>Tickets: {ids(action.ticket_ids)}</Typography> : null;
        }
    };

    const proposal = result?.proposal;
    return (
        <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={narrow} scroll="paper">
            <DialogTitle>
                {action.label}
                <Typography variant="body2" color="text.secondary">
                    {direct ? 'You can apply this now.' : 'This is a proposal: another admin approves it before anything changes.'}
                </Typography>
            </DialogTitle>
            <DialogContent dividers>
                {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
                {phase === 'form' && <>
                    {action.explain && <Alert severity="info" icon={false} sx={{ mb: 2 }}>{action.explain}</Alert>}
                    {fields()}
                    {!direct && (
                        <TextField select fullWidth size="small" label="Root cause (required)" value={root} onChange={(e) => setRoot(e.target.value)} sx={{ mb: 2 }}>
                            {ROOT_CAUSES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
                        </TextField>
                    )}
                    <TextField fullWidth multiline minRows={2} value={note} onChange={(e) => setNote(e.target.value)}
                               label={direct ? 'What you checked (required)' : 'Reason: what is wrong and what supports the correction (required)'}
                               helperText={direct ? 'At least 5 characters.' : 'At least a sentence (10 characters).'} />
                    {!direct && !formMissing(key, f) && (
                        <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                            <Stack direction="row" spacing={1} alignItems="center">
                                <Typography variant="subtitle2">This will:</Typography>
                                {pv?.loading && <CircularProgress size={14} />}
                            </Stack>
                            {pv?.proposal ? <>
                                {pv.proposal.summary && <Typography variant="body2" fontWeight={600}>{pv.proposal.summary}</Typography>}
                                {(pv.proposal.steps || []).map((s, i) => <Typography key={i} variant="body2">• {stepText(s)}</Typography>)}
                                <ChangeLine from={valueText(pv.proposal.current_value)} to={valueText(pv.proposal.proposed_value)} />
                                <Typography variant="caption" color="text.secondary">Exact steps from the server. Nothing is saved until you propose. Nothing is emailed.</Typography>
                            </> : <>
                                <Typography variant="body2">• {stepText({ action: key, body: bodyFor(key, f, action) })}</Typography>
                                <ChangeLine from={change.from} to={change.to} />
                                <Typography variant="caption" color="text.secondary">
                                    {pv?.failed ? `Could not get the server's preview (${pv.failed}). ` : ''}
                                    The server may add steps that belong to the same correction; they are shown after you propose. Nothing is emailed.
                                </Typography>
                            </>}
                        </Paper>
                    )}
                </>}
                {phase === 'confirm' && <>
                    <Typography variant="subtitle2">Check the change before applying it</Typography>
                    <ChangeLine from={change.from} to={change.to} />
                    <Typography variant="body2"><b>Tickets affected:</b> {change.tickets?.length ? ids(change.tickets) : 'none directly'}</Typography>
                    <Typography variant="body2"><b>Your note:</b> {note.trim()}</Typography>
                    <Alert severity="info" sx={{ mt: 2 }}>Nothing is emailed. The order is re-checked straight after.</Alert>
                </>}
                {phase === 'done' && direct && <>
                    <Alert severity="success" sx={{ mb: 1 }}>Correction applied.</Alert>
                    <ValidationResult v={result?.validation} issueId={problem.id} />
                </>}
                {phase === 'done' && !direct && proposal && <>
                    <Alert severity="success" sx={{ mb: 1 }}>Proposed. It now waits in Approvals for another admin.</Alert>
                    <Typography variant="body2" sx={{ mb: 1 }}><b>{proposal.summary}</b></Typography>
                    <ChangeLine from={valueText(proposal.current_value)} to={valueText(proposal.proposed_value)} />
                    <Typography variant="subtitle2">This will:</Typography>
                    {(proposal.steps || []).map((s, i) => <Typography key={i} variant="body2">• {stepText(s)}</Typography>)}
                </>}
            </DialogContent>
            <DialogActions>
                {phase === 'done' ? <Button variant="contained" onClick={onClose}>Close</Button> : <>
                    <Button disabled={busy} onClick={phase === 'confirm' ? () => setPhase('form') : onClose}>{phase === 'confirm' ? 'Back' : 'Cancel'}</Button>
                    {direct && phase === 'form' && <Button variant="contained" disabled={missing} onClick={() => setPhase('confirm')}>Review the change</Button>}
                    {direct && phase === 'confirm' && <Button variant="contained" color="warning" disabled={busy} onClick={submit}>{busy ? 'Applying…' : 'Apply correction'}</Button>}
                    {!direct && <Button variant="contained" disabled={missing || busy} onClick={submit}>{busy ? 'Proposing…' : 'Propose for approval'}</Button>}
                </>}
            </DialogActions>
        </Dialog>
    );
}

// ── One problem ─────────────────────────────────────────────────────────────
function Answer({ q, children }) {
    if (!children) return null;
    return (
        <Box sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{q}</Typography>
            <Typography variant="body2" component="div">{children}</Typography>
        </Box>
    );
}

function ProblemCard({ eventId, p, me, onChanged, onAction }) {
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');
    const [showHistory, setShowHistory] = useState(false);
    const ev = p.evidence;
    const sentence = evidenceSentence(ev);
    const addNote = () => {
        setBusy(true); setError('');
        ecIssueComment(eventId, p.id, note.trim()).then(() => { setNote(''); setMsg('Note added.'); onChanged(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const waiting = (p.proposals || []).filter((x) => x.state === 'proposed');
    const body = (
        <Box>
            {error && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>{error}</Alert>}
            {msg && <Alert severity="success" sx={{ mb: 1 }} onClose={() => setMsg('')}>{msg}</Alert>}
            {sentence && <Alert severity={ev?.paid_for !== ev?.issued || ev?.possible_double_charges ? 'error' : 'info'} icon={false} sx={{ mb: 1 }}>
                <Typography variant="body1" fontWeight={600}>{sentence}</Typography></Alert>}
            <StageStepper stage={p.stage} />
            <Answer q="What is wrong">{p.what_is_wrong}</Answer>
            <Answer q="Why it was flagged">{p.why_flagged}</Answer>
            <Answer q="Correct result">{p.correct_result}</Answer>
            <Answer q="What you can do">{p.recommended}{p.advice && p.advice !== p.recommended ? <Typography variant="body2" color="text.secondary">{p.advice}</Typography> : null}</Answer>
            <Accordion disableGutters variant="outlined" sx={{ mb: 1 }} defaultExpanded={Boolean(sentence)}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography variant="subtitle2">Evidence — payments and tickets</Typography></AccordionSummary>
                <AccordionDetails><EvidenceTables ev={ev} /></AccordionDetails>
            </Accordion>

            {p.detected && (
                <Box sx={{ mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Actions</Typography>
                    {me?.review ? (
                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                            {(p.actions || []).map((a) => (
                                <Tooltip key={a.key} title={a.explain || ''} describeChild>
                                    <Button size="small" variant={a.mode === 'direct' ? 'contained' : 'outlined'} color={a.mode === 'direct' ? 'primary' : 'secondary'}
                                            onClick={() => onAction(a)}>
                                        {a.label}{a.mode === 'propose' ? ' (needs approval)' : ''}
                                    </Button>
                                </Tooltip>
                            ))}
                            {!p.actions?.length && <Typography variant="body2" color="text.secondary">No correction is available here for this problem.</Typography>}
                        </Stack>
                    ) : <Typography variant="body2" color="text.secondary">Your role can read this problem but not correct it.</Typography>}
                    {waiting.length > 0 && <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                        {waiting.length} correction{waiting.length === 1 ? ' is' : 's are'} already waiting for approval.</Typography>}
                </Box>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1 }}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                    <b>Assigned:</b> {p.assigned_name ? `${p.assigned_name}${p.assigned_to === me?.user_id ? ' (you)' : ''}` : 'nobody'}
                    {p.updated_at ? <Typography component="span" variant="caption" color="text.secondary"> · updated {gst(p.updated_at)}</Typography> : null}
                </Typography>
                {me?.review && <Stack direction="row" spacing={1}>
                    <AssignControls eventId={eventId} issueId={p.id} assignedTo={p.assigned_to} myId={me?.user_id}
                                    onDone={() => { setMsg('Assignment saved.'); onChanged(); }} onError={setError} />
                </Stack>}
            </Stack>
            {me?.review && (
                <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="flex-start">
                    <TextField size="small" fullWidth multiline maxRows={4} label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} />
                    <Button variant="outlined" disabled={busy || note.trim().length < 2} onClick={addNote}>Save</Button>
                </Stack>
            )}

            {(p.proposals || []).length > 0 && (
                <Box sx={{ mb: 1 }}>
                    <Typography variant="subtitle2">Proposed corrections</Typography>
                    {p.proposals.map((x) => (
                        <Paper key={x.id} variant="outlined" sx={{ p: 1, mt: 0.5 }}>
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                                <ProposalChip s={x.state} />
                                <Typography variant="body2" sx={{ flex: 1, minWidth: 200 }}>#{x.id} · {x.summary}</Typography>
                            </Stack>
                            <Typography variant="caption" color="text.secondary">
                                Proposed by {x.proposed_by} · {gst(x.proposed_at)}
                                {x.decided_by ? ` · decided by ${x.decided_by} · ${gst(x.decided_at)}` : ''}{x.decision_note ? ` — “${x.decision_note}”` : ''}
                            </Typography>
                        </Paper>
                    ))}
                </Box>
            )}

            <Button size="small" onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide history' : `Show history (${(p.history || []).length})`}</Button>
            {showHistory && (
                <Box sx={{ mt: 0.5, pl: 1, borderLeft: 2, borderColor: 'divider' }}>
                    {(p.history || []).map((h, i) => (
                        <Typography key={i} variant="body2" sx={{ py: 0.25 }}>
                            <Typography component="span" variant="caption" color="text.secondary">{gst(h.at)}</Typography>{' '}
                            <b>{h.actor || 'system'}</b> {h.text || String(h.kind || '').replace(/_/g, ' ')}
                        </Typography>
                    ))}
                    {!p.history?.length && <Typography variant="body2" color="text.secondary">No history yet.</Typography>}
                </Box>
            )}

        </Box>
    );

    if (!p.detected) {
        return (
            <Accordion disableGutters variant="outlined" sx={{ borderColor: 'success.main', bgcolor: 'rgba(46,125,50,0.06)' }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                        <Chip size="small" color="success" label="Fixed — confirmed by re-check" />
                        <Typography variant="body2">{p.kind_label} · {p.what_is_wrong}</Typography>
                    </Stack>
                </AccordionSummary>
                <AccordionDetails>{body}</AccordionDetails>
            </Accordion>
        );
    }
    return (
        <Paper variant="outlined" sx={{ p: 1.5, borderColor: p.priority === 'critical' ? 'error.main' : p.priority === 'high' ? 'warning.main' : 'divider' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                <SeverityChip s={p.priority} />
                <Chip size="small" variant="outlined" label={p.kind_label || p.kind} />
                <Chip size="small" variant="outlined" label={String(p.status || '').replace(/_/g, ' ')} />
                <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1, minWidth: 200 }}>{p.what_is_wrong}</Typography>
            </Stack>
            {body}
        </Paper>
    );
}

/**
 * "Problems & fixes": data comes from the Review panel (GET /bookings/{key}/problems)
 * so the workflow bar and this section stay in step. `onChanged` reloads problems,
 * the booking detail and the list row.
 */
export const ProblemsSection = React.forwardRef(function ProblemsSection(
    { eventId, data, loading, error, me, booking, onChanged, onRecheck, recheck, rechecking }, ref) {
    const [ask, setAsk] = useState(null); // {action, problem, booking} snapshot: survives the reload after a fix
    const problems = data?.problems || [];
    const open = problems.filter((p) => p.detected);
    const fixed = problems.filter((p) => !p.detected);
    return (
        <Paper ref={ref} variant="outlined" sx={{ p: 1.5, mb: 2, scrollMarginTop: 8 }}>
            <Stack direction="row" alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                    Problems &amp; fixes{data ? ` — ${open.length} open${fixed.length ? `, ${fixed.length} fixed` : ''}` : ''}
                </Typography>
                {me?.review && <Button size="small" variant="outlined" disabled={rechecking} onClick={onRecheck}>{rechecking ? 'Re-checking…' : 'Re-check now'}</Button>}
            </Stack>
            {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
            {loading && !data && <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={20} /></Box>}
            {recheck && (
                <Box sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">Re-check finished {gst(recheck.at)}</Typography>
                    <ValidationResult v={recheck.v} />
                </Box>
            )}
            {data && !problems.length && <Alert severity="success">The checks found no problem on this order.</Alert>}
            <Stack spacing={1.5}>
                {[...open, ...fixed].map((p) => <ProblemCard key={p.id} eventId={eventId} p={p} me={me} onChanged={onChanged}
                                                              onAction={(a) => setAsk({ action: a, problem: p, booking })} />)}
            </Stack>
            {data && open.length > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Problems close themselves when the re-check no longer finds them — there is no "mark resolved" for ticket problems.
                </Typography>
            )}
            {ask && <ActionDialog eventId={eventId} action={ask.action} problem={ask.problem} booking={ask.booking} onClose={() => setAsk(null)} onDone={onChanged} />}
        </Paper>
    );
});
