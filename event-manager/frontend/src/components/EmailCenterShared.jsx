import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    FormControlLabel, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow,
    TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import { ecBatch, ecBatchAction, ecBatchPreview, ecBatchStart } from '../utils/api';

/**
 * Pieces every Email Center tab shares: time in Dubai, status chips with one
 * colour scheme, the email preview frame, the batch confirmation screen and the
 * live batch progress card.
 */

// ── Time ────────────────────────────────────────────────────────────────────
const GST = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
});
/** UTC ISO string from the API -> "10 Nov 2026, 14:05 GST". */
export const gst = (iso) => {
    if (!iso) return '—';
    const s = String(iso);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? s : `${GST.format(d)} GST`;
};

// ── Errors ──────────────────────────────────────────────────────────────────
export const errText = (e) => {
    const d = e?.response?.data?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map((x) => x?.msg || JSON.stringify(x)).join('; ');
    return e?.message || 'Something went wrong';
};
export const is409 = (e) => e?.response?.status === 409;

export const downloadBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const copyText = (text, onDone) => {
    const fallback = () => { window.prompt('Copy this link:', text); onDone && onDone(); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => onDone && onDone(), fallback);
    else fallback();
};

export const money = (n, c) => (n == null || n === '' ? '—' : `${c && c !== 'USD' ? c + ' ' : '$'}${Number(n).toFixed(2)}`);

// ── Status chips ────────────────────────────────────────────────────────────
export const DELIVERY = {
    not_sent: ['Not sent', 'default'],
    partially_sent: ['Partly sent', 'warning'],
    sent_manually: ['Sent manually', 'info'],
    accepted: ['Accepted', 'info'],
    delivered: ['Delivered', 'success'],
    opened: ['Opened', 'success'],
    clicked: ['Clicked', 'success'],
    failed: ['Failed', 'error'],
    rejected: ['Failed', 'error'],
    bounced: ['Bounced', 'error'],
    unknown: ['Unknown', 'warning'],
    sending: ['Sending…', 'warning'],
    sent: ['Sent', 'info'],
    held: ['Held', 'warning'],
    refused: ['Refused', 'warning'],
    skipped: ['Skipped', 'default'],
};
export function DeliveryChip({ s, variant }) {
    const [label, color] = DELIVERY[s] || [s ? String(s).replace(/_/g, ' ') : '—', 'default'];
    return <Chip size="small" label={label} color={color} variant={variant} />;
}

export const REVIEW = {
    pending_review: ['Pending review', 'default'],
    verified: ['Verified', 'info'],
    approved: ['Approved', 'success'],
    held: ['Held', 'warning'],
    needs_correction: ['Needs correction', 'warning'],
};
export function ReviewChip({ s }) {
    const [label, color] = REVIEW[s] || [s || '—', 'default'];
    return <Chip size="small" label={label} color={color} />;
}

export const SEVERITY = { critical: ['Critical', 'error'], high: ['High', 'warning'], medium: ['Medium', 'info'], low: ['Low', 'default'] };
export function SeverityChip({ s }) {
    const [label, color] = SEVERITY[s] || [s, 'default'];
    return <Chip size="small" label={label} color={color} />;
}

export const PAYMENT = {
    paid: ['Paid', 'success'], refunded: ['Refunded', 'error'], check: ['Check', 'warning'], no_payment_record: ['No payment record', 'warning'],
};
export const RECON = {
    clear: ['Clear', 'success'], warning: ['Warning', 'warning'], open_case: ['Open case', 'error'], held: ['Held', 'warning'],
};
export function MapChip({ map, s }) {
    const [label, color] = map[s] || [s ? String(s).replace(/_/g, ' ') : '—', 'default'];
    return <Chip size="small" variant="outlined" label={label} color={color} />;
}

/** Plain words for the reasons the server refuses an exhibitor email. */
export const REFUSED = {
    missing_contact_email: 'This stand has no valid contact email. Add one with Edit contact first.',
    scanning_not_enabled: 'Scanning is not switched on for this stand. Switch scanning on in Exhibitors first.',
    no_ghl_contact: 'No matching contact in GHL — copy the link and send it yourself, then mark it sent.',
    several_ghl_contacts: 'More than one GHL contact has this email, so the system will not guess. Copy the link and send it yourself, then mark it sent.',
    contact_do_not_disturb: 'This contact has Do Not Disturb set in GHL, so email is blocked. Contact them another way.',
    profile_already_set_up: 'This stand has already set up its profile; the setup email is no longer needed.',
};

