import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Grid, Paper,
    Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { bwOverview, bwSessions } from '../utils/api';
import { errText, gst } from './EmailCenterShared';

/**
 * People -> Bio-Well (docs/BIOWELL_STATION_API.md, "Dashboard"). Read-only:
 * what the station has done, and which sessions need someone to follow up.
 * Retrying is done at the station screen, not here.
 */
const n = (v) => (v == null ? '—' : v);
const yesNo = (v) => (v == null ? '—' : v ? 'Yes' : 'No');

function Group({ title, rows }) {
    return (
        <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>{title}</Typography>
            <Grid container spacing={1.5}>
                {rows.map(([label, value]) => (
                    <Grid item xs={6} key={label}>
                        <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{value}</Typography>
                        <Typography variant="caption" color="text.secondary">{label}</Typography>
                    </Grid>
                ))}
            </Grid>
        </Paper>
    );
}

function Detail({ row, onClose }) {
    if (!row) return null;
    const lines = [
        ['When', gst(row.at)], ['Station', row.station], ['Staff', row.staff], ['Status', row.status],
        ['Ticket', row.ticket_id], ['Guest', yesNo(row.guest)], ['Email', row.email_status],
        ['Profile', row.profile], ['Results', row.results],
    ];
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>{row.name || 'Session'}</DialogTitle>
            <DialogContent>
                {row.next_step && <Alert severity="info" sx={{ mb: 2 }}><strong>Next step:</strong> {row.next_step}</Alert>}
                {row.error && <Alert severity="warning" sx={{ mb: 2 }}>{row.error}</Alert>}
                <Table size="small">
                    <TableBody>
                        {lines.map(([k, v]) => (
                            <TableRow key={k}>
                                <TableCell sx={{ color: 'text.secondary', width: 120 }}>{k}</TableCell>
                                <TableCell>{n(v)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    To retry, reopen this person at the station screen (scan or type their code).
                </Typography>
            </DialogContent>
            <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
        </Dialog>
    );
}

export default function BiowellDashboard() {
    const { id } = useParams();
    const [overview, setOverview] = useState(null);
    const [items, setItems] = useState(null);
    const [count, setCount] = useState(0);
    const [filter, setFilter] = useState('');
    const [q, setQ] = useState('');
    const [error, setError] = useState('');
    const [listError, setListError] = useState('');
    const [open, setOpen] = useState(null);

    const loadOverview = useCallback(() => {
        setError('');
        bwOverview(id).then((r) => setOverview(r.data)).catch((e) => setError(errText(e)));
    }, [id]);
    const loadList = useCallback(() => {
        setListError(''); setItems(null);
        bwSessions(id, filter)
            .then((r) => { setItems(r.data?.items || []); setCount(r.data?.count ?? (r.data?.items || []).length); })
            .catch((e) => { setListError(errText(e)); setItems([]); });
    }, [id, filter]);

    useEffect(() => { loadOverview(); }, [loadOverview]);
    useEffect(() => { loadList(); }, [loadList]);

    const shown = useMemo(() => {
        const t = q.trim().toLowerCase();
        return (items || []).filter((r) => !t || String(r.name || '').toLowerCase().includes(t));
    }, [items, q]);

    const o = overview || {};
    const st = o.station || {};
    const em = o.email || {};
    const pp = o.people_processed || {};
    const pa = o.partner || {};

    return (
        <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
                <Typography variant="h5">Bio-Well</Typography>
                <Button startIcon={<RefreshIcon />} onClick={() => { loadOverview(); loadList(); }}>Refresh</Button>
            </Stack>

            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            {!overview && !error && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress /></Box>}

            {overview && (
                <>
                    {pa.environment !== 'production' && (
                        <Alert severity="warning" sx={{ mb: 2 }}>
                            Results connection: STAGING (test system) — real attendees' readings will not appear until it is
                            switched to production.
                        </Alert>
                    )}
                    <Grid container spacing={2}>
                        <Grid item xs={12} sm={6} lg={3}>
                            <Group title="Station" rows={[
                                ['Sessions', n(st.sessions)], ['People', n(st.people)],
                                ['Open now', n(st.open)], ['With an error', n(st.with_error)],
                            ]} />
                        </Grid>
                        <Grid item xs={12} sm={6} lg={3}>
                            <Group title="Email changes" rows={[
                                ['Requested', n(em.changes_requested)], ['Verified', n(em.verified)],
                                ['Waiting for code', n(em.pending)], ['Expired', n(em.expired)],
                                ['Cancelled', n(em.cancelled)], ['Contacts created', n(em.contacts_created)],
                            ]} />
                        </Grid>
                        <Grid item xs={12} sm={6} lg={3}>
                            <Group title="People processed" rows={[
                                ['Profile activated', n(pp.profile_activated)], ['Share code requested', n(pp.consent_code_requested)],
                                ['Results linked', n(pp.results_linked)], ['Not linked yet', n(pp.not_linked_yet)],
                            ]} />
                        </Grid>
                        <Grid item xs={12} sm={6} lg={3}>
                            <Group title="Results connection" rows={[
                                ['Environment', n(pa.environment)], ['Connected', yesNo(pa.connected)],
                                ['Available', yesNo(pa.available)], ['Readings enabled', yesNo(pa.readings_enabled)],
                                ['Links confirmed', n(pa.links_confirmed)], ['Links revoked', n(pa.links_revoked)],
                                ['Codes issued (total)', n(pa.codes_issued_total)],
                            ]} />
                        </Grid>
                    </Grid>
                    <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
                        <Grid container spacing={1}>
                            {[
                                ['Host', pa.host], ['Last code issued', gst(pa.last_code_issued)],
                                ['Last link confirmed', gst(pa.last_link_confirmed)], ['Last reading opened', gst(pa.last_reading_opened)],
                                ['Last partner check', gst(pa.last_partner_check)],
                                ['Contact creation', o.contact_creation_enabled == null ? '—' : o.contact_creation_enabled ? 'On' : 'Off'],
                            ].map(([k, v]) => (
                                <Grid item xs={12} sm={6} md={4} key={k}>
                                    <Typography variant="caption" color="text.secondary">{k}</Typography>
                                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{n(v)}</Typography>
                                </Grid>
                            ))}
                        </Grid>
                    </Paper>
                    {o.note && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{o.note}</Typography>}
                </>
            )}

            <Typography variant="h6" sx={{ mt: 3, mb: 1 }}>Sessions</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
                <Stack direction="row" spacing={1}>
                    <Chip label="All" color={filter === '' ? 'primary' : 'default'} onClick={() => setFilter('')} />
                    <Chip label="Needs attention" color={filter === 'problems' ? 'primary' : 'default'} onClick={() => setFilter('problems')} />
                </Stack>
                <TextField size="small" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)}
                           sx={{ minWidth: { sm: 260 } }} />
                <Typography variant="body2" color="text.secondary">
                    {items ? `${shown.length} shown of ${count}` : ''}
                </Typography>
            </Stack>
            {listError && <Alert severity="error" sx={{ mb: 2 }}>{listError}</Alert>}
            {items === null ? (
                <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress /></Box>
            ) : shown.length === 0 ? (
                <Typography color="text.secondary">No sessions{filter === 'problems' ? ' need attention' : ''}{q.trim() ? ' match that name' : ''}.</Typography>
            ) : (
                <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>When (GST)</TableCell><TableCell>Name</TableCell><TableCell>Station</TableCell>
                                <TableCell>Status</TableCell><TableCell>Email</TableCell><TableCell>Profile</TableCell>
                                <TableCell>Results</TableCell><TableCell>Next step</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {shown.map((r) => (
                                <TableRow key={r.session_id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(r)}>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(r.at)}</TableCell>
                                    <TableCell>
                                        {n(r.name)}
                                        {r.guest && <Chip size="small" variant="outlined" label="Guest" sx={{ ml: 1 }} />}
                                    </TableCell>
                                    <TableCell>{n(r.station)}</TableCell>
                                    <TableCell>
                                        {n(r.status)}
                                        {r.error && <Chip size="small" color="warning" label="Error" sx={{ ml: 1 }} />}
                                    </TableCell>
                                    <TableCell>{n(r.email_status)}</TableCell>
                                    <TableCell>{n(r.profile)}</TableCell>
                                    <TableCell>{n(r.results)}</TableCell>
                                    <TableCell sx={{ minWidth: 220 }}>{n(r.next_step)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <Detail row={open} onClose={() => setOpen(null)} />
        </Box>
    );
}
