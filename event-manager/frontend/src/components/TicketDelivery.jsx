import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell, Chip, Stack, TextField,
    Button, Alert, CircularProgress, Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton,
    ToggleButtonGroup, Divider,
} from '@mui/material';
import {
    getTicketDeliverySummary, getTicketDeliveryOrders, getTicketDeliveryOrder, resendTicketEmail,
    pauseTicketDelivery, resumeTicketDelivery,
} from '../utils/api';

/**
 * Ticket Emails — the official ticket email, order by order.
 *
 * "Accepted" (GHL took the message) and "delivered" (the mail provider says it
 * arrived) are different facts and are shown separately. Held orders show the
 * reason they were not sent. Sending itself is a server job; this screen can
 * pause it at once, resume it, and queue a resend with a reason. Turning live
 * automatic sending ON is deliberately not possible from here.
 */

const BUCKETS = [
    ['', 'All'],
    ['delivered', 'Delivered'],
    ['pending', 'Sent, awaiting status'],
    ['bounced', 'Bounced'],
    ['failed', 'Failed'],
    ['review', 'Needs review'],
    ['awaiting_delivery', 'New, awaiting delivery'],
];
const BUCKET_CHIP = {
    delivered: ['Delivered', 'success'], pending: ['Sent', 'info'], bounced: ['Bounced', 'error'], failed: ['Failed', 'error'],
    review: ['Held', 'warning'], awaiting_delivery: ['Ready (not sent)', 'default'], other: ['—', 'default'],
};
const MODE = {
    shadow: ['Shadow mode: checking new orders, sending nothing automatically', 'info'],
    live: ['Automatic sending is ON', 'success'],
    paused: ['PAUSED: nothing is being sent', 'error'],
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const words = (r) => String(r || '').split(';').filter(Boolean).map((x) => x.replace(/_/g, ' ')).join(', ');
const err = (e) => e?.response?.data?.detail || e?.message || 'Something went wrong';

export default function TicketDelivery() {
    const { id } = useParams();
    const [summary, setSummary] = useState(null);
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [bucket, setBucket] = useState('');
    const [q, setQ] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [detail, setDetail] = useState(null);
    const [ask, setAsk] = useState(null); // { kind: 'pause'|'resume'|'resend', order }
    const [reason, setReason] = useState('');
    const [notice, setNotice] = useState('');

    const load = useCallback(() => {
        setLoading(true);
        Promise.all([getTicketDeliverySummary(id), getTicketDeliveryOrders(id, { q, bucket })])
            .then(([s, o]) => { setSummary(s.data); setRows(o.data.rows); setTotal(o.data.total); setError(''); })
            .catch((e) => setError(err(e)))
            .finally(() => setLoading(false));
    }, [id, q, bucket]);

    useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
    useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

    const open = (orderId) => getTicketDeliveryOrder(id, orderId).then((r) => setDetail(r.data)).catch((e) => setError(err(e)));

    const confirm = () => {
        const job = ask.kind === 'pause' ? pauseTicketDelivery(id, reason)
            : ask.kind === 'resume' ? resumeTicketDelivery(id, reason)
                : resendTicketEmail(id, ask.order, reason);
        job.then((r) => {
            setNotice(ask.kind === 'resend' ? `Resend queued. ${r.data.note || ''}` : `Mode is now: ${r.data.mode}`);
            setAsk(null); setReason(''); load();
            if (detail && ask.kind === 'resend') open(ask.order);
        }).catch((e) => setError(err(e)));
    };

    const mode = summary?.mode;
    const c = summary?.counts || {};
    return (
        <Box>
            {summary && (
                <Alert severity={MODE[mode]?.[1] || 'info'} sx={{ mb: 2 }}
                       action={mode === 'paused'
                           ? <Button color="inherit" onClick={() => setAsk({ kind: 'resume' })}>Resume</Button>
                           : <Button color="error" variant="contained" onClick={() => setAsk({ kind: 'pause' })}>Pause all sending</Button>}>
                    <b>{MODE[mode]?.[0] || mode}</b>
                    <Typography variant="body2">
                        Last check: {when(summary.last_run?.at)}
                        {summary.last_run && ` · ${summary.last_run.checked} new orders checked, ${summary.last_run.sent} sent, ${summary.last_run.shadow_would_send} would send`}
                        {summary.pending_resends ? ` · ${summary.pending_resends} resend(s) waiting` : ''}
                    </Typography>
                    {summary.last_run?.shadow_only_lock && (
                        <Typography variant="body2">Server shadow lock is on: no customer email can leave the automatic sender until go-live is approved.</Typography>
                    )}
                </Alert>
            )}
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>{error}</Alert>}
            {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2 }}>{notice}</Alert>}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                {[['delivered', 'Delivered'], ['pending', 'Sent'], ['bounced', 'Bounced'], ['failed', 'Failed'], ['review', 'Needs review'], ['awaiting_delivery', 'New, not sent']]
                    .map(([k, l]) => <Chip key={k} label={`${l}: ${c[k] || 0}`} color={BUCKET_CHIP[k][1]} variant={bucket === k ? 'filled' : 'outlined'}
                                           onClick={() => setBucket(bucket === k ? '' : k)} />)}
            </Stack>

            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
                    <TextField size="small" label="Search name, email, order or ticket #" value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 300 }} />
                    <ToggleButtonGroup size="small" exclusive value={bucket} onChange={(e, v) => setBucket(v ?? '')} sx={{ flexWrap: 'wrap' }}>
                        {BUCKETS.map(([k, l]) => <ToggleButton key={k || 'all'} value={k}>{l}</ToggleButton>)}
                    </ToggleButtonGroup>
                    {loading && <CircularProgress size={20} />}
                </Stack>
            </Paper>

            <Paper sx={{ overflowX: 'auto' }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>Status</TableCell><TableCell>Buyer</TableCell><TableCell>Email</TableCell>
                            <TableCell>Ticket</TableCell><TableCell>Order</TableCell><TableCell>Updated</TableCell><TableCell>Why held</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((r) => (
                            <TableRow key={r.order_id} hover onClick={() => open(r.order_id)} sx={{ cursor: 'pointer' }}>
                                <TableCell><Chip size="small" label={BUCKET_CHIP[r.bucket]?.[0]} color={BUCKET_CHIP[r.bucket]?.[1]} /></TableCell>
                                <TableCell>{r.buyer_name || '—'}</TableCell>
                                <TableCell>{r.recipient || '—'}</TableCell>
                                <TableCell>{(r.tickets || []).map((t) => `#${t.id} ${t.pass}`).join(', ') || '—'}</TableCell>
                                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.order_id}</TableCell>
                                <TableCell>{when(r.updated_at || r.last_checked)}</TableCell>
                                <TableCell sx={{ maxWidth: 320 }}>{words(r.reasons)}</TableCell>
                            </TableRow>
                        ))}
                        {!rows.length && !loading && <TableRow><TableCell colSpan={7}>Nothing here.</TableCell></TableRow>}
                    </TableBody>
                </Table>
                <Typography variant="caption" sx={{ p: 1, display: 'block' }}>{total} order(s)</Typography>
            </Paper>

            <Dialog open={!!detail} onClose={() => setDetail(null)} maxWidth="md" fullWidth>
                {detail && <>
                    <DialogTitle>Order {detail.order?.order_id || ''}</DialogTitle>
                    <DialogContent dividers>
                        <Typography><b>{detail.order?.buyer_name}</b> · {detail.order?.recipient}</Typography>
                        {(detail.order?.tickets || []).map((t) => <Typography key={t.id} variant="body2">Ticket #{t.id}: {t.name || 'guest'} · {t.pass}{t.active ? '' : ' · NOT ACTIVE'}</Typography>)}
                        {detail.order?.reasons && <Alert severity="warning" sx={{ mt: 1 }}>Held: {words(detail.order.reasons)}</Alert>}
                        <Divider sx={{ my: 2 }} />
                        <Typography variant="subtitle2">Delivery history</Typography>
                        {detail.attempts.length ? detail.attempts.map((a, i) => (
                            <Typography key={i} variant="body2">{when(a.at)} · {a.kind} · {a.state}{a.recipient ? ` · ${a.recipient}` : ''}{a.reason ? ` · reason: ${a.reason}` : ''}{a.actor ? ` · by ${a.actor}` : ''}</Typography>
                        )) : <Typography variant="body2">Never sent.</Typography>}
                        {detail.order?.provider_status && <Typography variant="body2" sx={{ mt: 1 }}>Mail provider says: <b>{detail.order.provider_status}</b> ({when(detail.order.provider_checked_at)})</Typography>}
                        {detail.resends.length > 0 && <>
                            <Typography variant="subtitle2" sx={{ mt: 2 }}>Resend requests</Typography>
                            {detail.resends.map((r) => <Typography key={r.id} variant="body2">{when(r.requested_at)} · {r.requested_by} · “{r.reason}” · {r.state}{r.result ? ` · ${r.result}` : ''}</Typography>)}
                        </>}
                    </DialogContent>
                    <DialogActions>
                        <Button disabled={!['accepted', 'delivered'].includes(detail.order?.state)} onClick={() => setAsk({ kind: 'resend', order: detail.order.order_id })}>Resend ticket email…</Button>
                        <Button onClick={() => setDetail(null)}>Close</Button>
                    </DialogActions>
                </>}
            </Dialog>

            <Dialog open={!!ask} onClose={() => setAsk(null)} maxWidth="sm" fullWidth>
                <DialogTitle>{ask?.kind === 'pause' ? 'Pause all ticket email sending' : ask?.kind === 'resume' ? 'Resume sending' : 'Resend the ticket email'}</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                        {ask?.kind === 'pause' && 'Stops automatic sending, resends and the bulk sender from the next check (within 2 minutes).'}
                        {ask?.kind === 'resume' && `Returns to ${summary?.mode_before_pause || 'shadow'} mode.`}
                        {ask?.kind === 'resend' && 'The order is checked again (payment, ticket, email, do-not-disturb) and the same ticket is sent to the buyer within about 2 minutes. The reason is kept in the history.'}
                    </Typography>
                    <TextField autoFocus fullWidth label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAsk(null)}>Cancel</Button>
                    <Button variant="contained" color={ask?.kind === 'pause' ? 'error' : 'primary'} disabled={ask?.kind !== 'pause' && reason.trim().length < 5} onClick={confirm}>Confirm</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
