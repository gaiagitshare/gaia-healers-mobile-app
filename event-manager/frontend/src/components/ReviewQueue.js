import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Paper, Stack, Typography, Chip, Button, Alert, CircularProgress, Divider,
    Dialog, DialogTitle, DialogContent, DialogActions, TextField, Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DoneIcon from '@mui/icons-material/Done';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import { getReviewQueue, resolveReviewItem, dismissUnmappedSale } from '../utils/api';

/**
 * The review queue — one list of everything waiting on a person.
 *
 * Every rule in the system that declines to guess writes down why and moves on.
 * A duplicate charge held back from becoming a badge, a seat carrying the
 * buyer's name until somebody asks, a sale whose product nobody mapped, a
 * payment that never settled. All of it was readable and none of it was
 * anywhere a person would look: the held charges sat in an attendee's lifecycle
 * log, which is an audit trail, not a worklist.
 *
 * The sections are ordered by what it costs to leave them: money somebody may be
 * owed first, then people who will arrive without a badge, then the rest.
 *
 * Nothing here is a separate queue table. Each row is read from the record it is
 * about, so an item leaves the moment the underlying fact changes — a name gets
 * confirmed, a payment settles — rather than when somebody remembers to tick it
 * off. The few that cannot resolve themselves are closed with a reason, and
 * closing one is logged like any other act.
 */

// Money first, then people who will turn up without a badge.
const ORDER = [
    'payment_repeat', 'charge_held', 'sale_unmapped',
    'identity_review', 'name_to_confirm', 'seat_unnamed', 'payment_unsettled',
];

const HEADINGS = {
    payment_repeat: 'Paid twice for the same thing',
    charge_held: 'Charges held back from becoming a badge',
    sale_unmapped: 'Sales with no ticket behind them',
    identity_review: 'Records nobody could identify',
    name_to_confirm: 'Seats needing a name confirmed',
    seat_unnamed: 'Seats paid for with no badge yet',
    payment_unsettled: 'Payments that never settled',
};

// What it costs to leave each one alone, in the words of the consequence rather
// than the mechanism. A heading tells you what a group is; this tells you why
// it is worth your afternoon.
const WHY = {
    payment_repeat: 'Someone may have been charged twice. Refund it, or give them the second badge they meant to buy.',
    charge_held: 'A second settled charge that was deliberately not turned into a badge. Check the gateway, then close it.',
    sale_unmapped: 'Money arrived for a product that maps to no ticket, so nobody got a badge for it.',
    identity_review: 'An add-on arrived for an address with no matching badge and was parked rather than attached to a guess.',
    name_to_confirm: 'The badge carries the buyer’s name. Ask at the desk and correct it.',
    seat_unnamed: 'A booking paid for more seats than it has badges. Name them as people arrive.',
    payment_unsettled: 'Nobody is refused over this — an unsettled charge grants nothing — but each one is somebody who tried to pay.',
};

const SEV_COLOR = { error: 'error', warning: 'warning', info: 'default' };

