import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
    Divider, Grid, Paper, Stack, TextField, Typography,
} from '@mui/material';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { QRCodeSVG } from 'qrcode.react';
import {
    bwLookup, bwStartSession, bwSession, bwSendEmail, bwVerify, bwResend, bwCancelEmail, bwClose,
} from '../utils/api';
import { errText, gst } from './EmailCenterShared';

/**
 * Bio-Well station (docs/BIOWELL_STATION_API.md). One screen, phone/iPad first:
 * scan a badge -> confirm it is the right person -> help them with three
 * things (their own email, their Gaia Healers profile, sharing their readings)
 * -> done. This screen never shows a reading: the API has none to show.
 */
const STATION_NAME_KEY = 'gha_biowell_station';
const DEFAULT_STATION = 'Bio-Well station';
const REFRESH_MS = 10000;
const TAP = { minHeight: 48, fontSize: 16, textTransform: 'none', fontWeight: 600 };

const readStation = () => {
    try { return localStorage.getItem(STATION_NAME_KEY) || DEFAULT_STATION; } catch (e) { return DEFAULT_STATION; }
};
const writeStation = (v) => { try { localStorage.setItem(STATION_NAME_KEY, v); } catch (e) { /* private mode */ } };
const newKey = () => {
    try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};
const isToday = (iso) => {
    if (!iso) return false;
    const s = String(iso);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
};

const EMAIL_STATUS = {
    ok: ['Email OK', 'success'],
    verified: ['Email confirmed', 'success'],
    pending: ['Waiting for code', 'warning'],
    needs_email: ['Needs their own email', 'error'],
};

function StatusChip({ map, s }) {
    const [label, color] = map[s] || [s || '—', 'default'];
    return <Chip size="medium" color={color} label={label} />;
}

function Card({ title, chip, children }) {
    return (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, height: '100%' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
                <Typography variant="h6" fontWeight={700}>{title}</Typography>
                {chip}
            </Stack>
            {children}
        </Paper>
    );
}

// ── Scan ────────────────────────────────────────────────────────────────────
function ScanStep({ busy, onCode }) {
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState('');
    const onCodeRef = useRef(onCode);
    onCodeRef.current = onCode;
    const scannerRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        let fired = false;
        const s = new Html5QrcodeScanner('biowell-qr-reader', { fps: 10, qrbox: { width: 250, height: 250 } }, false);
        s.render((text) => {
            if (fired) return;
            fired = true;
            setOpen(false);
            onCodeRef.current(text);
        }, () => {});
        scannerRef.current = s;
        return () => { s.clear().catch(() => {}); scannerRef.current = null; };
    }, [open]);

    const submitTyped = () => { const v = typed.trim(); if (v && !busy) onCode(v); };

    return (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, maxWidth: 640, mx: 'auto' }}>
            <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>Scan their badge</Typography>
            <Button fullWidth variant="contained" size="large" startIcon={<QrCodeScannerIcon />}
                    sx={{ ...TAP, minHeight: 56, fontSize: 18 }} onClick={() => setOpen((v) => !v)} disabled={busy}>
                {open ? 'Close camera' : 'Open camera'}
            </Button>
            <Collapse in={open} unmountOnExit>
                <Box sx={{ mt: 2 }}><div id="biowell-qr-reader" style={{ width: '100%' }} /></Box>
            </Collapse>
            <Divider sx={{ my: 2.5 }}><Typography variant="body2" color="text.secondary">or type the code</Typography></Divider>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField fullWidth label="Ticket or badge code" value={typed} autoComplete="off"
                           onChange={(e) => setTyped(e.target.value)}
                           onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); }}
                           inputProps={{ style: { fontSize: 18 } }} />
                <Button variant="outlined" size="large" sx={{ ...TAP, minWidth: 140 }}
                        disabled={busy || !typed.trim()} onClick={submitTyped}>
                    {busy ? <CircularProgress size={22} /> : 'Look up'}
                </Button>
            </Stack>
        </Paper>
    );
}

