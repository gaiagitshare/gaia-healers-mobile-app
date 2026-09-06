import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress,
    Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton,
    InputAdornment, MenuItem, Paper, Snackbar, Stack, TextField, Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import HowToRegIcon from '@mui/icons-material/HowToReg';
import PrintIcon from '@mui/icons-material/Print';
import UndoIcon from '@mui/icons-material/Undo';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import TuneIcon from '@mui/icons-material/Tune';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { authorizeScan, getScanLogs, searchAttendees, getEvents, walkInCreate, getTicketTypes, badgeLabelBlob, recordBadgePrint, undoCheckIn, clearScanLogs, setDoorTestMode, getEvent } from '../utils/api';
import { formatVenueTime, statusLabel, isFlaggedStatus } from '../utils/datetime';

// The access zones a scanner can be checking. The BACKEND decides the outcome;
// the operator only tells it which door/zone this is.
const ZONES = [
    { value: 'EVENT_ENTRY', label: 'Event entry (checks in)' },
    { value: 'EXHIBIT', label: 'Exhibit hall' },
    { value: 'CONFERENCE', label: 'Conference / speakers' },
    { value: 'WORKSHOP', label: 'Workshops' },
    { value: 'VIP', label: 'VIP area' },
];
// How each state reads at a glance. REHEARSAL is not a stored result — it is a
// real decision taken while the door is in practice mode — so it gets its own
// presentation without pretending the audit trail has a status it does not.
const LOG_STATE = {
    GRANTED:   { label: 'Granted',   mark: '✓', color: 'success', variant: 'outlined' },
    LIMITED:   { label: 'Limited',   mark: '!', color: 'warning', variant: 'outlined' },
    DENIED:    { label: 'Denied',    mark: '✕', color: 'error',   variant: 'filled' },
    UNDO:      { label: 'Undo',      mark: '↶', color: 'info',    variant: 'outlined' },
    REHEARSAL: { label: 'Rehearsal', mark: '◐', color: 'warning', variant: 'filled' },
};
const HEADLINE = {
    GRANTED: 'ADMITTED', LIMITED: 'CHECK THIS ONE', DENIED: 'DENIED', UNDO: 'UNDONE',
};
const STATION_KEY = 'gha_station';
const LABEL_SIZE_KEY = 'gha_label_size';

// The desk faces a queue. Contact details are masked until the operator asks.
const maskEmail = (email) => {
    const s = String(email || '');
    const at = s.indexOf('@');
    if (at < 1) return s ? '•••' : '';
    return s[0] + '•••' + s.slice(at);
};
const maskPhone = (phone) => {
    const d = String(phone || '').replace(/\D/g, '');
    return d ? '••• ••• ' + d.slice(-4) : '';
};
// Which of the pre-printed coloured cards to hand over. The sticker never
// repeats the tier; the card already says it.
const physicalCard = (attendee) => {
    const code = attendee?.effective_access?.base_ticket?.code || attendee?.ticket_type_code || '';
    return code === 'VIP' ? 'VIP' : 'ATTENDEE';
};