// ── Send-gated button ───────────────────────────────────────────────────────
/** A button that is disabled with a reason shown on hover (MUI needs a span). */
export function GatedButton({ reason, children, ...props }) {
    if (!reason) return <Button {...props}>{children}</Button>;
    return (
        <Tooltip title={reason}>
            <span style={{ display: 'inline-flex' }}><Button {...props} disabled>{children}</Button></span>
        </Tooltip>
    );
}
/** Why a send control must be disabled right now, or '' when it may be used. */
export const sendBlock = (me) => {
    if (!me?.send) return 'Your role cannot send emails.';
    if (!me?.sending?.enabled) return me?.sending?.reason || 'Sending is switched off.';
    return '';
};

// ── Email preview ───────────────────────────────────────────────────────────
export function EmailFrame({ html, title }) {
    const [width, setWidth] = useState(390);
    return (
        <Box>
            <ToggleButtonGroup size="small" exclusive value={width} onChange={(_, v) => v && setWidth(v)} sx={{ mb: 1 }}>
                <ToggleButton value={390}>Phone</ToggleButton>
                <ToggleButton value={640}>Desktop</ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ overflowX: 'auto' }}>
                <Box component="iframe" title={title || 'Email preview'} srcDoc={html || ''} sandbox=""
                     sx={{ width, maxWidth: 'none', height: 640, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: '#fff', display: 'block' }} />
            </Box>
        </Box>
    );
}

// ── Note dialog (flag, hold, resend reason, mark sent, settle) ──────────────
/**
 * fields: optional [{key, label, options:[[value,label]]}] selects shown above the note.
 */
export function NoteDialog({ open, title, help, noteLabel = 'Note', required = true, fields = [], confirmLabel = 'Save',
                             confirmColor = 'primary', busy, onClose, onConfirm }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [note, setNote] = useState('');
    const [vals, setVals] = useState({});
    useEffect(() => { if (open) { setNote(''); setVals({}); } }, [open]);
    const missing = (required && !note.trim()) || fields.some((f) => !vals[f.key]);
    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={narrow}>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent dividers>
                {help && <Typography variant="body2" sx={{ mb: 2 }}>{help}</Typography>}
                {fields.map((f) => (
                    <TextField key={f.key} select fullWidth size="small" label={f.label} sx={{ mb: 2 }}
                               value={vals[f.key] || ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}>
                        {f.options.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
                    </TextField>
                ))}
                <TextField autoFocus fullWidth multiline minRows={2} label={noteLabel + (required ? ' (required)' : '')}
                           value={note} onChange={(e) => setNote(e.target.value)} />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" color={confirmColor} disabled={busy || missing}
                        onClick={() => onConfirm({ note: note.trim(), ...vals })}>{busy ? 'Working…' : confirmLabel}</Button>
            </DialogActions>
        </Dialog>
    );
}

// ── Batch confirmation ──────────────────────────────────────────────────────
function Count({ label, value }) {
    return (
        <Paper variant="outlined" sx={{ p: 1.25, minWidth: 100, flex: '1 1 100px' }}>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            <Typography variant="h5">{value ?? '—'}</Typography>
        </Paper>
    );
}

/**
 * Preview → check numbers → start. `selector` is the body sent to both
 * /batches/preview and /batches; `title` describes what is being sent.
 */