// ── Confirm ─────────────────────────────────────────────────────────────────
function ConfirmStep({ person, busy, onStart, onBack }) {
    const recent = person.recent_sessions || [];
    const today = recent.filter((r) => isToday(r.at)).length;
    return (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, maxWidth: 640, mx: 'auto' }}>
            <Typography variant="body2" color="text.secondary">Is this the person in front of you?</Typography>
            <Typography sx={{ fontSize: { xs: 30, sm: 38 }, fontWeight: 800, lineHeight: 1.15, my: 1, wordBreak: 'break-word' }}>
                {person.name || 'Name not on file'}
            </Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
                {person.pass && <Chip label={person.pass} color="primary" />}
                {person.is_guest && <Chip color="secondary" label={person.guest_of ? `Guest of ${person.guest_of}` : 'Guest'} />}
                {person.checked_in && <Chip variant="outlined" label="Checked in" />}
                {person.ticket_status && <Chip variant="outlined" label={person.ticket_status} />}
            </Stack>
            {recent.length > 0 && (
                <Alert severity="info" sx={{ mb: 2 }}>
                    {today > 0
                        ? `Seen at the station ${today} time${today === 1 ? '' : 's'} today.`
                        : `Seen at the station ${recent.length} time${recent.length === 1 ? '' : 's'} before.`}
                    {' '}Last: {gst(recent[0].at)}{recent[0].station ? ` · ${recent[0].station}` : ''}{recent[0].status ? ` · ${recent[0].status}` : ''}
                </Alert>
            )}
            <Stack spacing={1.5}>
                <Button fullWidth variant="contained" size="large" color="success" disabled={busy}
                        sx={{ ...TAP, minHeight: 60, fontSize: 19 }} onClick={onStart}>
                    {busy ? <CircularProgress size={24} color="inherit" /> : 'Yes, this is them — start'}
                </Button>
                <Button fullWidth variant="outlined" size="large" sx={TAP} disabled={busy} onClick={onBack}>
                    Not them — scan again
                </Button>
            </Stack>
        </Paper>
    );
}

// ── Session cards ───────────────────────────────────────────────────────────
function EmailCard({ session, busy, run }) {
    const p = session.person || {};
    const pending = p.pending_email;
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const pendingAddr = pending?.email;
    useEffect(() => { setCode(''); }, [pendingAddr]);

    return (
        <Card title="Email" chip={<StatusChip map={EMAIL_STATUS} s={session.email_status} />}>
            <Typography variant="body2" color="text.secondary">Email on their profile</Typography>
            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>
                <Typography sx={{ fontSize: 18, fontWeight: 600, wordBreak: 'break-all' }}>{p.profile_email || 'None'}</Typography>
                {p.profile_email && (
                    <Chip size="small" color={p.profile_email_usable ? 'success' : 'warning'}
                          label={p.profile_email_usable ? 'Usable' : 'Not usable'} />
                )}
                {p.shared_contact && <Chip size="small" variant="outlined" label="Shared with the buyer" />}
            </Stack>
            {p.email_problem && <Alert severity="warning" sx={{ mb: 1.5 }}>{p.email_problem}</Alert>}

            {pending ? (
                <Box>
                    <Alert severity="info" sx={{ mb: 1.5 }}>
                        Code sent to <strong>{pending.email}</strong>{pending.since ? ` (${gst(pending.since)})` : ''}.
                    </Alert>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                        <TextField fullWidth label="6-digit code" value={code} autoComplete="one-time-code"
                                   onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                   onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) run((sid) => bwVerify(sid.eventId, sid.id, code)); }}
                                   inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', style: { fontSize: 24, letterSpacing: '.3em' } }} />
                        <Button variant="contained" size="large" sx={{ ...TAP, minWidth: 130 }}
                                disabled={busy || code.length !== 6}
                                onClick={() => run((sid) => bwVerify(sid.eventId, sid.id, code))}>
                            Confirm
                        </Button>
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 1.5 }}>
                        <Button fullWidth variant="outlined" sx={TAP} disabled={busy || pending.can_send === false}
                                onClick={() => run((sid) => bwResend(sid.eventId, sid.id))}>
                            Send the code again
                        </Button>
                        <Button fullWidth variant="text" sx={TAP} disabled={busy}
                                onClick={() => run((sid) => bwCancelEmail(sid.eventId, sid.id))}>
                            Use a different email
                        </Button>
                    </Stack>
                </Box>
            ) : (
                <Stack spacing={1.5}>
                    <TextField fullWidth type="email" label="Their own email" value={email} autoComplete="off"
                               inputProps={{ inputMode: 'email', autoCapitalize: 'none', style: { fontSize: 18 } }}
                               onChange={(e) => setEmail(e.target.value)} />
                    <Button fullWidth variant="contained" size="large" sx={TAP} disabled={busy || !email.trim()}
                            onClick={() => run((sid) => bwSendEmail(sid.eventId, sid.id, email.trim()))}>
                        Send code to this email
                    </Button>
                </Stack>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                We email a 6-digit code. Nothing changes until they enter it.
                Their ticket and purchase stay exactly as they are.
            </Typography>
        </Card>
    );
}