function CheckIn({ timezone: timezoneProp }) {
    const { id: eventIdFromRoute } = useParams();
    const [pickedEvent, setPickedEvent] = useState(null);
    const [events, setEvents] = useState([]);
    const eventId = eventIdFromRoute || (pickedEvent ? String(pickedEvent.id) : '');
    const timezone = eventIdFromRoute ? timezoneProp : pickedEvent?.timezone;

    const [accessType, setAccessType] = useState('EVENT_ENTRY');
    const [scanning, setScanning] = useState(false);
    const [manualCode, setManualCode] = useState('');
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const scannerRef = useRef(null);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);
    // New visitor at the door. Nothing is written until staff have seen who it
    // might already be — a second permanent card is the one mistake that
    // cannot be quietly undone.
    // Why they need a badge is asked FIRST and never inferred. A walk-in is
    // not the same thing as a paid ticket.
    const DOOR_REASONS = [
        { key: 'already_paid', label: 'Already paid — can’t find them',
          hint: 'Usually a sync delay. Their GHL order will reconcile onto this record when it arrives.',
          attendance_type: 'paid', door_payment_status: 'none' },
        { key: 'pay_at_door', label: 'Paying at the door',
          hint: 'Recorded as a Gaia door payment. Nothing is written to GHL — take the money on your usual till.',
          attendance_type: 'paid', door_payment_status: 'collected' },
        { key: 'complimentary', label: 'Complimentary / guest',
          hint: 'No payment expected. Say who authorised it.',
          attendance_type: 'complimentary', door_payment_status: 'waived' },
        { key: 'crew', label: 'Staff / speaker / exhibitor',
          hint: 'Working the event. No ticket payment.',
          attendance_type: 'staff', door_payment_status: 'none' },
    ];
    const BLANK_VISITOR = { first_name: '', last_name: '', email: '', phone: '', ticket_type_id: '', note: '',
        reason: '', attendance_type: 'paid', door_payment_status: 'none', door_payment_method: 'cash',
        door_payment_amount: '', door_payment_currency: 'USD', door_payment_reference: '' };
    const [visitor, setVisitor] = useState(null);
    const [visitorBusy, setVisitorBusy] = useState(false);
    const [visitorMatches, setVisitorMatches] = useState(null);
    const [visitorError, setVisitorError] = useState('');
    const [ticketTypes, setTicketTypes] = useState([]);
    const [busyId, setBusyId] = useState(null);
    const [confirmFlagged, setConfirmFlagged] = useState(null);
    const [feedback, setFeedback] = useState(null);
    const [scanLogs, setScanLogs] = useState([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [clearLogsOpen, setClearLogsOpen] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [rehearsal, setRehearsal] = useState(false);
    const [rehearsalBusy, setRehearsalBusy] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [revealId, setRevealId] = useState(null);
    const [station, setStation] = useState(() => { try { return localStorage.getItem(STATION_KEY) || ''; } catch (e) { return ''; } });
    const [labelSize, setLabelSize] = useState(() => { try { return localStorage.getItem(LABEL_SIZE_KEY) || '40x60'; } catch (e) { return '40x60'; } });
    // The label preview: check-in has ALREADY committed by the time this opens.
    const [label, setLabel] = useState(null);   // { attendee, url, attemptId, checkedInNow, error }
    const [undoTarget, setUndoTarget] = useState(null);
    const [undoReason, setUndoReason] = useState('');
    const [stationOpen, setStationOpen] = useState(false);
    const [logFilter, setLogFilter] = useState('');
    const [expandedLog, setExpandedLog] = useState(null);
    const [showDecisionDetail, setShowDecisionDetail] = useState(false);

    // The door's own state: has this event started, and is a rehearsal running.
    const [doorEvent, setDoorEvent] = useState(null);
    useEffect(() => {
        if (!eventId) { setDoorEvent(null); return; }
        getEvent(eventId)
            .then((r) => { setDoorEvent(r.data); setRehearsal(Boolean(r.data?.door_test_mode)); })
            .catch(() => setDoorEvent(null));
    }, [eventId]);
    const doorNotOpenYet = (() => {
        const start = doorEvent?.start_date;
        const end = doorEvent?.end_date || start;
        if (!start) return false;
        const today = new Date().toISOString().slice(0, 10);
        return today < String(start).slice(0, 10) || today > String(end).slice(0, 10);
    })();

    useEffect(() => {
        if (eventIdFromRoute) return;
        getEvents().then((response) => setEvents(response.data)).catch(() => setEvents([]));
    }, [eventIdFromRoute]);

    useEffect(() => {
        setQuery(''); setResults(null); setResult(null); setError(''); setConfirmFlagged(null);
    }, [eventId]);

    const refreshScanLogs = async () => {
        if (!eventId) { setScanLogs([]); return; }
        setLogsLoading(true);
        try {
            const response = await getScanLogs(eventId, 100);
            setScanLogs(response.data.items || []);
        } catch (err) {
            setScanLogs([]);
        } finally { setLogsLoading(false); }
    };

    useEffect(() => { refreshScanLogs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);

    useEffect(() => {
        if (!eventId) { setTicketTypes([]); return; }
        getTicketTypes(eventId).then((r) => setTicketTypes(r.data || [])).catch(() => setTicketTypes([]));
    }, [eventId]);

    const openVisitor = () => {
        const q = (query || '').trim();
        const seed = { ...BLANK_VISITOR };
        // Carry whatever staff already typed into the search box.
        if (q.includes('@')) seed.email = q;
        else if (q && !/^[+\d ()-]+$/.test(q)) {
            const bits = q.split(/\s+/);
            seed.first_name = bits[0] || '';
            seed.last_name = bits.slice(1).join(' ');
        } else if (q) seed.phone = q;
        setVisitor(seed); setVisitorMatches(null); setVisitorError('');
    };

    const submitVisitor = async (extra = {}) => {
        setVisitorBusy(true); setVisitorError('');
        try {
            const body = {
                ...visitor,
                ticket_type_id: visitor.ticket_type_id || null,
                door_payment_amount: visitor.door_payment_status === 'collected'
                    ? Number(visitor.door_payment_amount) || 0 : null,
                ...extra,
            };
            delete body.reason;
            const response = await walkInCreate(eventId, body);
            const d = response.data || {};
            if (d.ok === false && d.reason === 'possible_duplicate') { setVisitorMatches(d.matches || []); return; }
            const person = d.attendee;
            setVisitor(null); setVisitorMatches(null);
            setQuery(person.email || '');
            setFeedback({
                severity: 'success',
                message: d.already_registered
                    ? `${fullName(person)} was already registered for this event.`
                    : d.reused_existing_card
                        ? `${fullName(person)} added to this event — they keep their existing badge card.`
                        : `${fullName(person)} registered. Their badge card is ready to print.`,
            });
        } catch (err) {
            setVisitorError(err.response?.data?.detail || 'Could not register that person.');
        } finally { setVisitorBusy(false); }
    };

    useEffect(() => {
        if (scanning) {
            scannerRef.current = new Html5QrcodeScanner('qr-reader', { qrbox: { width: 250, height: 250 }, fps: 10 });
            scannerRef.current.render(onScanSuccess, onScanError);
        }
        return () => { if (scannerRef.current) scannerRef.current.clear(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scanning]);

    const term = query.trim();
    useEffect(() => {
        if (!term || !eventId) { setResults(null); return undefined; }
        setSearching(true);
        const timer = setTimeout(async () => {
            try {
                const response = await searchAttendees(eventId, term);
                setResults(response.data);
                setTruncated(String(response.headers?.['x-search-truncated'] || '0') === '1');
            }
            catch (err) { setFeedback({ severity: 'error', message: 'Search failed. Try again.' }); }
            finally { setSearching(false); }
        }, 300);
        return () => clearTimeout(timer);
    }, [term, eventId]);

    const onScanSuccess = async (decodedText) => {
        if (scannerRef.current) scannerRef.current.pause();
        await runScan(decodedText);
    };
    const onScanError = () => {};

    const runScan = async (qrCode) => {
        setError(''); setResult(null);
        if (!eventId) { setError('Choose an event first — a scan always belongs to one event.'); return; }
        try {
            const response = await authorizeScan(eventId, {
                qr_code: qrCode, access_type: accessType,
            });
            setResult(response.data);
            await refreshScanLogs();
            setTimeout(() => { if (scannerRef.current && scanning) scannerRef.current.resume(); }, 3500);
        } catch (err) {
            setError(err.response?.data?.detail || 'Scan failed');
        }
    };

    const handleManualCheckIn = () => {
        if (manualCode.trim()) { runScan(manualCode.trim()); setManualCode(''); }
    };

    const refreshSearch = async () => {
        if (!term) return;
        try { const response = await searchAttendees(eventId, term); setResults(response.data); } catch (err) { /* noop */ }
    };

    // Admit from a search row — same backend authorize (EVENT_ENTRY) as a scan.
    const checkInAttendee = async (attendee) => {
        setBusyId(attendee.id); setConfirmFlagged(null);
        try {
            const response = await authorizeScan(eventId, { qr_code: attendee.qr_code, access_type: accessType });
            const d = response.data;
            setFeedback({ severity: d.result === 'GRANTED' ? 'success' : d.result === 'LIMITED' ? 'warning' : 'error', message: `${d.result} — ${d.reason || ''}` });
            setResult(d);
            await Promise.all([refreshSearch(), refreshScanLogs()]);
        } catch (err) {
            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not process that scan.' });
        } finally { setBusyId(null); }
    };
    const onCheckInClick = (attendee) => {
        if (isFlaggedStatus(attendee)) { setConfirmFlagged(attendee); return; }
        checkInAttendee(attendee);
    };

    // ── Badge printing ──────────────────────────────────────────────────────
    // Two transactions, always: the check-in commits first and on its own; the
    // print is a separate attempt with its own record. A dead printer can never
    // cost a check-in, and a reprint can never check anyone in twice.
    const rememberStation = (value) => { setStation(value); try { localStorage.setItem(STATION_KEY, value); } catch (e) { /* noop */ } };
    const rememberLabelSize = (value) => { setLabelSize(value); try { localStorage.setItem(LABEL_SIZE_KEY, value); } catch (e) { /* noop */ } };
    const attemptId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random());

    const openLabel = async (attendee, checkedInNow = false) => {
        if (label?.url) URL.revokeObjectURL(label.url);
        setLabel({ attendee, url: null, attemptId: attemptId(), checkedInNow, error: '' });
        try {
            const response = await badgeLabelBlob(eventId, attendee.id, labelSize);
            setLabel((l) => (l && l.attendee.id === attendee.id ? { ...l, url: URL.createObjectURL(response.data) } : l));
        } catch (err) {
            setLabel((l) => (l ? { ...l, error: err.response?.data?.detail || 'Could not render the label.' } : l));
        }
    };
    const closeLabel = () => { if (label?.url) URL.revokeObjectURL(label.url); setLabel(null); };

    // Sends the sticker to whatever printer the browser can reach (the NIIMBOT
    // desktop driver, or a bridge that registers as a system printer). The
    // page is sized to the roll so nothing is scaled.
    const sendToPrinter = () => {
        if (!label?.url) return;
        const [w, h] = labelSize.split('x');   // roll width x length, mm
        const win = window.open('', '_blank', 'width=520,height=360');
        if (!win) { setFeedback({ severity: 'warning', message: 'Pop-up blocked — allow pop-ups for this site to print.' }); return; }
        win.document.write(`<!doctype html><title>Badge label</title><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0}img{display:block;width:${w}mm;height:${h}mm;image-rendering:pixelated}</style><img src="${label.url}" onload="setTimeout(function(){window.print();},150)">`);
        win.document.close();
    };
    const finishPrint = async (result, error = '') => {
        if (!label) return;
        const a = label.attendee;
        try {
            await recordBadgePrint(eventId, a.id, { result, station: station || undefined, error: error || undefined, client_attempt_id: label.attemptId });
            setFeedback(result === 'printed'
                ? { severity: 'success', message: `${fullName(a)} — badge printed${label.checkedInNow ? ' · checked in' : ''}` }
                : { severity: 'warning', message: `${fullName(a)} — ${label.checkedInNow ? '✓ checked in · ' : ''}⚠ badge NOT printed. Use Retry print.` });
            await refreshSearch();
        } catch (err) {
            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not record the print.' });
        }
        if (result === 'printed') closeLabel();
        else setLabel((l) => (l ? { ...l, attemptId: attemptId() } : l));
    };

    // "Check in & print": authorise EVENT_ENTRY, and only THEN open the label.
    const checkInAndPrint = async (attendee) => {
        setBusyId(attendee.id); setConfirmFlagged(null);
        let d = null;
        try {
            const response = await authorizeScan(eventId, { qr_code: attendee.qr_code, access_type: 'EVENT_ENTRY' });
            d = response.data;
            setResult(d);
            await Promise.all([refreshSearch(), refreshScanLogs()]);
        } catch (err) {
            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not process that scan.' });
            setBusyId(null);
            return;
        }
        setBusyId(null);
        if (d.result === 'GRANTED' || d.checked_in) {
            openLabel(attendee, Boolean(d.checked_in_now));
        } else {
            setFeedback({ severity: d.result === 'LIMITED' ? 'warning' : 'error', message: `${d.result} — ${d.reason || ''}. Badge not printed.` });
        }
    };
    const onCheckInAndPrintClick = (attendee) => {
        if (isFlaggedStatus(attendee)) { setConfirmFlagged({ ...attendee, _andPrint: true }); return; }
        checkInAndPrint(attendee);
    };

    const submitUndo = async () => {
        if (!undoTarget) return;
        try {
            await undoCheckIn(eventId, undoTarget.id, undoReason.trim());
            setFeedback({ severity: 'info', message: `${fullName(undoTarget)} — check-in undone (logged).` });
            setUndoTarget(null); setUndoReason('');
            await Promise.all([refreshSearch(), refreshScanLogs()]);
        } catch (err) {
            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not undo.' });
        }
    };

    const fullName = (attendee) => (`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || attendee.email);
    const accessOf = (a) => a && a.effective_access;

    const resultRow = (attendee) => {
        const revealed = revealId === attendee.id;
        const card = physicalCard(attendee);
        const prints = attendee.badge_print_count || 0;
        return (
            <Paper key={attendee.id} variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ md: 'center' }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{fullName(attendee)}</Typography>
                            <Typography variant="caption" color="text.secondary">#{attendee.id}</Typography>
                        </Stack>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                                {revealed ? attendee.email : maskEmail(attendee.email)}
                                {attendee.phone ? ` · ${revealed ? attendee.phone : maskPhone(attendee.phone)}` : ''}
                            </Typography>
                            {!revealed && (
                                <IconButton size="small" title="Reveal contact details" aria-label="Reveal contact details" onClick={() => setRevealId(attendee.id)}>
                                    <VisibilityIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                            )}
                        </Stack>
                        {accessOf(attendee)?.effective_label && (
                            <Typography variant="body2" sx={{ mt: 0.5 }}><strong>{accessOf(attendee).effective_label}</strong></Typography>
                        )}
                        {(attendee.registration_source === 'walk_in' || (attendee.attendance_type && attendee.attendance_type !== 'paid')) && (
                            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                                {attendee.registration_source === 'walk_in' && <Chip size="small" variant="outlined" label="Walk-in" />}
                                {attendee.attendance_type && attendee.attendance_type !== 'paid' && (
                                    <Chip size="small" variant="outlined" color="info" label={attendee.attendance_type} />
                                )}
                                {attendee.door_payment_status === 'collected' && (
                                    <Chip size="small" variant="outlined" color="success"
                                        label={`Paid at door $${Math.round(attendee.door_payment_amount || 0)}`} />
                                )}
                                {attendee.door_payment_status === 'needs_review' && (
                                    <Chip size="small" color="warning" label="Door payment needs review" />
                                )}
                            </Stack>
                        )}
                                                {attendee.card_url && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                Badge card · <span style={{ fontFamily: 'monospace' }}>{attendee.card_url.replace(/^https?:\/\//, '')}</span>
                                {' · '}{attendee.card_state === 'public' ? 'Public' : attendee.card_state === 'private' ? 'Set up, private' : 'Unclaimed'}
                            </Typography>
                        )}
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                            <Chip size="small" label={statusLabel(attendee)} color={isFlaggedStatus(attendee) ? 'warning' : 'default'} />
                            {attendee.is_checked_in
                                ? <Chip size="small" color="success" label="Checked in" />
                                : <Chip size="small" variant="outlined" label="Not checked in" />}
                            <Chip size="small" variant="outlined" color={card === 'VIP' ? 'secondary' : 'primary'} label={`Card: ${card}`} />
                            {prints > 0
                                ? <Chip size="small" color={attendee.badge_last_result === 'failed' ? 'warning' : 'default'} label={`Badge printed ×${prints}`} />
                                : (attendee.badge_last_result === 'failed'
                                    ? <Chip size="small" color="warning" label="⚠ Badge not printed" />
                                    : <Chip size="small" variant="outlined" label="No badge yet" />)}
                        </Stack>
                    </Box>
                    <Stack direction={{ xs: 'row', md: 'column' }} spacing={0.75} sx={{ flexShrink: 0 }} flexWrap="wrap" useFlexGap>
                        {accessType === 'EVENT_ENTRY' && !attendee.is_checked_in ? (
                            <Button variant="contained" startIcon={<HowToRegIcon />} disabled={busyId === attendee.id} onClick={() => onCheckInAndPrintClick(attendee)}>
                                {busyId === attendee.id ? 'Working…' : 'Check in & print'}
                            </Button>
                        ) : (
                            <Button variant="contained" startIcon={<HowToRegIcon />} disabled={busyId === attendee.id} onClick={() => onCheckInClick(attendee)}>
                                {busyId === attendee.id ? 'Scanning…' : `Scan ${ZONES.find((z) => z.value === accessType)?.label.split(' ')[0] || ''}`}
                            </Button>
                        )}
                        <Button variant="outlined" size="small" startIcon={<PrintIcon />} onClick={() => openLabel(attendee, false)}>
                            {prints > 0 ? 'Reprint' : (attendee.badge_last_result === 'failed' ? 'Retry print' : 'Print only')}
                        </Button>
                        {attendee.is_checked_in && (
                            <Button size="small" color="inherit" startIcon={<UndoIcon />} onClick={() => { setUndoTarget(attendee); setUndoReason(''); }}>Undo</Button>
                        )}
                    </Stack>
                </Stack>
            </Paper>
        );
    };

    // The decision card — GRANTED / LIMITED / DENIED, with the same effective access
    // Admin and the member app show, plus the reason and the QR identity.
    /**
     * The scan result, as a person at a door needs it: the verdict first and
     * large, then who it is, then what they hold. The zone grid, badge code and
     * event day are audit facts — kept, one tap away, rather than competing with
     * the three words staff actually read between one person and the next.
     */
    const decisionCard = (d) => {
        // The response says so outright. The REHEARSAL prefix only exists on the
        // logged reason — reading the live decision that way would miss it, and
        // a practice scan that looks like a real admission is the one mistake
        // this banner exists to prevent.
        const rehearsing = Boolean(d.rehearsal);
        const state = rehearsing ? 'REHEARSAL' : (d.result || 'DENIED');
        const v = LOG_STATE[state] || LOG_STATE.DENIED;
        const headline = rehearsing
            ? (d.result === 'GRANTED' ? 'REHEARSAL — WOULD ADMIT' : 'REHEARSAL — WOULD REFUSE')
            : (HEADLINE[d.result] || d.result);
        const reason = String(d.reason || '').replace(/^REHEARSAL\s*—\s*/i, '');
        const addons = d.addons || [];
        return (
            <Paper variant="outlined"
                sx={{ borderColor: `${v.color}.main`, borderWidth: 2, overflow: 'hidden' }}>
                <Box sx={{ px: 2, py: 1.25, bgcolor: `${v.color}.main`,
                           backgroundImage: 'linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55))' }}>
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                        <Typography sx={{ fontSize: 30, lineHeight: 1, color: `${v.color}.main` }}>{v.mark}</Typography>
                        <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '.02em', color: `${v.color}.main` }}>
                            {headline}
                        </Typography>
                    </Stack>
                </Box>
                <Box sx={{ p: 2 }}>
                    {/* An unrecognised badge has no name to show. Saying so beats
                        an empty line that looks like the card failed to load. */}
                    <Typography variant="h5" sx={{ fontWeight: 700, color: d.name ? 'text.primary' : 'text.disabled' }}>
                        {d.name || 'Unknown badge'}
                    </Typography>
                    {d.effective_label && (
                        <Typography variant="body1" color="text.secondary" sx={{ mt: 0.25 }}>
                            {d.effective_label}
                        </Typography>
                    )}
                    <Typography variant="body2" sx={{ mt: 1 }}>{reason}</Typography>

                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
                        {d.checked_in && (
                            <Chip size="small" color="success"
                                  label={d.checked_in_now ? 'Checked in just now' : 'Already checked in'} />
                        )}
                        {d.base_ticket && <Chip size="small" variant="outlined" label={d.base_ticket.name} />}
                        {addons.map((a) => (
                            <Chip key={a.code} size="small" color="success" variant="outlined"
                                  label={`+ ${a.label}${a.day ? ` · ${a.day}` : ' · day not selected'}`} />
                        ))}
                        <Chip size="small" variant="outlined"
                              label={ZONES.find((z) => z.value === d.access_type)?.label || d.access_type} />
                    </Stack>

                    <Button size="small" sx={{ mt: 1.5, px: 0, minWidth: 0 }}
                            onClick={() => setShowDecisionDetail((x) => !x)}>
                        {showDecisionDetail ? 'Hide details' : 'Details'}
                    </Button>
                    {showDecisionDetail && (
                        <Box sx={{ mt: 1 }}>
                            {d.zones && (
                                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                                    <Chip size="small" variant={d.zones.exhibit ? 'filled' : 'outlined'} color={d.zones.exhibit ? 'success' : 'default'} label="Exhibit" />
                                    <Chip size="small" variant={d.zones.conference?.allowed ? 'filled' : 'outlined'} color={d.zones.conference?.allowed ? 'success' : 'default'} label="Conference" />
                                    <Chip size="small" variant={d.zones.workshop ? 'filled' : 'outlined'} color={d.zones.workshop ? 'success' : 'default'} label="Workshops" />
                                    <Chip size="small" variant={d.zones.vip ? 'filled' : 'outlined'} color={d.zones.vip ? 'success' : 'default'} label="VIP" />
                                </Stack>
                            )}
                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block', overflowWrap: 'anywhere' }}>
                                {d.qr_code}{d.event_local_date ? ` · event day ${d.event_local_date}` : ''}
                                {d.result ? ` · result ${d.result}` : ''}
                            </Typography>
                        </Box>
                    )}
                </Box>
            </Paper>
        );
    };

    const zoneLabel = ZONES.find((z) => z.value === accessType)?.label || accessType;
    const zoneNote = accessType === 'EVENT_ENTRY'
        ? 'A granted Event-entry scan checks the attendee in.'
        : 'A zone scan authorizes access to this area only — it does not change check-in state.';

    // A rehearsal scan is a real decision recorded with a REHEARSAL prefix on its
    // reason — the backend writes it that way so the history cannot be misread
    // later. Reading it back the same way keeps the filter honest without
    // inventing a status the audit trail does not have.
    const isRehearsalLog = (log) => /^REHEARSAL/i.test(log.reason || '');
    const logState = (log) => (isRehearsalLog(log) ? 'REHEARSAL' : (log.result || 'DENIED'));
    const cleanReason = (log) => String(log.reason || '').replace(/^REHEARSAL\s*—\s*/i, '');
    const shownLogs = scanLogs.filter((l) => !logFilter || logState(l) === logFilter);
    const logCounts = scanLogs.reduce((a, l) => { const k = logState(l); a[k] = (a[k] || 0) + 1; return a; }, {});

    return (
        <Box>
            {!eventIdFromRoute && (
                <Typography variant="h5" sx={{ mb: 2 }}>Check-In &amp; Access</Typography>
            )}

            {!eventIdFromRoute && (
                <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                    <TextField select fullWidth size="small" label="Which event's door is this?"
                        value={pickedEvent ? pickedEvent.id : ''}
                        onChange={(e) => setPickedEvent(events.find((event) => event.id === Number(e.target.value)) || null)}
                        helperText="Access checks are scoped to one event. Badges from any other event are refused.">
                        {events.map((event) => <MenuItem key={event.id} value={event.id}>{event.name}</MenuItem>)}
                    </TextField>
                </Paper>
            )}

            {!eventId ? (
                <Alert severity="info">Choose an event above to start.</Alert>
            ) : (
                <>
                    {/* ── Station bar ───────────────────────────────────────────
                        Set once at the start of a shift and then left alone, so it
                        reads as a status line rather than a form. Three dropdowns
                        across the top of the page made configuration look like the
                        job; the job is the queue. */}
                    <Paper variant="outlined" sx={{ mb: 2 }}>
                        <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"
                               sx={{ px: 1.5, py: 1 }}>
                            <Chip size="small" color={accessType === 'EVENT_ENTRY' ? 'primary' : 'default'}
                                  variant={accessType === 'EVENT_ENTRY' ? 'filled' : 'outlined'}
                                  label={zoneLabel} sx={{ height: 24 }} />
                            <Typography variant="body2" color="text.secondary">·</Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {station || <Box component="span" sx={{ color: 'text.disabled', fontWeight: 400 }}>Unnamed station</Box>}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">·</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {labelSize.replace('x', ' × ')} mm label
                            </Typography>
                            <Box flexGrow={1} />
                            <Button size="small" onClick={() => setStationOpen((v) => !v)}
                                    endIcon={<TuneIcon fontSize="small" />}>
                                {stationOpen ? 'Done' : 'Station setup'}
                            </Button>
                        </Stack>
                        {stationOpen && (
                            <Box sx={{ px: 1.5, pb: 1.5, pt: 0.5, borderTop: 1, borderColor: 'divider' }}>
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 1.5 }}>
                                    <TextField select size="small" label="This scanner checks" value={accessType}
                                        onChange={(e) => setAccessType(e.target.value)} sx={{ minWidth: 230 }}>
                                        {ZONES.map((z) => <MenuItem key={z.value} value={z.value}>{z.label}</MenuItem>)}
                                    </TextField>
                                    <TextField size="small" label="Station name" placeholder="e.g. Desk A" value={station}
                                        onChange={(e) => rememberStation(e.target.value)} sx={{ minWidth: 170 }}
                                        helperText="Recorded on every print" />
                                    <TextField select size="small" label="Label roll" value={labelSize}
                                        onChange={(e) => rememberLabelSize(e.target.value)} sx={{ minWidth: 150 }}
                                        helperText="Saved on this device">
                                        <MenuItem value="40x60">40 × 60 mm · portrait — in stock</MenuItem>
                                        <MenuItem value="40x50">40 × 50 mm · portrait — design target, roll not sold by NIIMBOT</MenuItem>
                                        <MenuItem value="40x40">40 × 40 mm — in stock</MenuItem>
                                        <MenuItem value="40x30">40 × 30 mm — in stock</MenuItem>
                                        <MenuItem value="50x30">50 × 30 mm · landscape — in stock</MenuItem>
                                    </TextField>
                                </Stack>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{zoneNote}</Typography>
                            </Box>
                        )}
                    </Paper>

                    {/* ── Door status ───────────────────────────────────────────
                        The calendar window is what stops last year's badge opening
                        this year's door, so it is never removed — it is waived,
                        deliberately, for this one event, and said out loud for as
                        long as it is on. */}
                    {doorNotOpenYet && (
                        <Paper variant="outlined" sx={{ mb: 2, borderColor: rehearsal ? 'warning.main' : 'divider',
                                                        bgcolor: rehearsal ? 'warning.dark' : 'transparent',
                                                        ...(rehearsal ? { backgroundImage: 'linear-gradient(rgba(0,0,0,.72),rgba(0,0,0,.72))' } : {}) }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ p: 1.5 }}>
                                <Box sx={{ flex: 1, minWidth: 0 }}>
                                    <Stack direction="row" spacing={1} alignItems="center">
                                        <Box sx={{ width: 8, height: 8, borderRadius: '50%',
                                                   bgcolor: rehearsal ? 'warning.main' : 'text.disabled' }} />
                                        <Typography variant="subtitle2" sx={{ fontWeight: 700,
                                                    color: rehearsal ? 'warning.main' : 'text.primary' }}>
                                            {rehearsal ? 'Rehearsal mode — scans are practice, not admission' : 'Event hasn’t started'}
                                        </Typography>
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                                        {rehearsal
                                            ? 'Every other rule still applies — a refunded ticket, another event’s badge or a single-day pass is refused exactly as on the day. Turn this off before the doors open.'
                                            : 'Real check-in is locked. Practise now rather than in front of a queue.'}
                                    </Typography>
                                </Box>
                                <Button size="small" variant={rehearsal ? 'contained' : 'outlined'}
                                    color={rehearsal ? 'warning' : 'inherit'} disabled={rehearsalBusy}
                                    onClick={async () => {
                                        setRehearsalBusy(true);
                                        try {
                                            const r = await setDoorTestMode(eventId, !rehearsal);
                                            setRehearsal(Boolean(r.data?.door_test_mode));
                                        } catch (e) {
                                            setError(e?.response?.data?.detail || 'Could not change the door mode.');
                                        } finally { setRehearsalBusy(false); }
                                    }}>
                                    {rehearsalBusy ? 'Working…' : (rehearsal ? 'End rehearsal' : 'Start rehearsal')}
                                </Button>
                            </Stack>
                        </Paper>
                    )}

                    {/* Two columns: the door on the left, what just happened on the
                        right. One column meant the last scan scrolled away under the
                        search results. */}
                    <Box sx={{ display: 'grid', gap: 2,
                               gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.35fr) minmax(320px, 1fr)' },
                               alignItems: 'start' }}>
                        <Stack spacing={2} sx={{ minWidth: 0 }}>
                            {/* ── The primary action ───────────────────────────── */}
                            <Paper variant="outlined" sx={{ p: 2 }}>
                                <Button fullWidth size="large"
                                    variant={scanning ? 'outlined' : 'contained'}
                                    color={scanning ? 'inherit' : 'primary'}
                                    startIcon={<QrCodeScannerIcon />}
                                    onClick={() => { setScanning(!scanning); setResult(null); setError(''); }}
                                    sx={{ py: 1.5, fontSize: 16, fontWeight: 700 }}>
                                    {scanning ? 'Stop scanner' : 'Start QR scanner'}
                                </Button>

                                {scanning && (
                                    <Box sx={{ mt: 2 }}><div id="qr-reader" style={{ width: '100%' }}></div></Box>
                                )}

                                <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
                                    <Divider sx={{ flex: 1 }} />
                                    <Typography variant="caption" color="text.disabled">or type the code</Typography>
                                    <Divider sx={{ flex: 1 }} />
                                </Stack>

                                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                                    <TextField value={manualCode} onChange={(e) => setManualCode(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleManualCheckIn(); }}
                                        placeholder="Badge code, e.g. ATT-ABC123" size="small" sx={{ flexGrow: 1 }}
                                        inputProps={{ style: { fontFamily: 'monospace' } }} />
                                    <Button variant="outlined" onClick={handleManualCheckIn} disabled={!manualCode.trim()}>
                                        Authorize
                                    </Button>
                                </Stack>
                            </Paper>

                            {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
                            {result && result.result && decisionCard(result)}

                            {/* ── Find them by name ────────────────────────────── */}
                            <Paper variant="outlined" sx={{ p: 2 }}>
                                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }} gap={1} flexWrap="wrap">
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Find attendee</Typography>
                                    <Button size="small" startIcon={<PersonAddIcon />} onClick={openVisitor}>New visitor</Button>
                                </Stack>
                                <TextField fullWidth size="small" placeholder="Name · email · phone · QR"
                                    value={query} onChange={(e) => setQuery(e.target.value)}
                                    InputProps={{
                                        startAdornment: <InputAdornment position="start">{searching ? <CircularProgress size={18} /> : <SearchIcon fontSize="small" />}</InputAdornment>,
                                        endAdornment: query ? <InputAdornment position="end"><IconButton size="small" onClick={() => setQuery('')} aria-label="Clear search"><ClearIcon fontSize="small" /></IconButton></InputAdornment> : null,
                                    }} />

                                {results !== null && results.length > 0 && (
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                        {results.length} {results.length === 1 ? 'match' : 'matches'} in this event
                                    </Typography>
                                )}
                                {results === null ? (
                                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                                        This event only.
                                    </Typography>
                                ) : results.length === 0 ? (
                                    <Box sx={{ textAlign: 'center', py: 2.5 }}>
                                        <Typography variant="subtitle2" gutterBottom>Nobody here matches that</Typography>
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                                            Buying at the door? Register them here — same badge, card and QR as everyone else.
                                        </Typography>
                                        <Stack direction="row" spacing={1} justifyContent="center">
                                            <Button variant="contained" size="small" startIcon={<PersonAddIcon />} onClick={openVisitor}>New visitor / walk-in</Button>
                                            <Button size="small" onClick={() => setQuery('')}>Clear</Button>
                                        </Stack>
                                    </Box>
                                ) : (
                                    <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                                        {truncated && <Alert severity="info">Showing the first 50 matches — add a surname, email or phone digits to narrow it down.</Alert>}
                                        {results.map(resultRow)}
                                    </Stack>
                                )}
                            </Paper>
                        </Stack>

                        {/* ── Activity ─────────────────────────────────────────── */}
                        <Paper variant="outlined" sx={{ minWidth: 0 }}>
                            <Stack direction="row" justifyContent="space-between" alignItems="center"
                                   sx={{ px: 1.5, pt: 1.5, pb: 1 }} gap={1} flexWrap="wrap">
                                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Recent activity</Typography>
                                <Stack direction="row" spacing={0.5}>
                                    <Button size="small" onClick={refreshScanLogs} disabled={logsLoading}>
                                        {logsLoading ? 'Loading…' : 'Refresh'}
                                    </Button>
                                    {scanLogs.length > 0 && (
                                        <Button size="small" color="error" onClick={() => setClearLogsOpen(true)}>Clear</Button>
                                    )}
                                </Stack>
                            </Stack>

                            {scanLogs.length > 0 && (
                                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ px: 1.5, pb: 1.25 }}>
                                    {[['', 'All', scanLogs.length], ['GRANTED', 'Granted', logCounts.GRANTED || 0],
                                      ['DENIED', 'Denied', logCounts.DENIED || 0], ['LIMITED', 'Limited', logCounts.LIMITED || 0],
                                      ['UNDO', 'Undo', logCounts.UNDO || 0], ['REHEARSAL', 'Rehearsal', logCounts.REHEARSAL || 0]]
                                        .filter(([k, , n]) => k === '' || n > 0)
                                        .map(([k, label, n]) => (
                                            <Chip key={k || 'all'} size="small" label={`${label} ${n}`}
                                                onClick={() => setLogFilter(k)}
                                                color={logFilter === k ? 'primary' : 'default'}
                                                variant={logFilter === k ? 'filled' : 'outlined'}
                                                sx={{ height: 22, fontSize: 11 }} />
                                        ))}
                                </Stack>
                            )}

                            {scanLogs.length === 0 ? (
                                <Box sx={{ px: 1.5, pb: 2 }}>
                                    <Typography variant="body2" color="text.secondary">
                                        Nothing scanned yet. Decisions appear here the moment a badge is read.
                                    </Typography>
                                </Box>
                            ) : (
                                <Box sx={{ maxHeight: { lg: 620 }, overflowY: 'auto' }}>
                                    {shownLogs.map((log, i) => {
                                        const st = logState(log);
                                        const v = LOG_STATE[st] || LOG_STATE.DENIED;
                                        const open = expandedLog === log.id;
                                        return (
                                            <Box key={log.id}
                                                onClick={() => setExpandedLog(open ? null : log.id)}
                                                sx={{ px: 1.5, py: 1, cursor: 'pointer',
                                                      borderTop: i === 0 ? 'none' : '1px solid', borderColor: 'divider',
                                                      '&:hover': { bgcolor: 'action.hover' } }}>
                                                <Stack direction="row" spacing={1.25} alignItems="flex-start">
                                                    {/* A chip, not a whole row of colour: fifty green rows
                                                        make the one red row harder to see, not easier. */}
                                                    <Chip size="small" color={v.color} variant={v.variant}
                                                          label={`${v.mark} ${v.label}`}
                                                          sx={{ height: 22, fontSize: 11, minWidth: 92, flex: '0 0 auto',
                                                                '& .MuiChip-label': { px: 0.75 } }} />
                                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                                        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                                                            {log.attendee_name || 'Unknown badge'}
                                                        </Typography>
                                                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                                                            {cleanReason(log) || 'No reason recorded'}
                                                        </Typography>
                                                    </Box>
                                                    <Typography variant="caption" color="text.secondary"
                                                        sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', pt: 0.25 }}>
                                                        {log.created_at ? formatVenueTime(log.created_at, timezone) : ''}
                                                    </Typography>
                                                </Stack>
                                                {/* The audit detail is kept, one tap away — the door needs
                                                    the name, the review needs the code. */}
                                                {open && (
                                                    <Box sx={{ mt: 1, pl: '104px', display: 'grid',
                                                               gridTemplateColumns: 'auto 1fr', columnGap: 1.5, rowGap: 0.25 }}>
                                                        {[['Zone', ZONES.find((z) => z.value === log.access_type)?.label || log.access_type],
                                                          ['Result', log.result],
                                                          ['Badge', log.qr_code],
                                                          ['Attendee', log.attendee_id ? `#${log.attendee_id}` : 'not matched'],
                                                          ['Recorded', log.created_at],
                                                          ['Full reason', log.reason]].map(([k, val]) => (
                                                            <React.Fragment key={k}>
                                                                <Typography variant="caption" color="text.disabled">{k}</Typography>
                                                                <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                                                                    {val || '—'}
                                                                </Typography>
                                                            </React.Fragment>
                                                        ))}
                                                    </Box>
                                                )}
                                            </Box>
                                        );
                                    })}
                                    {shownLogs.length === 0 && (
                                        <Box sx={{ px: 1.5, py: 2 }}>
                                            <Typography variant="body2" color="text.secondary">Nothing with that status.</Typography>
                                        </Box>
                                    )}
                                </Box>
                            )}
                        </Paper>
                    </Box>
                </>
            )}


            {/* Label preview. Check-in (if any) has already committed; this only prints. */}
            <Dialog open={Boolean(label)} onClose={closeLabel} maxWidth="sm" fullWidth>
                <DialogTitle>
                    {label ? fullName(label.attendee) : ''}
                    {label?.checkedInNow && <Chip size="small" color="success" label="✓ Checked in" sx={{ ml: 1 }} />}
                </DialogTitle>
                <DialogContent dividers>
                    {label && (
                        <Stack spacing={1.5} alignItems="center">
                            <Typography variant="body2" color="text.secondary" alignSelf="flex-start">
                                Hand over the <strong>{physicalCard(label.attendee)}</strong> card. Sticker: {labelSize.replace('x', ' × ')} mm — full name over the badge QR, nothing else.
                            </Typography>
                            <Box sx={{ p: 2, bgcolor: '#fff', borderRadius: 1, border: '1px solid', borderColor: 'divider', width: '100%', display: 'flex', justifyContent: 'center' }}>
                                {label.url
                                    ? <img src={label.url} alt="Badge label preview" style={{ maxWidth: '100%', maxHeight: 420, imageRendering: 'pixelated' }} />
                                    : (label.error ? <Alert severity="error">{label.error}</Alert> : <CircularProgress size={28} />)}
                            </Box>
                            <Typography variant="caption" color="text.secondary" alignSelf="flex-start">
                                Print, then tell the system what happened. A failed print never undoes the check-in; a reprint never checks anyone in twice.
                            </Typography>
                        </Stack>
                    )}
                </DialogContent>
                <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                    <Button onClick={closeLabel}>Close</Button>
                    {label?.url && <Button component="a" href={label.url} download={`badge-${label.attendee.qr_code}.png`}>Download PNG</Button>}
                    <Button variant="outlined" startIcon={<PrintIcon />} disabled={!label?.url} onClick={sendToPrinter}>Print</Button>
                    <Button color="warning" onClick={() => finishPrint('failed', 'Operator reported a failed print')}>Mark failed</Button>
                    <Button variant="contained" color="success" onClick={() => finishPrint('printed')}>Printed ✓</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={clearLogsOpen} onClose={() => setClearLogsOpen(false)}>
                <DialogTitle>Clear the scan history?</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        This deletes all {scanLogs.length} recorded access decisions for this event and cannot be undone.
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        It does not change anyone&rsquo;s check-in state, their badge, or their ticket — only the log of
                        who was scanned at which door. Clear it after a rehearsal so the real event starts on a
                        clean sheet.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setClearLogsOpen(false)}>Cancel</Button>
                    <Button color="error" variant="contained" disabled={clearing} onClick={async () => {
                        setClearing(true);
                        try {
                            await clearScanLogs(eventId);
                            await refreshScanLogs();
                            setClearLogsOpen(false);
                        } catch (e) {
                            setError(e?.response?.data?.detail || 'Could not clear the scan history.');
                        } finally { setClearing(false); }
                    }}>{clearing ? 'Clearing…' : 'Clear history'}</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={Boolean(undoTarget)} onClose={() => setUndoTarget(null)}>
                <DialogTitle>Undo check-in</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                        {undoTarget ? fullName(undoTarget) : ''} will be marked not checked in. This is logged with your reason.
                    </Typography>
                    <TextField autoFocus fullWidth size="small" label="Reason" placeholder="e.g. wrong person scanned" value={undoReason} onChange={(e) => setUndoReason(e.target.value)} />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setUndoTarget(null)}>Cancel</Button>
                    <Button variant="contained" color="warning" disabled={undoReason.trim().length < 3} onClick={submitUndo}>Undo check-in</Button>
                </DialogActions>
            </Dialog>

            {/* New visitor at the door. Same record, same card, same QR as anyone
                who bought online months ago — there is no walk-in tier. */}
            <Dialog open={Boolean(visitor)} onClose={() => !visitorBusy && setVisitor(null)} maxWidth="sm" fullWidth>
                <DialogTitle>New visitor</DialogTitle>
                <DialogContent dividers>
                    {visitorMatches ? (
                        <>
                            <Alert severity="warning" sx={{ mb: 2 }}>
                                Somebody with these details already has a Gaia badge card. Adding them again would give them a second one.
                            </Alert>
                            <Stack spacing={1.5}>
                                {visitorMatches.map((m) => (
                                    <Paper key={m.token || m.attendee_id} variant="outlined" sx={{ p: 1.5 }}>
                                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
                                            <Box sx={{ minWidth: 0 }}>
                                                <Typography variant="subtitle2">{m.name}</Typography>
                                                <Typography variant="caption" color="text.secondary" display="block">
                                                    {m.email_masked}{m.phone_masked ? ` · ${m.phone_masked}` : ''}
                                                </Typography>
                                                <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
                                                    <Chip size="small" variant="outlined" label={m.why} />
                                                    {m.event_name && <Chip size="small" variant="outlined" label={m.this_event ? 'This event' : m.event_name} />}
                                                    {m.card_claimed && <Chip size="small" color="success" label="Card set up" />}
                                                </Stack>
                                            </Box>
                                            <Button variant="contained" size="small" disabled={visitorBusy || !m.token}
                                                onClick={() => submitVisitor({ link_token: m.token })}>
                                                This is them
                                            </Button>
                                        </Stack>
                                    </Paper>
                                ))}
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                                Picking someone adds this event to the card they already have. Their QR and card stay exactly as they are.
                            </Typography>
                        </>
                    ) : (
                        <Stack spacing={2} sx={{ mt: 0.5 }}>
                            {visitorError && <Alert severity="error">{visitorError}</Alert>}

                            <Box>
                                <Typography variant="subtitle2" gutterBottom>Why do they need a badge?</Typography>
                                <Stack spacing={1}>
                                    {DOOR_REASONS.map((r) => (
                                        <Paper key={r.key} variant="outlined"
                                            onClick={() => setVisitor({ ...visitor, reason: r.key,
                                                attendance_type: r.attendance_type,
                                                door_payment_status: r.door_payment_status })}
                                            sx={{ p: 1.25, cursor: 'pointer',
                                                  borderColor: visitor?.reason === r.key ? 'primary.main' : 'divider',
                                                  bgcolor: visitor?.reason === r.key ? 'action.selected' : 'transparent' }}>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.label}</Typography>
                                            <Typography variant="caption" color="text.secondary">{r.hint}</Typography>
                                        </Paper>
                                    ))}
                                </Stack>
                            </Box>

                            {visitor?.reason === 'already_paid' && (
                                <Alert severity="info">
                                    Try searching once more by their email before creating a record — if they are already
                                    in the system, checking them in keeps everything tidier than a second registration.
                                </Alert>
                            )}
                            {visitor?.reason === 'crew' && (
                                <TextField select label="Role" fullWidth size="small" value={visitor?.attendance_type || 'staff'}
                                    onChange={(e) => setVisitor({ ...visitor, attendance_type: e.target.value })}>
                                    <MenuItem value="staff">Staff</MenuItem>
                                    <MenuItem value="speaker">Speaker</MenuItem>
                                    <MenuItem value="exhibitor">Exhibitor</MenuItem>
                                </TextField>
                            )}
                            {visitor?.reason === 'pay_at_door' && (
                                <Paper variant="outlined" sx={{ p: 1.5 }}>
                                    <Typography variant="subtitle2" gutterBottom>Door payment</Typography>
                                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                        <TextField label="Amount" required size="small" type="number" sx={{ maxWidth: 140 }}
                                            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                                            value={visitor?.door_payment_amount || ''}
                                            onChange={(e) => setVisitor({ ...visitor, door_payment_amount: e.target.value })} />
                                        <TextField select label="Method" size="small" fullWidth
                                            value={visitor?.door_payment_method || 'cash'}
                                            onChange={(e) => setVisitor({ ...visitor, door_payment_method: e.target.value })}>
                                            <MenuItem value="cash">Cash</MenuItem>
                                            <MenuItem value="card_terminal">Card terminal</MenuItem>
                                            <MenuItem value="payment_link">Payment link</MenuItem>
                                            <MenuItem value="other">Other</MenuItem>
                                        </TextField>
                                        <TextField label="Receipt no." size="small" fullWidth
                                            value={visitor?.door_payment_reference || ''}
                                            onChange={(e) => setVisitor({ ...visitor, door_payment_reference: e.target.value })} />
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                        Recorded by Gaia only. It is reported separately from GHL revenue and never added to it.
                                    </Typography>
                                </Paper>
                            )}

                            <Divider />
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                <TextField label="First name" required fullWidth size="small" autoFocus
                                    value={visitor?.first_name || ''} onChange={(e) => setVisitor({ ...visitor, first_name: e.target.value })} />
                                <TextField label="Last name" fullWidth size="small"
                                    value={visitor?.last_name || ''} onChange={(e) => setVisitor({ ...visitor, last_name: e.target.value })} />
                            </Stack>
                            <TextField label="Email" required fullWidth size="small" type="email"
                                helperText="Their sign-in link goes here, and it is how we tell them apart from an existing member."
                                value={visitor?.email || ''} onChange={(e) => setVisitor({ ...visitor, email: e.target.value })} />
                            <TextField label="Phone" required fullWidth size="small" type="tel"
                                helperText="Every badge card carries a name, an email and a phone. Without it their card can never be published."
                                value={visitor?.phone || ''} onChange={(e) => setVisitor({ ...visitor, phone: e.target.value })} />
                            <TextField select label="Ticket" fullWidth size="small" value={visitor?.ticket_type_id || ''}
                                onChange={(e) => setVisitor({ ...visitor, ticket_type_id: e.target.value })}>
                                <MenuItem value="">Decide later</MenuItem>
                                {ticketTypes.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
                            </TextField>
                            <TextField label={visitor?.reason === 'complimentary' ? 'Who authorised this? (required)' : 'Note (optional)'}
                                fullWidth size="small" required={visitor?.reason === 'complimentary'}
                                value={visitor?.note || ''} onChange={(e) => setVisitor({ ...visitor, note: e.target.value })} />
                            <Alert severity="info" icon={false}>
                                This creates a Gaia record only. No contact, order or payment is written to GHL.
                            </Alert>
                        </Stack>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setVisitor(null)} disabled={visitorBusy}>Cancel</Button>
                    {visitorMatches ? (
                        <Button variant="outlined" color="warning" disabled={visitorBusy}
                            onClick={() => submitVisitor({ confirm_new: true })}>
                            None of these — register as new
                        </Button>
                    ) : (
                        <Button variant="contained" onClick={() => submitVisitor()}
                            disabled={visitorBusy || !visitor?.reason || !visitor?.first_name?.trim() || !visitor?.email?.trim() || !visitor?.phone?.trim()
                                || (visitor?.reason === 'pay_at_door' && !(Number(visitor?.door_payment_amount) > 0))
                                || (visitor?.reason === 'complimentary' && !visitor?.note?.trim())}>
                            {visitorBusy ? 'Checking…' : 'Register'}
                        </Button>
                    )}
                </DialogActions>
            </Dialog>

            <Dialog open={Boolean(confirmFlagged)} onClose={() => setConfirmFlagged(null)}>
                <DialogTitle>This registration is {confirmFlagged ? statusLabel(confirmFlagged).toLowerCase() : ''}</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary">
                        {confirmFlagged ? fullName(confirmFlagged) : ''} is marked <strong>{confirmFlagged ? statusLabel(confirmFlagged) : ''}</strong> for this event.
                        The backend will still make the final access decision.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmFlagged(null)}>Cancel</Button>
                    {confirmFlagged?._andPrint && (
                        <Button variant="contained" onClick={() => checkInAndPrint(confirmFlagged)}>Check in &amp; print anyway</Button>
                    )}
                    <Button variant="contained" color="warning" onClick={() => checkInAttendee(confirmFlagged)}>Scan anyway</Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={Boolean(feedback)} autoHideDuration={4000} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
                {feedback ? <Alert severity={feedback.severity}>{feedback.message}</Alert> : undefined}
            </Snackbar>
        </Box>
    );
}

export default CheckIn;
