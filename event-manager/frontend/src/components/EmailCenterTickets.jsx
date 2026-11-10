import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow,
    TextField, Typography, useMediaQuery,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ecBookings, ecExport } from '../utils/api';
import EmailCenterReview from './EmailCenterReview';
import {
    BatchCard, BatchConfirmDialog, DeliveryChip, downloadBlob, errText, GatedButton, gst, MapChip, PAYMENT, RECON, ReviewChip, sendBlock,
} from './EmailCenterShared';

const FILTER_LABELS = {
    pending_review: 'Pending review', verified: 'Verified', approved: 'Approved', ready: 'Ready to send',
    can_approve: 'Can be approved', blocked: 'Blocked', held: 'Held', needs_correction: 'Needs correction',
    changed: 'Changed since review', not_sent: 'Not sent', sent: 'Sent', delivered: 'Delivered',
    failed: 'Failed / unknown', multi: 'Several tickets', late: 'Late orders', missing_email: 'Missing email',
};
const FILTERS = Object.keys(FILTER_LABELS);

export default function EmailCenterTickets({ eventId, me, initialFilter, openKey, onOpened }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [filter, setFilter] = useState(initialFilter || '');
    const [q, setQ] = useState('');
    const [rows, setRows] = useState([]);
    const [filters, setFilters] = useState(FILTERS);
    const [count, setCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [picked, setPicked] = useState(new Set());
    const [reviewKey, setReviewKey] = useState(null);
    const [batchAsk, setBatchAsk] = useState(null); // {selector, title}
    const [batchId, setBatchId] = useState(null);

    useEffect(() => { if (initialFilter !== undefined) setFilter(initialFilter || ''); }, [initialFilter]);
    useEffect(() => { if (openKey) { setReviewKey(openKey); onOpened && onOpened(); } }, [openKey, onOpened]);

    const load = useCallback(() => {
        setLoading(true);
        const params = {};
        if (filter) params.filter = filter;
        if (q.trim()) params.q = q.trim();
        return ecBookings(eventId, params)
            .then((r) => {
                setRows(r.data.items || []); setCount(r.data.count ?? (r.data.items || []).length);
                if (r.data.filters?.length) setFilters(r.data.filters);
                setError('');
                setPicked((p) => { const keep = new Set((r.data.items || []).map((b) => b.key)); return new Set([...p].filter((k) => keep.has(k))); });
            })
            .catch((e) => setError(errText(e)))
            .finally(() => setLoading(false));
    }, [eventId, filter, q]);
    useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]);

    // The Review panel hands back the fresh booking after every action.
    const onChanged = useCallback((b) => setRows((rs) => rs.map((r) => (r.key === b.key ? { ...r, ...b } : r))), []);

    const toggle = (k) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.key));
    const sBlock = sendBlock(me);

    const exportCsv = () => ecExport(eventId, 'orders').then((r) => downloadBlob(r.data, 'email-center-orders.csv')).catch((e) => setError(errText(e)));
    const startBatch = (selector, title) => setBatchAsk({ selector, title });

    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            {batchId && <Box sx={{ mb: 2 }}><BatchCard eventId={eventId} id={batchId} me={me} onFinished={load} /></Box>}

            <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 1 }} alignItems={narrow ? 'stretch' : 'center'}>
                <TextField size="small" label="Search order, name or email" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 220 }} />
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {me?.send && <>
                        <GatedButton variant="contained" reason={sBlock || (!picked.size ? 'Select orders first.' : '')}
                                     onClick={() => startBatch({ keys: [...picked] }, `Send ${picked.size} selected order(s)`)}>
                            Send selected{picked.size ? ` (${picked.size})` : ''}
                        </GatedButton>
                        <GatedButton variant="outlined" reason={sBlock} onClick={() => startBatch({ all_approved: true }, 'Send all approved orders')}>Send all approved</GatedButton>
                        <GatedButton variant="outlined" color="warning" reason={sBlock}
                                     onClick={() => startBatch(picked.size ? { retry: true, keys: [...picked] } : { retry: true, all_approved: true },
                                         picked.size ? `Retry failed emails of ${picked.size} selected order(s)` : 'Retry every failed email')}>
                            Retry failed
                        </GatedButton>
                    </>}
                    {me?.export && <Button variant="text" onClick={exportCsv}>Export CSV</Button>}
                </Stack>
            </Stack>

            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                <Chip label="All" color={!filter ? 'primary' : 'default'} variant={!filter ? 'filled' : 'outlined'} onClick={() => setFilter('')} />
                {filters.map((f) => (
                    <Chip key={f} label={FILTER_LABELS[f] || f.replace(/_/g, ' ')} color={filter === f ? 'primary' : 'default'}
                          variant={filter === f ? 'filled' : 'outlined'} onClick={() => setFilter(filter === f ? '' : f)} />
                ))}
            </Stack>

            <Card variant="outlined">
                <Box sx={{ overflowX: 'auto' }}>
                    {loading && !rows.length ? <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box> : (
                        <Table size="small" sx={{ minWidth: 1300 }}>
                            <TableHead><TableRow>
                                <TableCell padding="checkbox">
                                    <Checkbox size="small" checked={allPicked} indeterminate={picked.size > 0 && !allPicked}
                                              inputProps={{ 'aria-label': 'Select all shown' }}
                                              onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.key)))} />
                                </TableCell>
                                <TableCell>Order number</TableCell><TableCell>Purchaser</TableCell><TableCell>Email</TableCell>
                                <TableCell>Ticket type</TableCell><TableCell align="right">Purchased</TableCell><TableCell align="right">Generated</TableCell>
                                <TableCell>Payment</TableCell><TableCell>QR</TableCell><TableCell>Reconciliation</TableCell>
                                <TableCell>Verification</TableCell><TableCell>Email status</TableCell><TableCell>Last sent</TableCell><TableCell>Actions</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {rows.map((b) => {
                                    const mismatch = b.paid_for !== b.tickets_generated;
                                    const flagged = mismatch || (b.critical || []).length > 0;
                                    return (
                                        <TableRow key={b.key} hover selected={picked.has(b.key)}
                                                  sx={flagged ? { bgcolor: (t) => alpha(t.palette.error.main, 0.08) } : undefined}>
                                            <TableCell padding="checkbox">
                                                <Checkbox size="small" checked={picked.has(b.key)} onChange={() => toggle(b.key)} inputProps={{ 'aria-label': `Select ${b.order_number || b.key}` }} />
                                            </TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                                {b.order_number || b.key}
                                                {b.order_ids?.length > 1 && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>+{b.order_ids.length - 1} more order(s)</Typography>}
                                            </TableCell>
                                            <TableCell>{b.purchaser_name}</TableCell>
                                            <TableCell>{b.purchaser_email || <Typography variant="body2" color="error">Missing</Typography>}</TableCell>
                                            <TableCell>{(b.ticket_types || []).join(', ')}</TableCell>
                                            <TableCell align="right">{b.paid_for}</TableCell>
                                            <TableCell align="right" sx={mismatch ? { color: 'error.main', fontWeight: 700 } : undefined}>{b.tickets_generated}</TableCell>
                                            <TableCell><MapChip map={PAYMENT} s={b.payment_status} /></TableCell>
                                            <TableCell><Chip size="small" variant="outlined" label={b.qr_status === 'ok' ? 'OK' : 'Problem'} color={b.qr_status === 'ok' ? 'success' : 'error'} /></TableCell>
                                            <TableCell><MapChip map={RECON} s={b.reconciliation} /></TableCell>
                                            <TableCell>
                                                <ReviewChip s={b.review_state} />
                                                {b.changed_since_review && <Chip size="small" color="warning" variant="outlined" label="Changed" sx={{ ml: 0.5 }} />}
                                            </TableCell>
                                            <TableCell><DeliveryChip s={b.delivery} /></TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(b.last_sent)}</TableCell>
                                            <TableCell><Button size="small" variant="outlined" onClick={() => setReviewKey(b.key)}>Review</Button></TableCell>
                                        </TableRow>
                                    );
                                })}
                                {!rows.length && <TableRow><TableCell colSpan={14}>No orders match.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    )}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                    {count} order(s){picked.size ? ` · ${picked.size} selected` : ''}. Rows in red: purchased and generated differ, or a blocker exists.
                </Typography>
            </Card>

            <EmailCenterReview eventId={eventId} bookingKey={reviewKey} me={me} onClose={() => setReviewKey(null)} onChanged={onChanged} />
            {batchAsk && (
                <BatchConfirmDialog eventId={eventId} selector={batchAsk.selector} title={batchAsk.title} me={me}
                                    onClose={() => setBatchAsk(null)}
                                    onStarted={(bid) => { setBatchAsk(null); setBatchId(bid); setPicked(new Set()); load(); }} />
            )}
        </Box>
    );
}