function ProfileCard({ session }) {
    const p = session.person || {};
    const active = Boolean(p.profile_activated);
    return (
        <Card title="Profile" chip={<Chip color={active ? 'success' : 'warning'} label={active ? 'Active' : 'Not activated'} />}>
            {active ? (
                <Typography sx={{ fontSize: 22, fontWeight: 700, color: 'success.main' }}>Profile active ✓</Typography>
            ) : p.profile_url ? (
                <Stack alignItems="center" spacing={1.5}>
                    <Box sx={{ bgcolor: '#fff', p: 1.5, borderRadius: 1, lineHeight: 0 }}>
                        <QRCodeSVG value={p.profile_url} size={240} includeMargin={false} />
                    </Box>
                    <Typography sx={{ fontSize: 17, textAlign: 'center' }}>
                        Scan with your phone camera → Activate → enter the code from your email → choose a password
                    </Typography>
                </Stack>
            ) : (
                <Alert severity="warning">No profile link for this person yet.</Alert>
            )}
        </Card>
    );
}

const RESULTS = {
    none: ['Not shared', 'default', 'On their phone: Your Bio-Well readings → Share with my practitioner → give the code to the practitioner'],
    code_issued: ['Code waiting', 'warning', 'Code waiting — the practitioner enters it in Gaia Practitioners'],
    linked: ['Linked', 'success', 'Linked ✓ — readings appear in their profile when published'],
};

function ResultsCard({ session }) {
    const p = session.person || {};
    const [label, color, text] = RESULTS[session.consent_status] || [session.consent_status || '—', 'default', ''];
    if (!p.results_available) {
        // The practitioner connection is not live yet: nothing to share today.
        return (
            <Card title="Results" chip={<Chip label="Not open yet" />}>
                <Typography sx={{ fontSize: 17 }}>
                    Sharing Bio-Well results opens when the practitioner connection goes live. Their email and profile are
                    ready; there is nothing else to do for results today.
                </Typography>
            </Card>
        );
    }
    return (
        <Card title="Results" chip={<Chip color={color} label={label} />}>
            {p.link_store_unavailable
                ? <Alert severity="warning">Link status unavailable right now</Alert>
                : <Typography sx={{ fontSize: 17 }}>{text}</Typography>}
        </Card>
    );
}

