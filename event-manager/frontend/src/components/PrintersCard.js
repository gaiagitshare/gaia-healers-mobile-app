import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert, Box, Button, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { Print as PrintIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { getPrinterStatus } from '../utils/api';

// The door printers at a glance, for whoever is NOT at the door: which desk is
// on which printer, from which browser, whether its last attempt worked, and
// what the last failure said (with the driver's own trace). Refreshes itself,
// so it can sit open on a laptop all day.

const REFRESH_MS = 30000;
// "B1 Pro-H123" → "H123", the part written on the desk's sticker.
const tagOf = (name) => { const m = /-([^-]+)$/.exec(name || ''); return m ? m[1] : (name || '—'); };
const asDate = (at) => (at ? new Date(String(at).endsWith('Z') ? at : `${at}Z`) : null);   // the server stores UTC without a zone
const ago = (at) => {
    const t = asDate(at); if (!t || isNaN(t)) return '';
    const min = Math.round((Date.now() - t.getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    return h < 24 ? `${h} h ${min % 60} min ago` : t.toLocaleString();
};

function StatusChip({ desk }) {
    if (desk.status === 'failed') return <Chip size="small" color="error" label="Failing" />;
    if (desk.status === 'ok') return <Chip size="small" color="success" label="OK" />;
    return <Chip size="small" variant="outlined" label="No reports" />;
}

export default function PrintersCard({ eventId, eventName }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [hours, setHours] = useState(24);

    const load = useCallback(() => {
        if (!eventId) return;
        getPrinterStatus(eventId, hours)
            .then((r) => { setData(r.data); setError(''); })
            .catch((e) => setError(e.response?.data?.detail || 'Could not load the printers.'));
    }, [eventId, hours]);
    useEffect(() => {
        load();
        const t = setInterval(load, REFRESH_MS);
        return () => clearInterval(t);
    }, [load]);

    if (!eventId) return null;
    const desks = data?.desks || [];
    const failing = desks.filter((d) => d.status === 'failed').length;

    return (
        <Card>
            <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap" mb={1.5}>
                    <Box display="flex" alignItems="center" gap={1}>
                        <PrintIcon color="primary" />
                        <Typography variant="h6">Door printers</Typography>
                        {eventName && <Typography variant="body2" color="textSecondary">· {eventName}</Typography>}
                    </Box>
                    <Stack direction="row" spacing={1} alignItems="center">
                        {data && <Chip size="small" label={`${data.printed} printed · ${data.failed} failed`} />}
                        {failing > 0 && <Chip size="small" color="error" label={`${failing} desk${failing === 1 ? '' : 's'} failing`} />}
                        <Button size="small" onClick={() => setHours(hours === 24 ? 24 * 7 : 24)}>
                            {hours === 24 ? 'Last 24 h' : 'Last 7 days'}
                        </Button>
                        <Button size="small" startIcon={<RefreshIcon />} onClick={load}>Refresh</Button>
                    </Stack>
                </Box>

                {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}
                {(data?.shared_printers || []).map((s) => (
                    <Alert key={s.device} severity="error" sx={{ mb: 1.5 }}>
                        Printer <b>{tagOf(s.device)}</b> is being used by {s.desks.join(' and ')}. A printer talks to one
                        iPad at a time, so these desks will keep losing it: give each desk its own printer.
                    </Alert>
                ))}

                {data && !desks.length && (
                    <Typography color="textSecondary">
                        No printer activity in the last {hours === 24 ? '24 hours' : '7 days'}. Desks appear here once
                        they connect a printer or print a badge.
                    </Typography>
                )}

                {desks.length > 0 && (
                    <Box sx={{ overflowX: 'auto' }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Desk</TableCell>
                                    <TableCell>Printer</TableCell>
                                    <TableCell>Browser</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell align="right">Badges</TableCell>
                                    <TableCell>Last problem</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {desks.map((d) => (
                                    <TableRow key={d.station} sx={d.status === 'failed' ? { bgcolor: 'rgba(244, 67, 54, 0.06)' } : undefined}>
                                        <TableCell>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{d.station}</Typography>
                                            {d.operators.length > 0 && (
                                                <Typography variant="caption" color="textSecondary">{d.operators.join(', ')}</Typography>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{d.device ? tagOf(d.device) : '—'}</Typography>
                                            {d.printer && <Typography variant="caption" color="textSecondary">{d.printer}</Typography>}
                                            {d.shares_printer_with.length > 0 && (
                                                <Typography variant="caption" color="error.main" display="block">
                                                    also on {d.shares_printer_with.join(', ')}
                                                </Typography>
                                            )}
                                        </TableCell>
                                        <TableCell><Typography variant="body2">{d.browser || '—'}</Typography></TableCell>
                                        <TableCell>
                                            <StatusChip desk={d} />
                                            {d.last && <Typography variant="caption" color="textSecondary" display="block">{d.last.stage} · {ago(d.last.at)}</Typography>}
                                        </TableCell>
                                        <TableCell align="right">
                                            <Typography variant="body2">{d.printed}</Typography>
                                            {(d.print_failed > 0 || d.connect_failed > 0) && (
                                                <Typography variant="caption" color="error.main" display="block">
                                                    {d.print_failed > 0 ? `${d.print_failed} failed` : ''}
                                                    {d.print_failed > 0 && d.connect_failed > 0 ? ' · ' : ''}
                                                    {d.connect_failed > 0 ? `${d.connect_failed} connect` : ''}
                                                </Typography>
                                            )}
                                        </TableCell>
                                        <TableCell sx={{ maxWidth: 360 }}>
                                            {d.last_failure ? (
                                                <Box component="details" sx={{ fontSize: 13 }}>
                                                    <Box component="summary" sx={{ cursor: 'pointer' }}>
                                                        {ago(d.last_failure.at)} — {d.last_failure.error || `${d.last_failure.stage} failed`}
                                                    </Box>
                                                    {d.last_failure.trace.length > 0 && (
                                                        <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, maxHeight: 200, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                                            {d.last_failure.trace.join('\n')}
                                                        </Box>
                                                    )}
                                                </Box>
                                            ) : <Typography variant="body2" color="textSecondary">—</Typography>}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Box>
                )}
                <Typography variant="caption" color="textSecondary" display="block" sx={{ mt: 1 }}>
                    Refreshes every 30 seconds. A desk is named in Check-in → Station setup; unnamed desks show the person signed in.
                </Typography>
            </CardContent>
        </Card>
    );
}
