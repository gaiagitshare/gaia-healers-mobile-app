import React, { useCallback, useEffect, useState } from 'react';
import {
    Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell,
    Chip, Stack, TextField, MenuItem, Button, Alert, CircularProgress, Tooltip,
    ToggleButton, ToggleButtonGroup, Dialog, DialogTitle, DialogContent, DialogActions,
    Divider, Tabs, Tab,
} from '@mui/material';
import { getEvents, getPayments, getPaymentsSummary, getPaymentsAttention, getPaymentsRecovery } from '../utils/api';

/**
 * Payments — every attempt, and whether Gaia agrees with it.
 *
 * The two status columns are the point. "Money arrived" and "this person has a
 * ticket" are different facts, and the rows worth looking at are the ones where
 * they disagree: paid with no ticket means somebody cannot get in; refunded
 * with a live ticket means somebody can who should not. A single blended status
 * hides exactly those.
 *
 * GHL's own word is never overwritten — the normalised status drives colour and
 * filtering, and the raw value is one hover away.
 */

const PAY = {
    paid: { label: 'Paid', color: 'success' },
    pending: { label: 'Pending', color: 'warning' },
    declined: { label: 'Declined', color: 'error' },
    failed: { label: 'Failed', color: 'error' },
    refunded: { label: 'Refunded', color: 'secondary' },
    partially_refunded: { label: 'Part refunded', color: 'secondary' },
    cancelled: { label: 'Cancelled', color: 'default' },
    reversed: { label: 'Reversed', color: 'error' },
    disputed: { label: 'Disputed', color: 'error' },
    unknown: { label: 'Unknown', color: 'default' },
};

