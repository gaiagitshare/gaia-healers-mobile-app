import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress,
    Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton, Switch,
    InputAdornment, MenuItem, Paper, Snackbar, Stack, TextField, Typography, useMediaQuery, useTheme,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import HowToRegIcon from '@mui/icons-material/HowToReg';
import PrintIcon from '@mui/icons-material/Print';
import UndoIcon from '@mui/icons-material/Undo';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import EditIcon from '@mui/icons-material/Edit';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import BlockIcon from '@mui/icons-material/Block';
import RestoreIcon from '@mui/icons-material/Restore';
import GroupsIcon from '@mui/icons-material/Groups';
import TuneIcon from '@mui/icons-material/Tune';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { authorizeScan, getScanLogs, searchAttendees, getEvents, walkInCreate, getTicketTypes, undoCheckIn, clearScanLogs, setDoorTestMode, getEvent, badgeLabelBlob, recordBadgePrint,
    overrideAdmit, doorIdentity, addPartySeat, setReEntry as setDoorReEntry, changePass, revokeAttendee, reinstateAttendee,
    getMyCapabilities, getPrintReport } from '../utils/api';
import { formatVenueTime, statusLabel, isFlaggedStatus } from '../utils/datetime';
import BadgeLabelDialog, { STATION_KEY, LABEL_SIZE_KEY, LABEL_ROLLS, savedLabelSize, rollShort, fullName, physicalCard,
    canPrintBluetooth, useB1, b1Connect, b1IsConnected, b1Enqueue, b1PrintBlob, b1Dpi, rollFitsB1, PRINTER_KEY, PRINTER_CHOICES, savedPrinter } from './BadgeLabelDialog';
