import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert, Box, Button, Card, CircularProgress, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography, useMediaQuery,
} from '@mui/material';
import { ecExport, ecHistory } from '../utils/api';
import { DeliveryChip, downloadBlob, errText, gst } from './EmailCenterShared';

const ATTEMPT = { initial: 'First send', retry: 'Retry', resend: 'Resend', test: 'Test', settled: 'Outcome settled', setup: 'Setup email', scanner: 'Scanner email', manual: 'Sent manually' };

export default function EmailCenterHistory({ eventId, me }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [q, setQ] = useState('');
    const [kind, setKind] = useState('');
    const [rows, setRows] = useState([]);
    const [count, setCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(() => {
        setLoading(true);
        const params = {};
        if (q.trim()) params.q = q.trim();
        if (kind) params.kind = kind;
        return ecHistory(eventId, params)
            .then((r) => { setRows(r.data.items || []); setCount(r.data.count ?? 0); setError(''); })
            .catch((e) => setError(errText(e)))
            .finally(() => setLoading(false));
    }, [eventId, q, kind]);
    useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]);

    const exportCsv = () => ecExport(eventId, 'history').then((r) => downloadBlob(r.data, 'email-center-history.csv')).catch((e) => setError(errText(e)));

    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 1.5 }} alignItems={narrow ? 'stretch' : 'center'}>
                <TextField size="small" label="Search recipient, order, company, message id" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 220 }} />
                <TextField size="small" select label="Type" value={kind} onChange={(e) => setKind(e.target.value)} sx={{ minWidth: 160 }}>
                    <MenuItem value="">All emails</MenuItem>
                    <MenuItem value="tickets">Ticket emails</MenuItem>
                    {me?.exhibitors && <MenuItem value="exhibitors">Exhibitor emails</MenuItem>}
                </TextField>
                {me?.export && <Button variant="text" onClick={exportCsv}>Export CSV</Button>}
            </Stack>
            <Card variant="outlined">
                <Box sx={{ overflowX: 'auto' }}>
                    {loading && !rows.length ? <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box> : (
                        <Table size="small" sx={{ minWidth: 1100 }}>
                            <TableHead><TableRow>
                                <TableCell>When</TableCell><TableCell>Type</TableCell><TableCell>Related</TableCell><TableCell>Attempt</TableCell>
                                <TableCell>Recipient</TableCell><TableCell>State</TableCell><TableCell>GHL status</TableCell>
                                <TableCell>Result</TableCell><TableCell>By</TableCell><TableCell>Template</TableCell><TableCell>Message id</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {rows.map((h) => (
                                    <TableRow key={h.id} hover>
                                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(h.at)}</TableCell>
                                        <TableCell>{h.type === 'exhibitor' ? 'Exhibitor' : 'Ticket'}</TableCell>
                                        <TableCell>{h.related}</TableCell>
                                        <TableCell>{ATTEMPT[h.attempt] || h.attempt}</TableCell>
                                        <TableCell>{h.recipient || '—'}</TableCell>
                                        <TableCell><DeliveryChip s={h.state} /></TableCell>
                                        <TableCell>{h.provider_status || '—'}{h.provider_checked_at && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{gst(h.provider_checked_at)}</Typography>}</TableCell>
                                        <TableCell sx={{ minWidth: 200 }}>{h.result || '—'}{h.reason ? ` — ${h.reason}` : ''}</TableCell>
                                        <TableCell>{h.actor || '—'}</TableCell>
                                        <TableCell>{h.template || '—'}</TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>{h.message_id || '—'}</TableCell>
                                    </TableRow>
                                ))}
                                {!rows.length && <TableRow><TableCell colSpan={11}>No email attempts yet.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    )}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                    {count} attempt(s), newest first. Every attempt is kept; nothing here is ever deleted.
                </Typography>
            </Card>
        </Box>
    );
}