const money = (v, c) => (v || v === 0 ? `${c === 'USD' || !c ? '$' : ''}${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—');
const clock = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Payments() {
    const [events, setEvents] = useState([]);
    const [eventId, setEventId] = useState('');
    const [tab, setTab] = useState(0);
    const [rows, setRows] = useState([]);
    const [summary, setSummary] = useState(null);
    const [attention, setAttention] = useState(null);
    const [recovery, setRecovery] = useState(null);
    // Starts true: before the first fetch lands there is nothing to say, and an
    // empty-state message would be read as a fact rather than as a wait.
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const [provider, setProvider] = useState('');
    const [q, setQ] = useState('');
    const [detail, setDetail] = useState(null);

    useEffect(() => {
        getEvents().then((r) => {
            const list = r.data || [];
            setEvents(list);
            if (list.length && !eventId) setEventId(String(list[0].id));
        }).catch(() => setEvents([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const load = useCallback(async () => {
        if (!eventId) return;
        setLoading(true); setError('');
        try {
            const [f, s, a, rec] = await Promise.all([
                getPayments(eventId, { status, provider, q }),
                getPaymentsSummary(eventId),
                getPaymentsAttention(eventId),
                getPaymentsRecovery(eventId),
            ]);
            setRows(f.data.items || []);
            setSummary(s.data); setAttention(a.data); setRecovery(rec.data);
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not load payments.');
        } finally { setLoading(false); }
    }, [eventId, status, provider, q]);

    useEffect(() => { load(); }, [load]);
    // Near-real-time without hammering: the webhook writes the row the moment a
    // payment happens, so this only has to notice.
    useEffect(() => {
        const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
        return () => clearInterval(t);
    }, [load]);

    const t = summary?.today;

    return (
        <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="baseline" flexWrap="wrap" gap={1}>
                <Typography variant="h4" gutterBottom>Payments</Typography>
                <Typography variant="caption" color="text.secondary">
                    Read-only from GHL{summary?.last_checked ? ` · checked ${clock(summary.last_checked)}` : ''}
                </Typography>
            </Stack>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
                    <TextField select size="small" label="Event" value={eventId}
                        onChange={(e) => setEventId(e.target.value)} sx={{ minWidth: 250 }}>
                        {events.map((ev) => <MenuItem key={ev.id} value={String(ev.id)}>{ev.name}</MenuItem>)}
                    </TextField>
                    <TextField size="small" label="Search" placeholder="name, email, phone, order or transaction id"
                        value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 280, flex: 1 }} />
                    <TextField select size="small" label="Provider" value={provider}
                        onChange={(e) => setProvider(e.target.value)} sx={{ minWidth: 130 }}>
                        <MenuItem value="">All</MenuItem>
                        {(summary?.providers || []).map((p) => (
                            <MenuItem key={p} value={p.toLowerCase()}>{p}</MenuItem>
                        ))}
                    </TextField>
                    <Button size="small" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>
                </Stack>
            </Paper>

            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {t && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    <Typography variant="overline" color="text.secondary">Today</Typography>
                    <Stack direction="row" gap={3} flexWrap="wrap" alignItems="baseline" sx={{ mt: 0.5 }}>
                        <Box>
                            <Typography variant="h6">{t.paid} <Box component="span" sx={{ fontSize: 15, fontWeight: 400 }}>paid</Box></Typography>
                            <Typography variant="caption" color="text.secondary">{money(t.paid_amount)} · {t.unique_buyers} buyers</Typography>
                        </Box>
                        {Object.entries(t.by_provider || {}).map(([p, n]) => (
                            <Box key={p}><Typography variant="h6">{n}</Typography>
                                <Typography variant="caption" color="text.secondary">{p}</Typography></Box>
                        ))}
                        <Box><Typography variant="h6" color={t.declined_or_failed ? 'error.main' : 'text.primary'}>{t.declined_or_failed}</Typography>
                            <Typography variant="caption" color="text.secondary">declined / failed</Typography></Box>
                        <Box><Typography variant="h6" color={t.pending ? 'warning.main' : 'text.primary'}>{t.pending}</Typography>
                            <Typography variant="caption" color="text.secondary">pending</Typography></Box>
                        <Box>
                            <Typography variant="h6" color={t.paid_missing_ticket ? 'error.main' : 'success.main'}>
                                {t.paid_missing_ticket}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">paid but missing from Gaia</Typography>
                        </Box>
                    </Stack>
                    {summary?.all_time && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                            This event, all time: {summary.all_time.attempts} attempts · {summary.all_time.paid} successful
                            payments · {summary.all_time.unique_buyers} unique buyers · {money(summary.all_time.paid_amount)}
                        </Typography>
                    )}
                </Paper>
            )}

            {attention && (attention.critical > 0 || attention.warning > 0 || attention.unmapped_event_sales > 0) && (
                <Alert severity={attention.critical ? 'error' : 'warning'} sx={{ mb: 2 }}>
                    <strong>Needs attention.</strong>{' '}
                    {attention.critical > 0 && <>{attention.critical} critical · </>}
                    {attention.warning > 0 && <>{attention.warning} to review · </>}
                    {attention.unmapped_event_sales > 0 && <>{attention.unmapped_event_sales} unmapped event sales</>}
                    <Box sx={{ mt: 1 }}>
                        {(attention.items || []).slice(0, 5).map((r) => (
                            <Typography key={r.id} variant="body2">
                                {r.severity === 2 ? '🔴' : '🟠'} {r.buyer} · {money(r.amount, r.currency)} · {r.provider} — {r.reason}
                            </Typography>
                        ))}
                    </Box>
                </Alert>
            )}

            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1.5 }}>
                <Tab label={`Feed${rows.length ? ` (${rows.length})` : ''}`} />
                <Tab label={`Needs attention${attention?.items?.length ? ` (${attention.items.length})` : ''}`} />
                <Tab label={`Recovery${recovery?.unrecovered ? ` (${recovery.unrecovered})` : ''}`} />
            </Tabs>

            {tab !== 2 && (
                <ToggleButtonGroup size="small" exclusive value={status} sx={{ mb: 1.5, flexWrap: 'wrap' }}
                    onChange={(_, v) => setStatus(v ?? '')}>
                    <ToggleButton value="">All</ToggleButton>
                    <ToggleButton value="paid">Paid</ToggleButton>
                    <ToggleButton value="pending">Pending</ToggleButton>
                    <ToggleButton value="declined,failed">Declined / failed</ToggleButton>
                    <ToggleButton value="refunded,partially_refunded">Refunded</ToggleButton>
                    <ToggleButton value="missing_ticket">Missing ticket</ToggleButton>
                </ToggleButtonGroup>
            )}

            {tab === 2
                ? <RecoveryTable data={recovery} />
                : <FeedTable rows={tab === 1 ? (attention?.items || []) : rows} onOpen={setDetail} loading={loading} />}

            <DetailDialog row={detail} onClose={() => setDetail(null)} />
        </Box>
    );
}

function FeedTable({ rows, onOpen, loading }) {
    if (loading && !rows.length) {
        return <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={26} /></Paper>;
    }
    if (!rows.length) {
        return <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
            <Typography variant="body2">Nothing here.</Typography>
        </Paper>;
    }
    return (
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small">
                <TableHead>
                    <TableRow>
                        <TableCell>Time</TableCell>
                        <TableCell>Buyer</TableCell>
                        <TableCell>Product</TableCell>
                        <TableCell align="right">Amount</TableCell>
                        <TableCell>Provider</TableCell>
                        <TableCell>Payment</TableCell>
                        <TableCell>Ticket</TableCell>
                    </TableRow>
                </TableHead>
                <TableBody>
                    {rows.map((r) => {
                        const p = PAY[r.status] || PAY.unknown;
                        const bad = r.severity === 2;
                        return (
                            <TableRow key={r.id} hover sx={{ cursor: 'pointer', bgcolor: bad ? 'error.light' : undefined,
                                       ...(bad ? { '& td': { color: 'error.contrastText' } } : {}) }}
                                onClick={() => onOpen(r)}>
                                <TableCell sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{clock(r.at)}</TableCell>
                                <TableCell>
                                    <Typography variant="body2" fontWeight={600} noWrap>{r.buyer || '—'}</Typography>
                                    <Typography variant="caption" noWrap display="block" sx={{ opacity: 0.75 }}>{r.email}</Typography>
                                </TableCell>
                                <TableCell><Typography variant="caption">{(r.products || []).join(', ') || '—'}</Typography></TableCell>
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amount, r.currency)}</TableCell>
                                <TableCell><Typography variant="caption">{r.provider}</Typography></TableCell>
                                <TableCell>
                                    {/* The raw GHL word is one hover away — the colour is ours, the fact is theirs. */}
                                    <Tooltip title={`GHL: ${r.status_raw || '?'}${r.order_status_raw ? ` · order ${r.order_status_raw}` : ''}`}>
                                        <Chip size="small" color={p.color} label={p.label} sx={{ height: 20, fontSize: 11 }} />
                                    </Tooltip>
                                </TableCell>
                                <TableCell>
                                    {r.ticket === 'created'
                                        ? <Chip size="small" color="success" variant="outlined" label="Created" sx={{ height: 20, fontSize: 11 }} />
                                        : (r.severity === 2
                                            ? <Chip size="small" color="error" label="MISSING" sx={{ height: 20, fontSize: 11 }} />
                                            : <Typography variant="caption" sx={{ opacity: 0.5 }}>—</Typography>)}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Paper>
    );
}

function RecoveryTable({ data }) {
    if (!data) return <CircularProgress size={26} />;
    const items = (data.items || []);
    return (
        <>
            <Alert severity="info" sx={{ mb: 1.5 }} icon={false}>
                <strong>{data.unrecovered} people attempted a payment that never completed</strong>, worth{' '}
                {money(data.unrecovered_value)}. {data.recovered} more had a failure but paid another way — those are
                marked resolved, because chasing them would be an apology sent to a paying customer.
            </Alert>
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>Buyer</TableCell><TableCell>Product</TableCell>
                            <TableCell align="right">Amount</TableCell><TableCell>Provider</TableCell>
                            <TableCell>GHL status</TableCell><TableCell align="right">Attempts</TableCell>
                            <TableCell>First tried</TableCell><TableCell>Outcome</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {items.map((r) => (
                            <TableRow key={r.email || r.name} hover sx={{ opacity: r.recovered ? 0.5 : 1 }}>
                                <TableCell>
                                    <Typography variant="body2" fontWeight={600}>{r.name || '—'}</Typography>
                                    <Typography variant="caption" color="text.secondary" display="block">{r.email}</Typography>
                                </TableCell>
                                <TableCell><Typography variant="caption">{(r.products || []).join(', ') || '—'}</Typography></TableCell>
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amount)}</TableCell>
                                <TableCell><Typography variant="caption">{(r.providers || []).join(', ')}</Typography></TableCell>
                                <TableCell><Typography variant="caption">{(r.ghl_statuses || []).join(', ')}</Typography></TableCell>
                                <TableCell align="right">{r.attempts}</TableCell>
                                <TableCell><Typography variant="caption">{clock(r.first_attempt)}{r.age_days != null ? ` · ${r.age_days}d` : ''}</Typography></TableCell>
                                <TableCell>
                                    {r.recovered
                                        ? <Chip size="small" color="success" variant="outlined" label="Paid another way" sx={{ height: 20, fontSize: 11 }} />
                                        : <Chip size="small" color="warning" label="Never paid" sx={{ height: 20, fontSize: 11 }} />}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Paper>
        </>
    );
}

function DetailDialog({ row, onClose }) {
    if (!row) return null;
    const L = ({ k, v }) => (v || v === 0 ? (
        <Stack direction="row" justifyContent="space-between" gap={2} sx={{ py: 0.4 }}>
            <Typography variant="caption" color="text.secondary">{k}</Typography>
            <Typography variant="caption" sx={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{String(v)}</Typography>
        </Stack>
    ) : null);
    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>{row.buyer} · {money(row.amount, row.currency)}</DialogTitle>
            <DialogContent dividers>
                {row.severity > 0 && (
                    <Alert severity={row.severity === 2 ? 'error' : 'warning'} sx={{ mb: 2 }}>{row.reason}</Alert>
                )}
                <Divider textAlign="left"><Typography variant="caption">What GHL says</Typography></Divider>
                <L k="Transaction status" v={row.status_raw} />
                <L k="Order status" v={row.order_status_raw} />
                <L k="Provider" v={row.provider} />
                <L k="Entity" v={row.entity_type} />
                <L k="Order / invoice id" v={row.order_id} />
                <L k="Transaction id" v={row.transaction_id} />
                <L k="Amount refunded" v={row.amount_refunded} />
                <L k="Funnel" v={row.funnel} />
                <L k="Page" v={row.page_url ? `${row.page || ''}${row.page_url}` : row.page} />
                <L k="Source" v={row.source_type} />
                <L k="Live mode" v={row.live_mode ? 'yes' : 'NO — test transaction'} />
                <Divider textAlign="left" sx={{ mt: 2 }}><Typography variant="caption">What Gaia says</Typography></Divider>
                <L k="Normalised status" v={row.status} />
                <L k="Event" v={row.event_id || 'not an event product'} />
                <L k="Attendee" v={row.attendee_id || 'none'} />
                <L k="Verdict" v={`${row.recon_state} — ${row.reason}`} />
                <L k="First seen" v={clock(row.first_seen)} />
                <L k="Last checked" v={clock(row.last_checked)} />
                <L k="Recorded by" v={row.ingest_source} />
                <L k="Resolved" v={row.resolved_at ? `${clock(row.resolved_at)} — ${row.resolution}` : null} />
            </DialogContent>
            <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
        </Dialog>
    );
}