// ── Screen ──────────────────────────────────────────────────────────────────
export default function BiowellStation() {
    const { id: eventId } = useParams();
    const [station, setStation] = useState(readStation);
    const [stationOpen, setStationOpen] = useState(false);
    const [stationDraft, setStationDraft] = useState('');
    const [stage, setStage] = useState('scan'); // scan | confirm | session
    const [person, setPerson] = useState(null);
    const [session, setSession] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [closeAs, setCloseAs] = useState(null); // 'done' | 'abandoned'
    const [note, setNote] = useState('');
    const clientKey = useRef(null);
    const busyRef = useRef(false);

    const reset = () => {
        setStage('scan'); setPerson(null); setSession(null); setError(''); setMessage('');
        clientKey.current = null;
    };

    const lookup = async (code) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setError(''); setMessage('');
        try {
            const r = await bwLookup(eventId, String(code).trim());
            clientKey.current = newKey(); // one per person shown; reused on retries
            setPerson(r.data); setStage('confirm');
        } catch (e) { setError(errText(e)); }
        finally { busyRef.current = false; setBusy(false); }
    };

    const start = async () => {
        if (busyRef.current || !person) return;
        busyRef.current = true; setBusy(true); setError('');
        try {
            const r = await bwStartSession(eventId, { ticket_id: person.ticket_id, station, client_key: clientKey.current });
            setSession(r.data); setStage('session');
        } catch (e) { setError(errText(e)); }
        finally { busyRef.current = false; setBusy(false); }
    };

    const sid = session?.session_id;

    // Every session action answers with the updated session (+ message).
    const run = async (call) => {
        if (busyRef.current || !sid) return;
        busyRef.current = true; setBusy(true); setError(''); setMessage('');
        try {
            const r = await call({ eventId, id: sid });
            const { message: msg, code_sent: _sent, ...s } = r.data || {};
            if (s.session_id) setSession(s);
            if (msg) setMessage(msg);
        } catch (e) { setError(errText(e)); }
        finally { busyRef.current = false; setBusy(false); }
    };

    const refresh = useCallback(async (quiet) => {
        if (!sid || busyRef.current) return;
        if (!quiet) { busyRef.current = true; setBusy(true); setError(''); }
        try {
            const r = await bwSession(eventId, sid);
            setSession(r.data);
        } catch (e) { if (!quiet) setError(errText(e)); }
        finally { if (!quiet) { busyRef.current = false; setBusy(false); } }
    }, [eventId, sid]);

    useEffect(() => {
        if (stage !== 'session' || !sid) return undefined;
        const t = setInterval(() => refresh(true), REFRESH_MS);
        return () => clearInterval(t);
    }, [stage, sid, refresh]);

    const close = async () => {
        if (busyRef.current || !sid || !closeAs) return;
        busyRef.current = true; setBusy(true); setError('');
        try {
            await bwClose(eventId, sid, closeAs, note.trim() || undefined);
            setCloseAs(null); setNote('');
            reset();
        } catch (e) { setError(errText(e)); setCloseAs(null); }
        finally { busyRef.current = false; setBusy(false); }
    };

    const saveStation = () => {
        const v = stationDraft.trim() || DEFAULT_STATION;
        setStation(v); writeStation(v); setStationOpen(false);
    };

    return (
        <Box sx={{ pb: 6 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
                <Typography variant="h5" fontWeight={700}>Bio-Well Station</Typography>
                <Button variant="outlined" sx={TAP} onClick={() => { setStationDraft(station); setStationOpen(true); }}>
                    {station}
                </Button>
            </Stack>

            {error && <Alert severity="error" sx={{ mb: 2, fontSize: 16 }} onClose={() => setError('')}>{error}</Alert>}

            {stage === 'scan' && <ScanStep busy={busy} onCode={lookup} />}

            {stage === 'confirm' && person && (
                <ConfirmStep person={person} busy={busy} onStart={start} onBack={reset} />
            )}

            {stage === 'session' && session && (
                <Box>
                    <Paper elevation={0} sx={{ p: { xs: 2, sm: 2.5 }, mb: 2, bgcolor: 'primary.main', color: 'primary.contrastText', borderRadius: 2 }}>
                        <Typography sx={{ fontSize: { xs: 24, sm: 30 }, fontWeight: 800, lineHeight: 1.2, wordBreak: 'break-word' }}>
                            {session.person?.name || 'Name not on file'}
                        </Typography>
                        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ my: 1 }}>
                            {session.person?.pass && <Chip size="small" label={session.person.pass} sx={{ bgcolor: 'rgba(255,255,255,.2)', color: 'inherit' }} />}
                            {session.person?.is_guest && (
                                <Chip size="small" sx={{ bgcolor: 'rgba(255,255,255,.2)', color: 'inherit' }}
                                      label={session.person.guest_of ? `Guest of ${session.person.guest_of}` : 'Guest'} />
                            )}
                            {session.status && <Chip size="small" label={session.status} sx={{ bgcolor: 'rgba(255,255,255,.2)', color: 'inherit' }} />}
                        </Stack>
                        <Typography variant="overline" sx={{ opacity: 0.85, display: 'block', lineHeight: 1.6 }}>Next step</Typography>
                        <Typography sx={{ fontSize: { xs: 20, sm: 24 }, fontWeight: 600, lineHeight: 1.3 }}>
                            {session.next_step || '—'}
                        </Typography>
                    </Paper>

                    {session.error && <Alert severity="warning" sx={{ mb: 2, fontSize: 16 }}>{session.error}</Alert>}
                    {message && <Alert severity="success" sx={{ mb: 2, fontSize: 16 }} onClose={() => setMessage('')}>{message}</Alert>}

                    <Grid container spacing={2}>
                        <Grid item xs={12} md={6}>
                            <EmailCard key={sid} session={session} busy={busy} run={run} />
                        </Grid>
                        <Grid item xs={12} md={6}><ProfileCard session={session} /></Grid>
                        <Grid item xs={12} md={6}><ResultsCard session={session} /></Grid>
                    </Grid>

                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 3 }}>
                        <Button variant="outlined" size="large" startIcon={<RefreshIcon />} sx={TAP} disabled={busy}
                                onClick={() => refresh(false)}>
                            Refresh
                        </Button>
                        <Box sx={{ flex: 1 }} />
                        <Button variant="outlined" color="warning" size="large" sx={TAP} disabled={busy}
                                onClick={() => { setNote(''); setCloseAs('abandoned'); }}>
                            Couldn't finish
                        </Button>
                        <Button variant="contained" color="success" size="large" sx={{ ...TAP, minWidth: 160 }} disabled={busy}
                                onClick={() => { setNote(''); setCloseAs('done'); }}>
                            Done
                        </Button>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        Updates by itself every 10 seconds. Started {gst(session.created_at)}{session.staff ? ` by ${session.staff}` : ''}.
                    </Typography>
                </Box>
            )}

            <Dialog open={Boolean(closeAs)} onClose={() => !busy && setCloseAs(null)} fullWidth maxWidth="sm">
                <DialogTitle>{closeAs === 'done' ? 'Finish with this person?' : "Couldn't finish"}</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        {closeAs === 'done'
                            ? 'The session is closed and the screen goes back to scanning.'
                            : 'Say what stopped it so the team can follow up. The screen goes back to scanning.'}
                    </Typography>
                    <TextField fullWidth multiline minRows={2} label="Note (optional)" value={note}
                               onChange={(e) => setNote(e.target.value)} />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button sx={TAP} disabled={busy} onClick={() => setCloseAs(null)}>Back</Button>
                    <Button sx={TAP} variant="contained" color={closeAs === 'done' ? 'success' : 'warning'} disabled={busy} onClick={close}>
                        {closeAs === 'done' ? 'Done' : 'Close session'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={stationOpen} onClose={() => setStationOpen(false)} fullWidth maxWidth="xs">
                <DialogTitle>Station name</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Saved on this device only, e.g. "Booth 21" or "Scan table 2".
                    </Typography>
                    <TextField fullWidth autoFocus value={stationDraft} placeholder={DEFAULT_STATION}
                               onChange={(e) => setStationDraft(e.target.value)}
                               onKeyDown={(e) => { if (e.key === 'Enter') saveStation(); }} />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button sx={TAP} onClick={() => setStationOpen(false)}>Cancel</Button>
                    <Button sx={TAP} variant="contained" onClick={saveStation}>Save</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