function money(n) {
    if (n === undefined || n === null) return '';
    return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ReviewQueue() {
    const { id: eventId } = useParams();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [resolving, setResolving] = useState(null);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [flash, setFlash] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setError('');
        try {
            const response = await getReviewQueue(eventId);
            setData(response.data);
        } catch (err) {
            setError(err.response?.status === 403
                ? 'You do not have access to the review queue for this event.'
                : 'Could not load the review queue.');
        } finally { setLoading(false); }
    }, [eventId]);

    useEffect(() => { load(); }, [load]);

    const submitResolve = async () => {
        if (!resolving || note.trim().length < 3) return;
        setBusy(true);
        try {
            await resolveReviewItem(eventId, {
                attendee_id: resolving.attendee_id, ref: String(resolving.ref),
                kind: resolving.kind, note: note.trim(),
            });
            setResolving(null); setNote('');
            setFlash('Closed, with your reason on the record.');
            await load();
        } catch (err) {
            setError(err.response?.data?.detail || 'Could not close that item.');
        } finally { setBusy(false); }
    };

    const dismissSale = async (item) => {
        const saleId = String(item.action || '').split(':')[1];
        if (!saleId) return;
        setBusy(true);
        try {
            await dismissUnmappedSale(eventId, saleId);
            setFlash('Marked as not a ticket for this event.');
            await load();
        } catch (err) {
            setError(err.response?.data?.detail || 'Could not dismiss that sale.');
        } finally { setBusy(false); }
    };

    if (loading && !data) {
        return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress size={28} /></Box>;
    }
    if (error && !data) return <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>;

    const items = data?.items || [];
    const groups = ORDER
        .map((kind) => [kind, items.filter((r) => r.kind === kind)])
        .filter(([, rows]) => rows.length);
    const totalMoney = items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    return (
        <Box>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>Review queue</Typography>
                <Chip size="small" label={`${items.length} waiting`}
                      color={items.length ? 'warning' : 'success'} />
                {data?.money_visible && totalMoney > 0 && (
                    <Chip size="small" variant="outlined" label={`${money(totalMoney)} involved`} />
                )}
                <Box sx={{ flex: 1 }} />
                <Button size="small" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
                    Refresh
                </Button>
            </Stack>

            {!data?.money_visible && (
                <Alert severity="info" sx={{ mb: 2 }}>
                    Showing the work that belongs at the desk. Payments and amounts need
                    the organiser role.
                </Alert>
            )}
            {flash && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setFlash('')}>{flash}</Alert>}
            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {!items.length && (
                <Alert severity="success">
                    Nothing is waiting. Every held charge, unnamed seat and unmapped sale
                    has been dealt with.
                </Alert>
            )}

            <Stack spacing={2}>
                {groups.map(([kind, rows]) => {
                    const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                    return (
                        <Paper key={kind} variant="outlined" sx={{ p: 0, overflow: 'hidden' }}>
                            <Box sx={{ px: 1.75, pt: 1.5, pb: 1.25, bgcolor: 'action.hover' }}>
                                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                                        {HEADINGS[kind] || kind}
                                    </Typography>
                                    <Chip size="small" label={rows.length}
                                          color={SEV_COLOR[rows[0].severity] || 'default'} />
                                    {data?.money_visible && sum > 0 && (
                                        <Chip size="small" variant="outlined" label={money(sum)} />
                                    )}
                                </Stack>
                                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                                    {WHY[kind]}
                                </Typography>
                            </Box>
                            <Divider />
                            <Stack divider={<Divider />}>
                                {rows.map((r, i) => (
                                    <Stack key={`${r.kind}-${r.ref}-${i}`} direction={{ xs: 'column', sm: 'row' }}
                                           spacing={1} sx={{ px: 1.75, py: 1.25 }}
                                           justifyContent="space-between" alignItems={{ sm: 'center' }}>
                                        <Box sx={{ minWidth: 0 }}>
                                            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                                    {r.name || 'Unknown'}
                                                </Typography>
                                                {data?.money_visible && r.amount ? (
                                                    <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {money(r.amount)}
                                                    </Typography>
                                                ) : null}
                                                {r.when && (
                                                    <Typography variant="caption" color="text.secondary">
                                                        {String(r.when).slice(0, 10)}
                                                    </Typography>
                                                )}
                                            </Stack>
                                            <Typography variant="caption" color="text.secondary" display="block">
                                                {r.detail}
                                            </Typography>
                                            {r.email && (
                                                <Typography variant="caption" color="text.disabled" display="block">
                                                    {r.email}
                                                </Typography>
                                            )}
                                        </Box>
                                        <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
                                            {r.qr_code && (
                                                <Tooltip title="Open this person at the desk">
                                                    <Button size="small" variant="outlined"
                                                            startIcon={<PersonSearchIcon />}
                                                            href={`#/events/${eventId}/checkin?q=${encodeURIComponent(r.name || r.email || '')}`}>
                                                        Open at desk
                                                    </Button>
                                                </Tooltip>
                                            )}
                                            {String(r.action || '').startsWith('dismiss_sale:') && (
                                                <Button size="small" color="inherit" disabled={busy}
                                                        onClick={() => dismissSale(r)}>
                                                    Not a ticket
                                                </Button>
                                            )}
                                            {r.resolvable && (
                                                <Button size="small" variant="contained" startIcon={<DoneIcon />}
                                                        onClick={() => { setResolving(r); setNote(''); }}>
                                                    Close
                                                </Button>
                                            )}
                                        </Stack>
                                    </Stack>
                                ))}
                            </Stack>
                        </Paper>
                    );
                })}
            </Stack>

            {/* Closing an item is a statement that somebody dealt with it. Without a
                reason it is indistinguishable from an item nobody looked at, which is
                the state this queue exists to end. */}
            <Dialog open={Boolean(resolving)} onClose={() => !busy && setResolving(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Close this item</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {resolving?.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
                        {resolving?.detail}
                    </Typography>
                    <TextField autoFocus fullWidth size="small" multiline minRows={2}
                               label="What was done" placeholder="e.g. refunded the second charge in PayPal"
                               value={note} onChange={(e) => setNote(e.target.value)} />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setResolving(null)} disabled={busy}>Cancel</Button>
                    <Button variant="contained" disabled={busy || note.trim().length < 3}
                            onClick={submitResolve}>
                        Close it
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default ReviewQueue;