import BluetoothIcon from '@mui/icons-material/Bluetooth';

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
    OVERRIDE:  { label: 'Let in',    mark: '⚠', color: 'warning', variant: 'filled' },
    REHEARSAL: { label: 'Rehearsal', mark: '◐', color: 'warning', variant: 'filled' },
};
const HEADLINE = {
    GRANTED: 'ADMITTED', LIMITED: 'CHECK THIS ONE', DENIED: 'DENIED', UNDO: 'UNDONE',
    OVERRIDE: 'LET IN ANYWAY',
};
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
        { key: 'already_paid', needs: 'register_paying_walk_in',
          label: 'Already paid — can’t find them',
          hint: 'Usually a sync delay. Their GHL order will reconcile onto this record when it arrives.',
          attendance_type: 'paid', door_payment_status: 'none' },
        { key: 'pay_at_door', needs: 'register_paying_walk_in',
          label: 'Paying at the door',
          hint: 'Recorded as a Gaia door payment. Nothing is written to GHL — take the money on your usual till.',
          attendance_type: 'paid', door_payment_status: 'collected' },
        { key: 'complimentary', needs: 'register_free_badge',
          label: 'Complimentary / guest',
          hint: 'No payment expected. Say who authorised it.',
          attendance_type: 'complimentary', door_payment_status: 'waived' },
        { key: 'crew', needs: 'register_free_badge',
          label: 'Staff / speaker / exhibitor',
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
    // One badge, more than one entry. Off, the second scan of the same badge is
    // refused — which is right for a one-session gate and wrong for a three-day
    // conference the moment anybody steps out for lunch.
    const [reEntry, setReEntry] = useState(false);
    const [reEntryBusy, setReEntryBusy] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [revealId, setRevealId] = useState(null);
    const [station, setStation] = useState(() => { try { return localStorage.getItem(STATION_KEY) || ''; } catch (e) { return ''; } });
    const [labelSize, setLabelSize] = useState(savedLabelSize);
    // The label preview: check-in has ALREADY committed by the time this opens.
    const [labelReq, setLabelReq] = useState(null);   // { attendee, checkedInNow, labelSize } → BadgeLabelDialog
    // ── Straight-through printing ──────────────────────────────────────────
    // A queue at the door is the whole reason the sticker exists, so the
    // default is: scan → admitted → sticker comes out of the B1, nothing
    // tapped. The desk pairs the printer once per shift (the browser needs a
    // tap for that); after that every admitted scan prints by itself. The
    // dialog stays as the fallback for anything the automatic path cannot do.
    const AUTO_PRINT_KEY = 'gha_auto_print';
    const [autoPrint, setAutoPrint] = useState(() => { try { return localStorage.getItem(AUTO_PRINT_KEY) !== '0'; } catch (e) { return true; } });
    const rememberAutoPrint = (on) => { setAutoPrint(on); try { localStorage.setItem(AUTO_PRINT_KEY, on ? '1' : '0'); } catch (e) { /* noop */ } };
    const printer = useB1();
    const [printerBusy, setPrinterBusy] = useState(false);      // the Connect button
    const [connectAny, setConnectAny] = useState(false);        // after an empty chooser: the next tap lists every nearby device
    const [printerHint, setPrinterHint] = useState('');
    const [printerModel, setPrinterModel] = useState(savedPrinter);
    const rememberPrinterModel = (v) => { setPrinterModel(v); try { localStorage.setItem(PRINTER_KEY, v); } catch (e) { /* noop */ } };
    // What happened to the sticker for the person on screen: { attendeeId, phase, message }
    const [autoJob, setAutoJob] = useState(null);
    const printedIds = useRef(new Set());                        // printed this session — a re-scan never prints twice
    const [undoTarget, setUndoTarget] = useState(null);
    // ── Fixing things at the desk ───────────────────────────────────────────
    // Five things go wrong at a door, and all five have to be fixable without
    // leaving this screen: the rules refuse somebody who should be let in, the
    // name on a seat is the buyer's guess, they bought the wrong pass, the
    // badge should not work at all, or it should work again. Each opens one
    // dialog, each writes one audited change, and each hands back a fresh
    // decision so the screen never shows a stale verdict.
    const [doorAction, setDoorAction] = useState(null);   // { kind, decision, ... }
    const [doorBusy, setDoorBusy] = useState(false);
    const [doorError, setDoorError] = useState('');
    const [fixForm, setFixForm] = useState({ first_name: '', last_name: '', phone: '', email: '' });
    const [actionReason, setActionReason] = useState('');
    const [passChoice, setPassChoice] = useState('');
    // An upgrade bought at the desk is real money. Recording it as
    // complimentary because there was nowhere to type the amount is how a
    // weekend's takings end up short.
    const [passPaid, setPassPaid] = useState(false);
    const [passAmount, setPassAmount] = useState('');
    const [passMethod, setPassMethod] = useState('cash');
    const [undoReason, setUndoReason] = useState('');
    const [stationOpen, setStationOpen] = useState(false);
    // A print from a desk with no name tells you it happened and not where. That
    // only matters once there is more than one desk — which is the day it stops
    // being possible to go back and ask. So the name is collected once, at the
    // moment of the first print, instead of being a field somebody was supposed
    // to have filled in earlier.
    const [namePrompt, setNamePrompt] = useState(null);   // the print waiting on a name
    const STATION_PRESETS = ['Desk 1', 'Desk 2', 'Desk 3', 'Registration', 'VIP desk', 'Exhibitor desk'];
    const [logFilter, setLogFilter] = useState('');
    const [expandedLog, setExpandedLog] = useState(null);
    // Below lg the activity feed sits UNDER the search results, not beside them,
    // so a hundred rows there is a wall the operator scrolls past to find the
    // queue. Folded until asked for, and paged once open.
    const sideBySide = useMediaQuery(useTheme().breakpoints.up('lg'));
    const [activityOpen, setActivityOpen] = useState(false);
    // The print log has always been written and never read. Reading it back is
    // what makes naming a desk worth doing.
    const [printReport, setPrintReport] = useState(null);
    const [printOpen, setPrintOpen] = useState(false);
    const refreshPrintReport = () => {
        if (!eventId) { setPrintReport(null); return; }
        getPrintReport(eventId).then((r) => setPrintReport(r.data || null)).catch(() => setPrintReport(null));
    };
    useEffect(() => { refreshPrintReport(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);
    const [activityLimit, setActivityLimit] = useState(25);
    const [showDecisionDetail, setShowDecisionDetail] = useState(false);

    // The door's own state: has this event started, and is a rehearsal running.
    const [doorEvent, setDoorEvent] = useState(null);
    // What this operator may do here, asked once. The walk-in form has no badge
    // behind it, so it cannot wait for a scan to find out.
    const [may, setMay] = useState(null);
    useEffect(() => {
        if (!eventId) { setMay(null); return; }
        getMyCapabilities(eventId).then((r) => setMay(r.data?.may || null)).catch(() => setMay(null));
    }, [eventId]);
    useEffect(() => {
        if (!eventId) { setDoorEvent(null); return; }
        getEvent(eventId)
            .then((r) => { setDoorEvent(r.data); setRehearsal(Boolean(r.data?.door_test_mode)); setReEntry(Boolean(r.data?.allow_reentry)); })
            .catch(() => setDoorEvent(null));
    }, [eventId]);
    const doorNotOpenYet = (() => {
        const start = doorEvent?.start_date;
        const end = doorEvent?.end_date || start;
        if (!start) return false;
        const today = new Date().toISOString().slice(0, 10);
        return today < String(start).slice(0, 10) || today > String(end).slice(0, 10);
    })();

    // ── Which door is this, before anybody asks ────────────────────────────
    // The screen used to open empty, so the first thing a staffer did on the
    // morning of the event was pick the right conference out of a list that
    // also contains last year's. Getting that wrong refuses everybody, and the
    // person it refuses is standing in front of them.
    //
    // So it picks, but only when there is nothing to get wrong: exactly one
    // event that is live and not archived. Two live events is a real question
    // and it stays a question — a guess there is the same mistake in a nicer
    // coat. A deliberate choice is remembered on this device, so somebody who
    // switched to another door keeps it when the page reloads.
    const DOOR_EVENT_KEY = 'gha_door_event';
    const [autoPicked, setAutoPicked] = useState(false);
    useEffect(() => {
        if (eventIdFromRoute) return;
        getEvents().then((response) => {
            const rows = response.data || [];
            setEvents(rows);
            setPickedEvent((current) => {
                if (current) return current;
                let remembered = null;
                try { remembered = localStorage.getItem(DOOR_EVENT_KEY); } catch (e) { /* noop */ }
                const kept = rows.find((ev) => String(ev.id) === String(remembered) && !ev.is_archived);
                if (kept) return kept;
                const live = rows.filter((ev) => ev.is_active && !ev.is_archived);
                if (live.length === 1) { setAutoPicked(true); return live[0]; }
                return null;
            });
        }).catch(() => setEvents([]));
    }, [eventIdFromRoute]);
    const chooseEvent = (ev) => {
        setPickedEvent(ev); setAutoPicked(false);
        try {
            if (ev) localStorage.setItem(DOOR_EVENT_KEY, String(ev.id));
            else localStorage.removeItem(DOOR_EVENT_KEY);
        } catch (e) { /* noop */ }
    };

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

    // The camera comes back 2 s after a read, and the badge is usually still
    // in front of it. Re-reading the same code then sent a second scan that
    // came back "already checked in" and replaced the ADMITTED card with a
    // refusal — which looked like the check-in had failed. The same code is
    // ignored for a while after it was acted on; a different badge goes
    // through at once.
    const lastRead = useRef({ code: '', at: 0 });
    const REPEAT_READ_MS = 15000;
    const onScanSuccess = async (decodedText) => {
        const code = String(decodedText || '').trim();
        const now = Date.now();
        if (code && code === lastRead.current.code && now - lastRead.current.at < REPEAT_READ_MS) return;
        lastRead.current = { code, at: now };
        if (scannerRef.current) scannerRef.current.pause();
        await runScan(code);
    };
    const onScanError = () => {};

    const runScan = async (qrCode) => {
        setError(''); setResult(null);
        if (!eventId) { setError('Choose an event first — a scan always belongs to one event.'); return; }
        try {
            const response = await authorizeScan(eventId, {
                qr_code: qrCode, access_type: accessType,
            });
            const d = response.data;
            setResult(d); setAutoJob(null);
            // A fresh check-in always prints — once per check-in, so an undo
            // and a re-scan print again. An admitted re-scan of someone already
            // checked in prints only if they never got a sticker.
            const freshCheckIn = Boolean(d.checked_in_now);
            const neverPrinted = !printedIds.current.has(d.attendee_id) && !(Number(d.badge_print_count) > 0);
            if (d.result === 'GRANTED' && d.access_type === 'EVENT_ENTRY' && d.attendee_id && (freshCheckIn || neverPrinted)) {
                if (canAutoPrint()) autoPrintBadge(attendeeFromDecision(d), Boolean(d.checked_in_now));
                else if (autoPrint) setAutoJob({ attendeeId: d.attendee_id, phase: 'failed',
                    message: canPrintBluetooth() ? 'Badge not printed — printer not connected. Tap Connect printer, or print from here.' : 'Badge not printed here — print from the button below.' });
            }
            refreshScanLogs();
            // The camera comes back as soon as the same code cannot be read
            // twice; the sticker prints in the background while the next
            // person steps up.
            setTimeout(() => { if (scannerRef.current && scanning) scannerRef.current.resume(); }, 2000);
        } catch (err) {
            setError(err.response?.data?.detail || 'Scan failed');
        }
    };

    const handleManualCheckIn = () => {
        if (manualCode.trim()) { lastRead.current = { code: '', at: 0 }; runScan(manualCode.trim()); setManualCode(''); }
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
    const openLabel = (attendee, checkedInNow = false) => setLabelReq({ attendee, checkedInNow, labelSize });
    const closeLabel = () => setLabelReq(null);
    const canAutoPrint = () => autoPrint && canPrintBluetooth() && b1IsConnected() && rollFitsB1(labelSize);
    const connectPrinter = async () => {
        setPrinterBusy(true); setPrinterHint('');
        try {
            const info = await b1Connect(connectAny);
            setConnectAny(false);
            setFeedback({ severity: 'success', message: `${(info && info.label) || 'Printer'} connected (${(info && info.dpi) || 203} dpi) — admitted scans now print by themselves.` });
        } catch (err) {
            if (err && err.name === 'NotFoundError') {
                // Nothing picked — usually an empty list. Next tap casts the wide
                // net, and the three things that empty the list are spelled out.
                setConnectAny(true);
                setPrinterHint('No printer picked. Tap “Show all devices” and look for “B1 Pro-…” or “B1-…”. If it is not there either: (1) hold the printer’s power button until its light is on, (2) close the NIIMBOT app completely — a printer it holds is invisible to everyone else, (3) on iPhone check Settings → Bluefy → Bluetooth is on.');
            } else {
                setPrinterHint(`Could not connect: ${(err && err.message) || err}`);
            }
        } finally { setPrinterBusy(false); }
    };
    // Print without the dialog: render, queue on the B1, record. Any failure
    // is recorded as one and the decision card offers the dialog instead.
    const autoPrintBadge = async (attendee, checkedInNow) => {
        const id = attendee.id; const name = fullName(attendee);
        if (checkedInNow) printedIds.current.delete(id);   // a new check-in is a new sticker
        const attemptId = (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random());
        setAutoJob({ attendeeId: id, phase: 'queued', message: printer.busy ? `Badge queued behind ${printer.current}` : 'Printing badge…' });
        try {
            const response = await badgeLabelBlob(eventId, id, labelSize, 'roll', b1Dpi());   // dot-exact for the paired printer (203 B1 / 300 B1 Pro)
            await b1Enqueue(name, async () => {
                setAutoJob({ attendeeId: id, phase: 'printing', message: 'Printing badge…' });
                await b1PrintBlob(response.data, { onProgress: (st) => setAutoJob({ attendeeId: id, phase: 'printing', message: `Badge: ${st}` }) });
            });
            printedIds.current.add(id);
            refreshPrintReport();
            setAutoJob({ attendeeId: id, phase: 'printed', message: checkedInNow ? 'Checked in · badge printed' : 'Badge printed' });
            try { await recordBadgePrint(eventId, id, { result: 'printed', station: station || undefined, client_attempt_id: attemptId }); } catch (e) { /* the sticker is out; the record can be re-tried from the row */ }
            refreshSearch();
        } catch (err) {
            const why = (err && err.message) || String(err || 'print failed');
            setAutoJob({ attendeeId: id, phase: 'failed', message: `Badge not printed — ${why.length > 120 ? why.slice(0, 117) + '…' : why}` });
            try { await recordBadgePrint(eventId, id, { result: 'failed', station: station || undefined, error: `auto: ${why}`.slice(0, 200), client_attempt_id: attemptId }); } catch (e) { /* noop */ }
        }
    };
    // The one entry point for "print this person's badge": automatic when it
    // can be, the dialog when it cannot (no printer paired, Bluetooth off,
    // a roll the B1 cannot take).
    const printBadge = (attendee, checkedInNow = false) => {
        if (!station.trim()) { setNamePrompt({ attendee, checkedInNow }); return; }
        if (canAutoPrint()) autoPrintBadge(attendee, checkedInNow);
        else openLabel(attendee, checkedInNow);
    };
    // Named, then the print carries straight on — the badge is still the thing
    // being asked for.
    const nameStationAndPrint = (value) => {
        const name = (value || '').trim();
        if (!name) return;
        rememberStation(name);
        const waiting = namePrompt;
        setNamePrompt(null);
        if (!waiting) return;
        if (canAutoPrint()) autoPrintBadge(waiting.attendee, waiting.checkedInNow);
        else openLabel(waiting.attendee, waiting.checkedInNow);
    };
    const attendeeFromDecision = (d) => ({
        id: d.attendee_id, qr_code: d.qr_code,
        first_name: d.first_name || d.name || '', last_name: d.last_name || '',
        effective_access: { base_ticket: d.base_ticket },
    });

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
            setAutoJob(null);
            printBadge(attendee, Boolean(d.checked_in_now));
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

    // ── Door actions ────────────────────────────────────────────────────────
    const openDoorAction = (kind, d) => {
        setDoorAction({ kind, decision: d });
        setDoorError(''); setActionReason('');
        const card = d.door || {};
        setFixForm(kind === 'addseat'
            ? { first_name: '', last_name: '', phone: '', email: '' }
            : { first_name: d.first_name || '', last_name: d.last_name || '',
                phone: card.phone || '', email: card.email || '' });
        setPassChoice(card.ticket_type_id ? String(card.ticket_type_id) : '');
        // The desk can only SELL an upgrade, so their dialog opens on "paying"
        // and stays there. An organiser gets the choice.
        setPassPaid(!card.may || card.may.comp !== true);
        setPassAmount(''); setPassMethod('cash');
    };
    const closeDoorAction = () => { setDoorAction(null); setDoorError(''); };

    // After any correction the screen must agree with the database again, so
    // every action ends by re-asking the backend for the decision rather than
    // patching the card in place.
    const rescanCurrent = async (d, zone) => {
        try {
            const again = await authorizeScan(eventId, { qr_code: d.qr_code, access_type: zone || d.access_type || accessType });
            setResult(again.data);
            return again.data;
        } catch (err) { return null; }
    };

    const runDoorAction = async (fn, message, { rescan = true } = {}) => {
        const d = doorAction?.decision;
        if (!d) return;
        setDoorBusy(true); setDoorError('');
        try {
            const out = await fn(d);
            closeDoorAction();
            if (rescan) await rescanCurrent(d);
            else if (out) setResult(out);
            await Promise.all([refreshSearch(), refreshScanLogs()]);
            setFeedback({ severity: 'success', message });
        } catch (err) {
            setDoorError(err.response?.data?.detail || 'That did not go through. Nothing was changed.');
        } finally { setDoorBusy(false); }
    };

    const submitOverride = () => runDoorAction(
        async (d) => {
            const response = await overrideAdmit(eventId, d.attendee_id, {
                reason: actionReason.trim(), access_type: d.access_type || accessType,
            });
            return response.data;
        },
        'Let in, and logged with your reason.',
        { rescan: false });

    const submitFix = () => runDoorAction(
        async (d) => {
            const before = d.door || {};
            const body = { reason: actionReason.trim() || undefined };
            if (fixForm.first_name.trim() !== (d.first_name || '')) body.first_name = fixForm.first_name.trim();
            if (fixForm.last_name.trim() !== (d.last_name || '')) body.last_name = fixForm.last_name.trim();
            if (fixForm.phone.trim() !== (before.phone || '')) body.phone = fixForm.phone.trim();
            if (fixForm.email.trim().toLowerCase() !== (before.email || '').toLowerCase()) body.email = fixForm.email.trim();
            await doorIdentity(eventId, d.attendee_id, body);
        },
        'Details corrected. Print the badge again so it carries the right name.');

    const submitPassChange = () => runDoorAction(
        async (d) => {
            await changePass(d.attendee_id, {
                ticket_type_id: Number(passChoice),
                reason: actionReason.trim() || 'changed at the door',
                complimentary: !passPaid, allow_downgrade: true,
                paid_at_door: passPaid,
                amount: passPaid ? Number(passAmount) : undefined,
                method: passPaid ? passMethod : undefined,
            });
        },
        'Pass changed. Print the badge again so it shows the new one.');

    // Finish a party the order paid for but never named. The backend refuses
    // once the badges match what was bought, so this can only ever complete a
    // booking — never inflate one.
    const submitAddSeat = () => runDoorAction(
        async (d) => {
            const response = await addPartySeat(eventId, d.attendee_id, {
                first_name: fixForm.first_name.trim(), last_name: fixForm.last_name.trim(),
                phone: fixForm.phone.trim() || undefined,
                reason: actionReason.trim() || undefined,
            });
            const made = response.data || {};
            // Land on the new badge and print it. Naming somebody at the desk is
            // not a filing exercise — they are standing there waiting for the
            // sticker, and a second tap to produce it is a second queue.
            const again = await authorizeScan(eventId, { qr_code: made.qr_code, access_type: accessType });
            const fresh = again.data;
            if (fresh?.attendee_id) {
                setAutoJob(null);
                printBadge(attendeeFromDecision(fresh), false);
            }
            return fresh;
        },
        'Seat named — their badge is printing.',
        { rescan: false });

    const submitRevoke = () => runDoorAction(
        async (d) => { await revokeAttendee(d.attendee_id, actionReason.trim()); },
        'Badge revoked. It will be refused at every door from now on.');

    const submitReinstate = () => runDoorAction(
        async (d) => { await reinstateAttendee(d.attendee_id, actionReason.trim()); },
        'Badge is valid again.');

    // Pull up anybody else on the same booking without asking for their badge —
    // a family arrives together and only one of them is holding a phone.
    const openPartyMember = async (member) => {
        setError('');
        try {
            const response = await authorizeScan(eventId, { qr_code: member.qr_code, access_type: accessType });
            setResult(response.data); setAutoJob(null);
            refreshScanLogs();
        } catch (err) {
            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not open that seat.' });
        }
    };

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
                        {attendee.paid_by && (
                            // The name on the card is not always the name they
                            // say. Couples buy two tickets on one card, and the
                            // payer is who they will introduce themselves as.
                            <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'info.main' }}>
                                Paid by {attendee.paid_by}
                                {attendee.party_seat ? ` \u00b7 seat ${attendee.party_seat}` : ''}
                            </Typography>
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
                        <Button variant="outlined" size="small" startIcon={<PrintIcon />} onClick={() => { setAutoJob(null); printBadge(attendee, false); }}>
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
        const card = d.door || null;
        // One line for the money question. A comp and a door sale read
        // differently from an online order, and the desk is asked about all three.
        const money = (() => {
            if (!card) return '';
            const m = card.money || {};
            const bits = [];
            if (m.total > 0) {
                const src = (m.payments[0] || {}).source || 'online';
                const when = (m.payments[0] || {}).at ? String(m.payments[0].at).slice(0, 10) : '';
                bits.push(`Paid $${m.total} ${m.currency} \u00b7 ${src}${when ? ` \u00b7 ${when}` : ''}${m.count > 1 ? ` \u00b7 ${m.count} payments` : ''}`);
            }
            if (m.door) bits.push(`At the door: $${m.door.amount} ${m.door.method || ''} (${m.door.status})`);
            if (!m.total && !m.door) bits.push(m.attendance_type && m.attendance_type !== 'paid' ? `No payment \u2014 ${m.attendance_type}` : 'No payment on record');
            else if (m.attendance_type && m.attendance_type !== 'paid') bits.push(m.attendance_type);
            if (card.source === 'walk_in') bits.push('walk-in');
            if (card.source === 'rebuilt_seat') bits.push('seat rebuilt from a paid order');
            return bits.join(' \u00b7 ');
        })();
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
                    {d.refused_reason && (
                        // An override keeps the refusal visible. The screen must never
                        // read as though the rules had agreed.
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'warning.main' }}>
                            The door had refused: {d.refused_reason}
                        </Typography>
                    )}

                    {/* What they paid, who paid it, and what kind of attendance
                        this is — the three questions a desk gets asked back. */}
                    {card && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                            {money}
                        </Typography>
                    )}

                    {/* A seat whose name came off the buyer's order. This is the
                        single most likely correction of the weekend, so it says so
                        and puts the fix in the same place. */}
                    {card?.needs_name_check && (
                        <Alert severity="warning" icon={false} sx={{ mt: 1, py: 0.5 }}>
                            <strong>Check this name.</strong> This seat was rebuilt from a paid order —
                            the name shown is the buyer&rsquo;s, not necessarily this person&rsquo;s.
                            Ask them, then tap <em>Fix details</em>.
                        </Alert>
                    )}

                    {/* The rest of the booking. Somebody buying four tickets is one
                        of the two things that broke this year's roll, so the door
                        shows the whole party and who of them is already inside. */}
                    {card?.party && (
                        <Box sx={{ mt: 1.25, p: 1.25, borderRadius: 1, bgcolor: 'action.hover' }}>
                            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.75 }}>
                                <GroupsIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                    Seat {card.party.seat} &middot; {card.party.buyer}&rsquo;s booking
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {card.party.checked_in} of {card.party.size} here
                                </Typography>
                            </Stack>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                                {card.party.members.map((m) => (
                                    <Chip key={m.attendee_id} size="small"
                                        variant={m.is_this_one ? 'filled' : 'outlined'}
                                        color={m.checked_in ? 'success' : (m.needs_name_check ? 'warning' : 'default')}
                                        onClick={m.is_this_one ? undefined : () => openPartyMember(m)}
                                        label={`${m.checked_in ? '\u2713 ' : ''}${m.name}${m.is_buyer ? ' (bought)' : ''}`} />
                                ))}
                            </Stack>
                            {card.party.unnamed > 0 ? (
                                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                                    <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 700 }}>
                                        {card.party.unnamed} of the {card.party.paid_for} seats they paid for has no badge yet.
                                    </Typography>
                                    <Button size="small" variant="contained" color="warning" startIcon={<PersonAddIcon />}
                                            onClick={() => openDoorAction('addseat', d)}>
                                        Name seat {card.party.size + 1}
                                    </Button>
                                </Stack>
                            ) : (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                                    Tap any of them to pull up their badge without scanning it.
                                </Typography>
                            )}
                        </Box>
                    )}

                    {/* The sticker, right under the decision: printing / printed /
                        not printed and why, with the dialog one tap away. */}
                    {d.attendee_id && (d.result === 'GRANTED' || d.checked_in) && (() => {
                        const job = autoJob && autoJob.attendeeId === d.attendee_id ? autoJob : null;
                        const tone = job ? ({ printed: 'success.main', failed: 'warning.main' }[job.phase] || 'text.secondary') : 'text.secondary';
                        return (
                            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ mt: 1.25 }}>
                                {job && (job.phase === 'queued' || job.phase === 'printing') && <CircularProgress size={14} />}
                                <Typography variant="body2" sx={{ color: tone, fontWeight: job && job.phase !== 'printed' ? 600 : 500 }}>
                                    {job ? job.message : (Number(d.badge_print_count) > 0 || printedIds.current.has(d.attendee_id) ? 'Badge already printed' : 'Badge not printed')}
                                </Typography>
                                {(!job || job.phase === 'failed' || job.phase === 'printed') && (
                                    <Button size="small" variant={job && job.phase === 'failed' ? 'contained' : 'text'} startIcon={<PrintIcon />}
                                            onClick={() => { setAutoJob(null); openLabel(attendeeFromDecision(d), Boolean(d.checked_in_now)); }}>
                                        {job && job.phase === 'printed' ? 'Print again' : 'Print badge'}
                                    </Button>
                                )}
                            </Stack>
                        );
                    })()}
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

                    {/* Everything the desk is allowed to change, one tap from the
                        verdict. Each is audited; none of them weakens a rule for
                        anybody else. */}
                    {d.attendee_id && (
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
                            {!d.granted && (
                                <Button size="small" variant="contained" color="warning" startIcon={<LockOpenIcon />}
                                        onClick={() => openDoorAction('override', d)}>
                                    Let in anyway
                                </Button>
                            )}
                            <Button size="small" variant="outlined" startIcon={<EditIcon />}
                                    color={card?.needs_name_check ? 'warning' : 'inherit'}
                                    onClick={() => openDoorAction('fix', d)}>
                                Fix details
                            </Button>
                            <Button size="small" variant="outlined" color="inherit" startIcon={<SwapHorizIcon />}
                                    onClick={() => openDoorAction('pass', d)}>
                                Change pass
                            </Button>
                            {card?.may?.revoke === false ? null : card && ['refunded', 'cancelled', 'revoked'].includes(card.status) ? (
                                <Button size="small" variant="outlined" color="success" startIcon={<RestoreIcon />}
                                        onClick={() => openDoorAction('reinstate', d)}>
                                    Reinstate
                                </Button>
                            ) : (
                                <Button size="small" variant="outlined" color="error" startIcon={<BlockIcon />}
                                        onClick={() => openDoorAction('revoke', d)}>
                                    Revoke
                                </Button>
                            )}
                            {d.checked_in && (
                                <Button size="small" color="inherit" startIcon={<UndoIcon />}
                                        onClick={() => { setUndoTarget({ id: d.attendee_id, first_name: d.first_name, last_name: d.last_name }); setUndoReason(''); }}>
                                    Undo check-in
                                </Button>
                            )}
                        </Stack>
                    )}

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
                        onChange={(e) => chooseEvent(events.find((event) => event.id === Number(e.target.value)) || null)}
                        helperText={autoPicked
                            ? 'The only conference running. Change it if this door is for something else — badges from any other event are refused.'
                            : 'Badges from any other event are refused.'}>
                        {events.map((event) => (
                            <MenuItem key={event.id} value={event.id} disabled={Boolean(event.is_archived)}>
                                {event.name}{event.is_archived ? ' — archived, cannot be used' : ''}
                            </MenuItem>
                        ))}
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
                                {station || <Box component="span" sx={{ color: 'warning.main', fontWeight: 600 }}>Name this desk</Box>}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">·</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {rollShort(labelSize)} label
                            </Typography>
                            <Box flexGrow={1} />
                            <Button size="small" onClick={() => setStationOpen((v) => !v)}
                                    endIcon={<TuneIcon fontSize="small" />}>
                                {stationOpen ? 'Done' : 'Station setup'}
                            </Button>
                        </Stack>
                        {/* The printer line. Green = paired and admitted scans print by
                            themselves; otherwise the one tap that makes it so. */}
                        {canPrintBluetooth() && (
                            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"
                                   sx={{ px: 1.5, pb: 1, mt: -0.5 }}>
                                <Chip size="small" icon={<BluetoothIcon />}
                                      color={printer.connected ? 'success' : 'default'}
                                      variant={printer.connected ? 'filled' : 'outlined'}
                                      label={printer.connected
                                          ? (printer.busy ? `${printer.label} · printing ${printer.current}${printer.queued ? ` · ${printer.queued} waiting` : ''}` : `${printer.label} connected`)
                                          : 'Printer not connected'}
                                      sx={{ height: 24 }} />
                                {!printer.connected && (
                                    <Button size="small" variant="contained" onClick={connectPrinter} disabled={printerBusy}
                                            startIcon={<BluetoothIcon />}>
                                        {printerBusy ? 'Connecting…' : (connectAny ? 'Show all devices' : 'Connect printer')}
                                    </Button>
                                )}
                                <Button size="small" onClick={() => rememberAutoPrint(!autoPrint)}
                                        color={autoPrint ? 'primary' : 'inherit'}>
                                    {autoPrint ? 'Auto-print: on' : 'Auto-print: off'}
                                </Button>
                                {printerHint && (
                                    <Typography variant="caption" sx={{ width: '100%', color: 'warning.main' }}>{printerHint}</Typography>
                                )}
                            </Stack>
                        )}
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
                                        {Object.entries(LABEL_ROLLS).map(([key, roll]) => (
                                            <MenuItem key={key} value={key}>{roll.menu}</MenuItem>
                                        ))}
                                    </TextField>
                                    {canPrintBluetooth() && (
                                        <TextField select size="small" label="Printer" value={printerModel}
                                            onChange={(e) => rememberPrinterModel(e.target.value)} sx={{ minWidth: 210 }}
                                            helperText="Auto asks the printer; set it if a print comes out small or off-centre">
                                            {PRINTER_CHOICES.map(([v, text]) => <MenuItem key={v} value={v}>{text}</MenuItem>)}
                                        </TextField>
                                    )}
                                </Stack>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{zoneNote}</Typography>
                            </Box>
                        )}
                    </Paper>

                    {/* ── Which event this door belongs to ──────────────────────
                        A door scanning last year's event refuses every badge in
                        the queue and gives the same answer each time, so the
                        person holding the scanner has no way to tell a wrong
                        event from a broken one. It says so here, permanently,
                        and loudly when the event is not the live one. */}
                    {doorEvent && (
                        <Paper variant="outlined"
                               sx={{ mb: 2, p: 1.25,
                                     borderColor: doorEvent.is_active ? 'divider' : 'error.main',
                                     ...(doorEvent.is_active ? {} : { bgcolor: 'error.dark',
                                         backgroundImage: 'linear-gradient(rgba(0,0,0,.7),rgba(0,0,0,.7))' }) }}>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                <Typography variant="caption" sx={{ color: 'text.secondary',
                                            textTransform: 'uppercase', letterSpacing: '.08em' }}>
                                    Door for
                                </Typography>
                                <Typography variant="subtitle2" sx={{ fontWeight: 700,
                                            color: doorEvent.is_active ? 'text.primary' : 'error.main' }}>
                                    {doorEvent.name}
                                </Typography>
                                {!doorEvent.is_active && (
                                    <Chip size="small" color="error" label="Archived — badges will not admit" />
                                )}
                            </Stack>
                            {!doorEvent.is_active && (
                                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'error.light' }}>
                                    Every scan here will be refused. Switch to the live event before the queue starts.
                                </Typography>
                            )}
                        </Paper>
                    )}

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
                                    <Stack direction="row" sx={{ display: { xs: 'flex', sm: 'none' } }}>
                                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25 }}>
                                            {rehearsal ? 'Nothing counts as a real check-in. End it before the doors open.' : 'Real check-in is locked until the event starts.'}
                                        </Typography>
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' }, mt: 0.25 }}>
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

                    {/* ── Re-entry ──────────────────────────────────────────────
                        The one door setting whose cost arrives all at once. With it
                        off, everybody who checked in yesterday is refused this
                        morning — three hundred people, at the same time, at eight
                        o'clock. It lives here, next to the scanner, because the
                        moment anybody discovers they need it there is a queue. */}
                    {doorEvent && (
                        <Paper variant="outlined" sx={{ p: 1.5, mb: 2,
                                                        borderColor: reEntry ? 'divider' : 'warning.main' }}>
                            <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
                                <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                        {reEntry ? 'Re-entry is on — a badge readmits all weekend'
                                                 : 'Re-entry is off — one badge, one entry, for the whole event'}
                                    </Typography>
                                    <Typography variant="caption" color={reEntry ? 'text.secondary' : 'warning.main'}>
                                        {reEntry
                                            ? 'Somebody who steps out for lunch, or comes back tomorrow morning, scans straight back in.'
                                            : 'Everybody who checked in on a previous day will be refused when they scan again. For a three-day conference, turn this on.'}
                                    </Typography>
                                </Box>
                                <Button size="small" variant={reEntry ? 'outlined' : 'contained'}
                                    color={reEntry ? 'inherit' : 'warning'} disabled={reEntryBusy}
                                    onClick={async () => {
                                        setReEntryBusy(true);
                                        try {
                                            const r = await setDoorReEntry(eventId, !reEntry);
                                            setReEntry(Boolean(r.data?.allow_reentry));
                                            setFeedback({ severity: 'success',
                                                message: r.data?.allow_reentry
                                                    ? 'Re-entry on — badges readmit for the rest of the event.'
                                                    : 'Re-entry off — each badge admits once.' });
                                        } catch (err) {
                                            setFeedback({ severity: 'error', message: err.response?.data?.detail || 'Could not change that.' });
                                        } finally { setReEntryBusy(false); }
                                    }}>
                                    {reEntryBusy ? 'Working…' : (reEntry ? 'Turn off' : 'Turn on re-entry')}
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
                            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
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
                                   sx={{ px: 1.5, pt: 1.5, pb: (sideBySide || activityOpen) ? 1 : 1.5 }} gap={1} flexWrap="wrap">
                                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                                    Recent activity{!sideBySide && scanLogs.length > 0 ? ` · ${scanLogs.length}` : ''}
                                </Typography>
                                <Stack direction="row" spacing={0.5}>
                                    {!sideBySide && scanLogs.length > 0 && (
                                        <Button size="small" onClick={() => setActivityOpen((v) => !v)}>
                                            {activityOpen ? 'Hide' : 'Show'}
                                        </Button>
                                    )}
                                    {(sideBySide || activityOpen) && (
                                        <Button size="small" onClick={refreshScanLogs} disabled={logsLoading}>
                                            {logsLoading ? 'Loading…' : 'Refresh'}
                                        </Button>
                                    )}
                                    {(sideBySide || activityOpen) && scanLogs.length > 0 && (
                                        <Button size="small" color="error" onClick={() => setClearLogsOpen(true)}>Clear</Button>
                                    )}
                                </Stack>
                            </Stack>

                            {(sideBySide || activityOpen) && scanLogs.length > 0 && (
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
                            ) : !(sideBySide || activityOpen) ? null : (
                                <Box sx={{ maxHeight: { lg: 620 }, overflowY: 'auto' }}>
                                    {(sideBySide ? shownLogs : shownLogs.slice(0, activityLimit)).map((log, i) => {
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
                                    {!sideBySide && shownLogs.length > activityLimit && (
                                        <Box sx={{ p: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                                            <Button fullWidth size="small" onClick={() => setActivityLimit((n) => n + 50)}>
                                                Show {Math.min(50, shownLogs.length - activityLimit)} more of {shownLogs.length}
                                            </Button>
                                        </Box>
                                    )}
                                </Box>
                            )}
                        </Paper>
                    </Box>
                </>
            )}


            {/* Label preview. Check-in (if any) has already committed; this only prints. */}
            <BadgeLabelDialog request={labelReq} eventId={eventId} station={station}
                onClose={closeLabel} onRecorded={refreshSearch} notify={setFeedback} />

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
                                    {/* Offer the desk only the reasons the desk can
                                        act on. A free badge is somebody deciding to
                                        give an entry away, and that stays with an
                                        organiser — saying so here beats a refusal
                                        after the form has been filled in. */}
                                    {DOOR_REASONS.filter((r) => !may || may[r.needs] !== false).map((r) => (
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
                                {may && may.register_free_badge === false && (
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                        A complimentary guest, a speaker or a crew badge is an organiser&rsquo;s call.
                                    </Typography>
                                )}
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

            {/* Asked once, at the moment it first matters. */}
            <Dialog open={Boolean(namePrompt)} onClose={() => setNamePrompt(null)} fullWidth maxWidth="xs">
                <DialogTitle>Which desk is this?</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 0.5 }}>
                        <Typography variant="body2" color="text.secondary">
                            Every badge this device prints is recorded against the name you give here,
                            so a desk that starts failing can be found without asking around.
                            Saved on this device &mdash; you will not be asked again.
                        </Typography>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                            {STATION_PRESETS.map((n) => (
                                <Chip key={n} label={n} onClick={() => nameStationAndPrint(n)} variant="outlined" />
                            ))}
                        </Stack>
                        <TextField autoFocus size="small" fullWidth label="Or type a name"
                            placeholder="e.g. Main entrance"
                            onKeyDown={(e) => { if (e.key === 'Enter') nameStationAndPrint(e.target.value); }}
                            helperText="Press Enter to save and print" />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setNamePrompt(null)}>Not now</Button>
                </DialogActions>
            </Dialog>

            {/* One dialog, five jobs. They share a reason box because every one of
                them is a thing somebody will ask about on Monday. */}
            <Dialog open={Boolean(doorAction)} onClose={doorBusy ? undefined : closeDoorAction} fullWidth maxWidth="xs">
                <DialogTitle>
                    {doorAction?.kind === 'override' && 'Let them in anyway'}
                    {doorAction?.kind === 'fix' && 'Fix these details'}
                    {doorAction?.kind === 'addseat' && 'Name the next seat'}
                    {doorAction?.kind === 'pass' && 'Change this pass'}
                    {doorAction?.kind === 'revoke' && 'Revoke this badge'}
                    {doorAction?.kind === 'reinstate' && 'Make this badge valid again'}
                </DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 0.5 }}>
                        <Typography variant="body2" color="text.secondary">
                            {doorAction ? (`${doorAction.decision.first_name || ''} ${doorAction.decision.last_name || ''}`.trim() || doorAction.decision.name) : ''}
                            {doorAction?.decision?.attendee_id ? ` \u00b7 #${doorAction.decision.attendee_id}` : ''}
                        </Typography>

                        {doorAction?.kind === 'override' && (
                            <Alert severity="warning" icon={false}>
                                The door refused this badge: <strong>{doorAction.decision.reason}</strong>.
                                Letting them in does not change the ticket — it records that you decided to,
                                with your name against it.
                            </Alert>
                        )}
                        {doorAction?.kind === 'revoke' && (
                            <Alert severity="error" icon={false}>
                                This badge stops working at every door, straight away. No money moves —
                                a refund is a separate thing. It can be reinstated from this same screen.
                            </Alert>
                        )}

                        {doorAction?.kind === 'addseat' && (
                            <Alert severity="info" icon={false}>
                                This booking paid for <strong>{doorAction.decision.door?.party?.paid_for}</strong> seats
                                and has <strong>{doorAction.decision.door?.party?.size}</strong> badges.
                                This names the next one and gives them their own badge on the same booking.
                                Anybody who is <em>not</em> on this order is a walk-in, not a seat.
                            </Alert>
                        )}

                        {(doorAction?.kind === 'fix' || doorAction?.kind === 'addseat') && (
                            <>
                                <Stack direction="row" spacing={1}>
                                    <TextField label="First name" size="small" fullWidth autoFocus
                                        value={fixForm.first_name}
                                        onChange={(e) => setFixForm({ ...fixForm, first_name: e.target.value })} />
                                    <TextField label="Last name" size="small" fullWidth
                                        value={fixForm.last_name}
                                        onChange={(e) => setFixForm({ ...fixForm, last_name: e.target.value })} />
                                </Stack>
                                <TextField label="Phone" size="small" fullWidth value={fixForm.phone}
                                    onChange={(e) => setFixForm({ ...fixForm, phone: e.target.value })} />
                                {doorAction?.kind === 'fix' && (
                                    <TextField label="Email" size="small" fullWidth value={fixForm.email}
                                        onChange={(e) => setFixForm({ ...fixForm, email: e.target.value })}
                                        helperText="Changing the email needs an organiser login — it is how their card is claimed." />
                                )}
                            </>
                        )}

                        {doorAction?.kind === 'pass' && (
                            <>
                                <TextField select label="New pass" size="small" fullWidth value={passChoice}
                                    onChange={(e) => setPassChoice(e.target.value)}
                                    helperText="Same badge, same QR. They keep everything they already had.">
                                    {(() => {
                                        // Somebody who cannot move a pass down should not be shown
                                        // the options that would be refused.
                                        const may = doorAction.decision.door?.may;
                                        const nowRank = ticketTypes.find(
                                            (t) => String(t.id) === String(doorAction.decision.door?.ticket_type_id))?.upgrade_rank;
                                        return ticketTypes.filter((t) => (
                                            may?.downgrade || nowRank == null || t.upgrade_rank == null
                                                ? true : t.upgrade_rank >= nowRank
                                        ));
                                    })().map((t) => (
                                        <MenuItem key={t.id} value={String(t.id)}>{t.name}</MenuItem>
                                    ))}
                                </TextField>
                                {doorAction.decision.door?.may?.comp ? (
                                    <FormControlLabel
                                        control={<Switch checked={passPaid} size="small"
                                            onChange={(e) => setPassPaid(e.target.checked)} />}
                                        label={passPaid ? 'They are paying for this' : 'Complimentary \u2014 no money taken'} />
                                ) : (
                                    <Typography variant="caption" color="text.secondary">
                                        Upgrades sold at the desk are paid for. Giving one away, or moving
                                        somebody down, is an organiser&rsquo;s call.
                                    </Typography>
                                )}
                                {passPaid && (
                                    <Stack direction="row" spacing={1}>
                                        <TextField label="Amount" size="small" fullWidth required
                                            type="number" inputProps={{ min: 0, step: '0.01' }}
                                            value={passAmount} onChange={(e) => setPassAmount(e.target.value)}
                                            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }} />
                                        <TextField select label="Method" size="small" fullWidth
                                            value={passMethod} onChange={(e) => setPassMethod(e.target.value)}>
                                            {['cash', 'card', 'other'].map((m) => (
                                                <MenuItem key={m} value={m}>{m}</MenuItem>
                                            ))}
                                        </TextField>
                                    </Stack>
                                )}
                                <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
                                    {passPaid
                                        ? 'Recorded in Gaia and reported with the door\u2019s takings. Take the money on your usual till \u2014 nothing is written to GHL.'
                                        : 'Recorded as a complimentary change. Nothing is written to GHL.'}
                                </Alert>
                            </>
                        )}

                        <TextField label={doorAction?.kind === 'override' ? 'Why are you letting them in? (required)' : 'Reason (for the record)'}
                            size="small" fullWidth multiline minRows={2}
                            required={doorAction?.kind === 'override'}
                            value={actionReason} onChange={(e) => setActionReason(e.target.value)} />

                        {doorError && <Alert severity="error">{doorError}</Alert>}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDoorAction} disabled={doorBusy}>Cancel</Button>
                    {doorAction?.kind === 'override' && (
                        <Button variant="contained" color="warning" disabled={doorBusy || actionReason.trim().length < 3}
                            onClick={submitOverride}>{doorBusy ? 'Working\u2026' : 'Let them in'}</Button>
                    )}
                    {doorAction?.kind === 'fix' && (
                        <Button variant="contained" disabled={doorBusy || !fixForm.first_name.trim()}
                            onClick={submitFix}>{doorBusy ? 'Saving\u2026' : 'Save'}</Button>
                    )}
                    {doorAction?.kind === 'addseat' && (
                        <Button variant="contained" color="warning" disabled={doorBusy || !fixForm.first_name.trim()}
                            onClick={submitAddSeat}>{doorBusy ? 'Adding\u2026' : 'Add this seat'}</Button>
                    )}
                    {doorAction?.kind === 'pass' && (
                        <Button variant="contained"
                            disabled={doorBusy || !passChoice
                                || String(passChoice) === String(doorAction?.decision?.door?.ticket_type_id)
                                || (passPaid && !(Number(passAmount) > 0))}
                            onClick={submitPassChange}>
                            {doorBusy ? 'Changing\u2026' : (passPaid ? `Take $${passAmount || '0'} & upgrade` : 'Change pass')}
                        </Button>
                    )}
                    {doorAction?.kind === 'revoke' && (
                        <Button variant="contained" color="error" disabled={doorBusy}
                            onClick={submitRevoke}>{doorBusy ? 'Revoking\u2026' : 'Revoke'}</Button>
                    )}
                    {doorAction?.kind === 'reinstate' && (
                        <Button variant="contained" color="success" disabled={doorBusy}
                            onClick={submitReinstate}>{doorBusy ? 'Working\u2026' : 'Reinstate'}</Button>
                    )}
                </DialogActions>
            </Dialog>

            {eventId && printReport && printReport.attempts > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2">
                            Badges printed &middot; {printReport.printed}
                            {printReport.failed > 0 && (
                                <Box component="span" sx={{ color: 'warning.main', ml: 1 }}>
                                    {printReport.failed} failed
                                </Box>
                            )}
                        </Typography>
                        <Button size="small" onClick={() => { setPrintOpen((x) => !x); refreshPrintReport(); }}>
                            {printOpen ? 'Hide' : 'By desk'}
                        </Button>
                    </Stack>
                    {printOpen && (
                        <Box sx={{ mt: 1.5 }}>
                            <Stack spacing={1}>
                                {printReport.stations.map((st) => (
                                    <Stack key={st.station} direction="row" spacing={1} alignItems="baseline"
                                           justifyContent="space-between" flexWrap="wrap" useFlexGap>
                                        <Typography variant="body2" sx={{ fontWeight: st.named ? 700 : 400,
                                                                          color: st.named ? 'text.primary' : 'text.secondary' }}>
                                            {st.station}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {st.printed} printed
                                            {st.failed > 0 ? ` \u00b7 ${st.failed} failed (${st.failure_rate}%)` : ''}
                                            {st.operators.length ? ` \u00b7 ${st.operators.join(', ')}` : ''}
                                        </Typography>
                                    </Stack>
                                ))}
                            </Stack>
                            {printReport.unnamed_stations > 0 && (
                                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'warning.main' }}>
                                    {printReport.unnamed_stations} device(s) printed without naming a desk &mdash;
                                    those are filed under whoever was signed in.
                                </Typography>
                            )}
                            {printReport.recent_failures.length > 0 && (
                                <Box sx={{ mt: 1.5 }}>
                                    <Typography variant="caption" sx={{ fontWeight: 700 }}>Recent failures</Typography>
                                    {printReport.recent_failures.slice(0, 5).map((f, i) => (
                                        <Typography key={i} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                            {f.name || `#${f.attendee_id}`} &middot; {f.station || 'unnamed'} &middot; {String(f.error || '').slice(0, 70)}
                                        </Typography>
                                    ))}
                                </Box>
                            )}
                        </Box>
                    )}
                </Paper>
            )}

            <Snackbar open={Boolean(feedback)} autoHideDuration={4000} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
                {feedback ? <Alert severity={feedback.severity}>{feedback.message}</Alert> : undefined}
            </Snackbar>
        </Box>
    );
}

export default CheckIn;
