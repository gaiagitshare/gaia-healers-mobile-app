import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    Grid, LinearProgress, Paper, Stack, TextField, Typography, useMediaQuery,
} from '@mui/material';
import { ecOverview, ecRefreshStatus, ecSetControls } from '../utils/api';
import { BatchCard, errText, gst } from './EmailCenterShared';

function Stat({ label, value, color, hint, onClick }) {
    return (
        <Paper variant="outlined" onClick={onClick}
               sx={{ p: 1.5, height: '100%', cursor: onClick ? 'pointer' : 'default', '&:hover': onClick ? { borderColor: 'primary.main' } : undefined }}>
            <Typography variant="caption" color={color ? `${color}.main` : 'text.secondary'} sx={{ fontWeight: 600 }}>{label}</Typography>
            <Typography variant="h5">{value ?? '—'}</Typography>
            {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
        </Paper>
    );
}

function Progress({ label, done, total, color = 'success' }) {
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
        <Box sx={{ mb: 1.5 }}>
            <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2">{label}</Typography>
                <Typography variant="body2" fontWeight={700}>{done ?? 0} / {total ?? 0}</Typography>
            </Stack>
            <LinearProgress variant="determinate" value={pct} color={color} sx={{ height: 8, borderRadius: 4 }} />
        </Box>
    );
}

const LEGEND = [
    ['Accepted', 'info', 'GHL took the email. There is no delivery evidence yet.'],
    ['Delivered', 'success', 'GHL reports the receiving mail server accepted it.'],
    ['Opened / Clicked', 'success', 'Reported by GHL. Opened is indicative only: Apple Mail can pre-open emails.'],
    ['Failed / Bounced', 'error', 'The email did not arrive. Fix the address or the cause, then retry.'],
    ['Unknown', 'warning', 'The send got no clear answer. Never resend blind: check GHL first, then settle the outcome.'],
];