export function BatchConfirmDialog({ eventId, selector, title, me, onClose, onStarted }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [plan, setPlan] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [changed, setChanged] = useState('');
    const [checked, setChecked] = useState(false);
    const [busy, setBusy] = useState(false);
    const open = Boolean(selector);

    const preview = useCallback(() => {
        if (!selector) return;
        setLoading(true); setError(''); setChecked(false);
        ecBatchPreview(eventId, selector)
            .then((r) => setPlan(r.data))
            .catch((e) => setError(errText(e)))
            .finally(() => setLoading(false));
    }, [eventId, selector]);
    useEffect(() => { setPlan(null); setChanged(''); preview(); }, [preview]);

    const start = () => {
        setBusy(true); setError('');
        ecBatchStart(eventId, { ...selector, confirm_token: plan.confirm_token })
            .then((r) => onStarted(r.data.batch_id))
            .catch((e) => {
                if (is409(e)) { setChanged(errText(e)); preview(); } else setError(errText(e));
            })
            .finally(() => setBusy(false));
    };

    const exhibitor = Boolean(selector?.exhibitor_kind);
    const block = sendBlock({ ...me, sending: plan?.sending || me?.sending });
    const n = plan?.emails || 0;
    const template = plan && (typeof plan.template === 'string' ? { name: plan.template } : plan.template || {});

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={narrow}>
            <DialogTitle>{title || 'Confirm sending'}</DialogTitle>
            <DialogContent dividers>
                {changed && <Alert severity="warning" sx={{ mb: 2 }}>{changed} The numbers below are the new list.</Alert>}
                {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
                {loading && !plan && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
                {plan && <>
                    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }}>
                        {!exhibitor && <Count label="Orders" value={plan.orders} />}
                        <Count label="Emails" value={plan.emails} />
                        {!exhibitor && <Count label="Tickets" value={plan.tickets} />}
                        {!exhibitor && <Count label="Recipients" value={plan.recipients} />}
                        <Count label="Excluded" value={plan.excluded?.length || 0} />
                    </Stack>
                    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                        <Typography variant="body2"><b>Template:</b> {template?.name || '—'}{template?.sha ? ` · version ${template.sha}` : ''}</Typography>
                        <Typography variant="body2"><b>Sent by:</b> {plan.sender || me?.user || '—'}</Typography>
                        {plan.mode && <Typography variant="body2"><b>Kind:</b> {plan.mode === 'retry' ? 'Retry of failed emails' : 'First send'}</Typography>}
                    </Paper>
                    {block && <Alert severity="error" sx={{ mb: 2 }}><b>Sending is not possible right now.</b> {block}</Alert>}
                    {plan.sending?.fake_gateway && <Alert severity="info" sx={{ mb: 2 }}>Test mode — emails go to a simulated mailbox; nothing reaches anyone.</Alert>}
                    {plan.warnings?.length > 0 && (
                        <Alert severity="warning" sx={{ mb: 2 }}>
                            <b>Warnings ({plan.warnings.length})</b>
                            {plan.warnings.slice(0, 30).map((w, i) => <div key={i}>• {w.key}: {w.detail}</div>)}
                            {plan.warnings.length > 30 && <div>…and {plan.warnings.length - 30} more</div>}
                        </Alert>
                    )}
                    <Typography variant="subtitle2">Will be sent ({plan.items?.length || 0})</Typography>
                    <Box sx={{ maxHeight: 260, overflow: 'auto', mb: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                {exhibitor ? <><TableCell>Booth</TableCell><TableCell>Company</TableCell></>
                                    : <><TableCell>Order</TableCell><TableCell>Purchaser</TableCell><TableCell align="right">Emails</TableCell></>}
                            </TableRow></TableHead>
                            <TableBody>
                                {(plan.items || []).map((it) => (exhibitor
                                    ? <TableRow key={it.id}><TableCell>{it.booth || '—'}</TableCell><TableCell>{it.company}</TableCell></TableRow>
                                    : <TableRow key={it.key}><TableCell>{it.order_number || it.key}</TableCell><TableCell>{it.purchaser}</TableCell><TableCell align="right">{it.emails}</TableCell></TableRow>))}
                                {!plan.items?.length && <TableRow><TableCell colSpan={3}>Nothing in this selection can be sent.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    </Box>
                    {plan.excluded?.length > 0 && <>
                        <Typography variant="subtitle2">Left out, and why ({plan.excluded.length})</Typography>
                        <Box sx={{ maxHeight: 220, overflow: 'auto', mb: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow><TableCell>{exhibitor ? 'Company' : 'Order'}</TableCell>{!exhibitor && <TableCell>Purchaser</TableCell>}<TableCell>Reason</TableCell></TableRow></TableHead>
                                <TableBody>
                                    {plan.excluded.map((x, i) => (
                                        <TableRow key={i}>
                                            <TableCell>{exhibitor ? (x.company || `#${x.id}`) : (x.order_number || x.key)}</TableCell>
                                            {!exhibitor && <TableCell>{x.purchaser || '—'}</TableCell>}
                                            <TableCell>{x.reason}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </Box>
                    </>}
                    <FormControlLabel control={<Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />}
                                      label="I have checked these numbers" />
                </>}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" disabled={!plan || !checked || !n || busy || loading || Boolean(block)} onClick={start}>
                    {busy ? 'Starting…' : `Send ${n} email${n === 1 ? '' : 's'}`}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

// ── Batch progress ──────────────────────────────────────────────────────────
const BATCH_STATE = {
    queued: ['Queued', 'default'], running: ['Running', 'info'], paused: ['Paused', 'warning'], done: ['Done', 'success'],
    cancelled: ['Cancelled', 'default'], interrupted: ['Interrupted', 'error'],
};
const ACTIVE = new Set(['queued', 'running']);
const DONE_ITEM = new Set(['sent', 'held', 'skipped', 'failed', 'unknown', 'error', 'refused', 'cancelled', 'interrupted', 'accepted', 'rejected']);

/** One batch, polled every 3 s while it is running. `batch` seeds it; `id` alone also works. */
export function BatchCard({ eventId, batch, id, me, onFinished }) {
    const [b, setB] = useState(batch || null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const bid = batch?.id || id;

    const load = useCallback(() => ecBatch(eventId, bid).then((r) => setB(r.data)).catch((e) => setError(errText(e))), [eventId, bid]);
    useEffect(() => { if (!batch) load(); }, [batch, load]);
    useEffect(() => { if (batch) setB(batch); }, [batch]);
    const state = b?.state;
    useEffect(() => {
        if (!ACTIVE.has(state)) return undefined;
        const t = setInterval(load, 3000);
        return () => clearInterval(t);
    }, [state, load]);
    const seen = useRef(state);
    useEffect(() => {
        if (seen.current && ACTIVE.has(seen.current) && state && !ACTIVE.has(state) && onFinished) onFinished();
        seen.current = state;
    }, [state, onFinished]);

    const act = (action) => {
        setBusy(true); setError('');
        ecBatchAction(eventId, bid, action).then(load).catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    if (!b) return error ? <Alert severity="error">{error}</Alert> : null;
    const tally = b.tally || {};
    const sent = tally.sent || 0;
    const finished = Object.entries(tally).filter(([k]) => DONE_ITEM.has(k)).reduce((a, [, v]) => a + v, 0);
    const pct = b.total ? Math.round((finished / b.total) * 100) : 0;
    const [label, color] = BATCH_STATE[b.state] || [b.state, 'default'];
    const kind = String(b.kind || '').startsWith('exhibitor:') ? `Exhibitor ${b.kind.split(':')[1]} emails`
        : b.kind === 'retry' ? 'Retry of failed ticket emails' : 'Ticket emails';
    return (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                <Typography variant="subtitle2">Run #{b.id} · {kind}</Typography>
                <Chip size="small" label={label} color={color} />
                <Typography variant="caption" color="text.secondary">by {b.created_by} · {gst(b.created_at)}</Typography>
            </Stack>
            <LinearProgress variant="determinate" value={pct} sx={{ height: 8, borderRadius: 4, mb: 0.5 }} />
            <Typography variant="body2">
                Sent {sent} / {b.total} · {Object.entries(tally).filter(([k, v]) => v && k !== 'sent').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}
            </Typography>
            {b.note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{b.note}</Typography>}
            {error && <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError('')}>{error}</Alert>}
            {me?.send && (
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                    {ACTIVE.has(b.state) && <Button size="small" variant="outlined" disabled={busy} onClick={() => act('pause')}>Pause</Button>}
                    {['paused', 'interrupted'].includes(b.state) && (
                        <GatedButton size="small" variant="contained" reason={me?.sending?.enabled ? '' : (me?.sending?.reason || 'Sending is switched off.')}
                                     disabled={busy} onClick={() => act('resume')}>Resume</GatedButton>)}
                    {['queued', 'running', 'paused'].includes(b.state) && <Button size="small" color="error" disabled={busy} onClick={() => act('cancel')}>Cancel</Button>}
                </Stack>
            )}
        </Paper>
    );
}