export default function EmailCenterOverview({ eventId, me, reloadMe, goTab }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [ov, setOv] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    const [switchAsk, setSwitchAsk] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => ecOverview(eventId).then((r) => { setOv(r.data); setError(''); }).catch((e) => setError(errText(e))), [eventId]);
    useEffect(() => { load(); }, [load]);

    const refresh = () => {
        setRefreshing(true);
        ecRefreshStatus(eventId).then((r) => { setNotice(`Asked GHL about ${r.data.checked} recent email(s).`); load(); })
            .catch((e) => setError(errText(e))).finally(() => setRefreshing(false));
    };
    const CH = {
        tickets: { title: 'Attendee ticket emails', st: me?.sending, by: me?.sending_changed_by, at: me?.sending_changed_at,
            onText: 'Ticket emails can be sent from this screen (after two-admin approval).' },
        exhibitors: { title: 'Exhibitor emails', st: me?.sending_exhibitors, by: me?.sending_exhibitors_changed_by, at: me?.sending_exhibitors_changed_at,
            onText: 'Setup and scanner emails can be sent to stands from this screen.' },
    };
    const ch = switchAsk ? CH[switchAsk] : null;
    const chOn = ch?.st?.switch === 'on';
    const flip = () => {
        setBusy(true);
        ecSetControls(eventId, { channel: switchAsk, sending: chOn ? 'off' : 'on', reason: reason.trim() })
            .then(() => { setNotice(`${ch.title}: sending switched ${chOn ? 'OFF' : 'ON'}.`); setSwitchAsk(false); setReason(''); reloadMe(); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const switchCard = (key) => {
        const c = CH[key];
        const on = c.st?.switch === 'on';
        return (
            <Grid item xs={12} md={6} key={key}>
                <Card variant="outlined" sx={{ height: '100%', borderColor: on ? 'success.main' : 'error.main' }}>
                    <CardContent>
                        <Stack spacing={1}>
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                                <Typography variant="subtitle1" fontWeight={700}>{c.title}:</Typography>
                                <Chip label={on ? 'ON' : 'OFF'} color={on ? 'success' : 'error'} sx={{ fontWeight: 700 }} />
                            </Stack>
                            <Typography variant="body2" color="text.secondary">
                                {on ? (c.st?.enabled ? c.onText : `Switched on, but sending is still blocked: ${c.st?.reason || ''}`) : 'OFF — none of these emails can be sent.'}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">Last changed by {c.by || '—'} · {gst(c.at)}</Typography>
                            {me?.platform_admin && (
                                <Box>
                                    <Button variant={on ? 'outlined' : 'contained'} color={on ? 'error' : 'success'} onClick={() => { setReason(''); setSwitchAsk(key); }}>
                                        {on ? 'Switch OFF' : 'Switch ON'}
                                    </Button>
                                </Box>
                            )}
                        </Stack>
                    </CardContent>
                </Card>
            </Grid>
        );
    };

    if (!ov) return error ? <Alert severity="error">{error}</Alert> : <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>;
    const a = ov.attendee || {};
    const x = ov.exhibitor || {};
    const tickets = (filter) => () => goTab('tickets', { filter });
    const cards = [
        ['Orders', a.orders, null, null, tickets('')],
        ['Tickets generated', a.tickets, a.tickets !== a.tickets_paid_for ? 'error' : null, `Paid for ${a.tickets_paid_for ?? '—'}`],
        ['Pending review', a.pending_review, null, null, tickets('pending_review')],
        ['Approved', a.approved, 'success', null, tickets('approved')],
        ['Ready to send', a.ready_to_send, 'info', null, tickets('ready')],
        ['Sent', a.sent, null, `${a.emails ?? 0} emails in total`, tickets('sent')],
        ['Delivered', a.delivered, 'success', `Opened ${a.opened ?? 0} · Clicked ${a.clicked ?? 0}`, tickets('delivered')],
        ['Failed', a.failed, a.failed ? 'error' : null, null, tickets('failed')],
        ['Bounced', a.bounced, a.bounced ? 'error' : null, null, tickets('failed')],
        ['Unknown', a.unknown, a.unknown ? 'warning' : null, 'Check GHL before resending', tickets('failed')],
        ['Held', a.held, a.held ? 'warning' : null, null, tickets('held')],
        ['Needs attention', ov.needs_attention, ov.needs_attention ? 'warning' : null, null, () => goTab('attention')],
    ];
    const batches = ov.batches || [];

    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1 }}>{notice}</Alert>}

            <Grid container spacing={2} sx={{ mb: 2 }}>
                {switchCard('tickets')}
                {switchCard('exhibitors')}
            </Grid>

            {batches.length > 0 && (
                <Card variant="outlined" sx={{ mb: 2 }}>
                    <CardContent>
                        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Runs in progress</Typography>
                        <Stack spacing={1}>
                            {batches.map((b) => <BatchCard key={b.id} eventId={eventId} id={b.id} me={me} onFinished={load} />)}
                        </Stack>
                    </CardContent>
                </Card>
            )}

            <Card variant="outlined" sx={{ mb: 2 }}>
                <CardContent>
                    <Stack direction={narrow ? 'column' : 'row'} justifyContent="space-between" alignItems={narrow ? 'stretch' : 'center'} spacing={1} sx={{ mb: 1.5 }}>
                        <Box>
                            <Typography variant="subtitle1" fontWeight={700}>Attendee ticket emails</Typography>
                            <Typography variant="caption" color="text.secondary">
                                Figures built {gst(ov.built_at)}.
                                {a.not_in_ticket_emails ? ` ${a.not_in_ticket_emails} staff, volunteer and guest tickets are not part of ticket emails.` : ''}
                            </Typography>
                        </Box>
                        {me?.send && <Button variant="outlined" disabled={refreshing} onClick={refresh}>{refreshing ? 'Asking GHL…' : 'Refresh delivery status'}</Button>}
                    </Stack>
                    <Progress label="Delivered emails" done={a.delivered} total={a.emails} />
                    <Progress label="Orders approved" done={a.approved} total={a.orders} color="primary" />
                    <Grid container spacing={1}>
                        {cards.map(([label, value, color, hint, onClick]) => (
                            <Grid item xs={6} sm={4} md={3} lg={2} key={label}>
                                <Stat label={label} value={value} color={color} hint={hint} onClick={onClick} />
                            </Grid>
                        ))}
                    </Grid>
                    {(a.blocked > 0 || a.changed_since_review > 0 || a.missing_email > 0 || a.late_orders > 0 || a.needs_correction > 0) && (
                        <Alert severity="warning" sx={{ mt: 1.5 }}>
                            {[a.blocked && `${a.blocked} order(s) blocked`, a.needs_correction && `${a.needs_correction} need correction`,
                              a.changed_since_review && `${a.changed_since_review} changed since review`, a.missing_email && `${a.missing_email} missing an email`,
                              a.late_orders && `${a.late_orders} late order(s)`].filter(Boolean).join(' · ')}
                        </Alert>
                    )}
                    {a.accepted_no_evidence > 0 && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                            {a.accepted_no_evidence} email(s) accepted by GHL with no delivery evidence yet.
                        </Typography>
                    )}
                </CardContent>
            </Card>

            {me?.exhibitors && (
                <Card variant="outlined" sx={{ mb: 2 }}>
                    <CardContent>
                        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Exhibitor emails</Typography>
                        <Progress label="Setup emails delivered / stands" done={x.setup_delivered} total={x.stands} />
                        <Progress label="Profiles activated / stands" done={x.profiles_activated} total={x.stands} color="primary" />
                        <Progress label="Scanner emails delivered / stands with scanning on" done={x.scanner_delivered} total={x.scanning_enabled} />
                        <Grid container spacing={1}>
                            {[
                                ['Stands', x.stands], ['Missing contact', x.missing_contact, x.missing_contact ? 'error' : null],
                                ['Setup emails sent', x.setup_sent], ['Scanning on', x.scanning_enabled],
                                ['Scanner emails sent', x.scanner_sent], ['Failed / unknown', x.failed, x.failed ? 'error' : null],
                                ['Stands with a first scan', x.first_scans], ['Leads', x.leads],
                            ].map(([label, value, color]) => (
                                <Grid item xs={6} sm={4} md={3} lg={2} key={label}>
                                    <Stat label={label} value={value} color={color} onClick={() => goTab('exhibitors')} />
                                </Grid>
                            ))}
                        </Grid>
                    </CardContent>
                </Card>
            )}

            <Card variant="outlined">
                <CardContent>
                    <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>What the email statuses mean</Typography>
                    <Stack spacing={0.75}>
                        {LEGEND.map(([l, c, text]) => (
                            <Stack key={l} direction="row" spacing={1} alignItems="flex-start">
                                <Chip size="small" label={l} color={c} sx={{ minWidth: 120 }} />
                                <Typography variant="body2">{text}</Typography>
                            </Stack>
                        ))}
                    </Stack>
                </CardContent>
            </Card>

            <Dialog open={Boolean(switchAsk)} onClose={() => setSwitchAsk(false)} fullWidth maxWidth="sm" fullScreen={narrow}>
                <DialogTitle>{ch ? `${ch.title}: switch sending ${chOn ? 'OFF' : 'ON'}` : ''}</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                        {chOn ? 'None of these emails can be sent while this is off. Runs in progress stop at their next email.'
                            : switchAsk === 'exhibitors'
                                ? 'People with send permission will be able to send setup and scanner emails to stands. Attendee ticket emails stay as they are.'
                                : 'People with send permission will be able to send approved ticket emails. Exhibitor emails stay as they are.'}
                        {' '}This does not change the automatic ticket sender or the global pause.
                    </Typography>
                    <TextField autoFocus fullWidth multiline minRows={2} label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSwitchAsk(false)}>Cancel</Button>
                    <Button variant="contained" color={chOn ? 'error' : 'success'} disabled={busy || !reason.trim()} onClick={flip}>
                        {busy ? 'Saving…' : chOn ? 'Switch OFF' : 'Switch ON'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
