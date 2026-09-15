import React, { useEffect, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import IosShareIcon from '@mui/icons-material/IosShare';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import { badgeLabelBlob, recordBadgePrint } from '../utils/api';

// The badge sticker, wherever it is printed from — the check-in desk or an
// attendee's Manage card. ONE dialog, one set of print routes, one record of
// what happened, so the door and the office never drift apart.

export const STATION_KEY = 'gha_station';
export const LABEL_SIZE_KEY = 'gha_label_size';
export const DEFAULT_LABEL_SIZE = '50x30v';
// Every roll the station can print on. Key = the server's size id (width x
// length of the label AS THE ROLL FEEDS, mm); w/h are the exact page
// dimensions the print window is sized to, so nothing is scaled. `upright`
// marks the vertical 3 x 5 cm sticker: designed 30 wide x 50 tall, printed
// turned on the 50 x 30 roll, shown in the preview the way it reads on the card.
export const LABEL_ROLLS = {
    '50x30v': { w: 50, h: 30, upright: true, text: '3 × 5 cm · vertical (50 × 30 mm)', short: '3 × 5 cm vertical', menu: '3 × 5 cm (50 × 30 mm) · vertical on the card — in stock' },
    '50x30':  { w: 50, h: 30, text: '50 × 30 mm · horizontal', short: '50 × 30 horizontal', menu: '50 × 30 mm · horizontal, QR beside the name — in stock' },
    '40x60':  { w: 40, h: 60, text: '40 × 60 mm',      menu: '40 × 60 mm · portrait — in stock' },
    '40x50':  { w: 40, h: 50, text: '40 × 50 mm',      menu: '40 × 50 mm · portrait — design target, roll not sold by NIIMBOT' },
    '40x40':  { w: 40, h: 40, text: '40 × 40 mm',      menu: '40 × 40 mm — in stock' },
    '40x30':  { w: 40, h: 30, text: '40 × 30 mm',      menu: '40 × 30 mm — in stock' },
};
export const rollText = (key) => (LABEL_ROLLS[key] ? LABEL_ROLLS[key].text : key.replace('x', ' × ') + ' mm');
export const rollShort = (key) => (LABEL_ROLLS[key] ? (LABEL_ROLLS[key].short || LABEL_ROLLS[key].text) : key.replace('x', ' × ') + ' mm');
const rollOf = (key) => LABEL_ROLLS[key] || { w: Number(String(key).split('x')[0]), h: Number(String(key).split('x')[1]) };
// A roll this build no longer offers (a station set up on an older build) falls back to the default rather than a 400 from the server.
export const savedLabelSize = () => { try { const v = localStorage.getItem(LABEL_SIZE_KEY); return LABEL_ROLLS[v] ? v : DEFAULT_LABEL_SIZE; } catch (e) { return DEFAULT_LABEL_SIZE; } };
export const savedStation = () => { try { return localStorage.getItem(STATION_KEY) || ''; } catch (e) { return ''; } };
export const fullName = (attendee) => (`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || attendee.email);
// Which of the pre-printed coloured cards to hand over. The sticker never
// repeats the tier; the card already says it.
export const physicalCard = (attendee) => {
    const code = attendee?.effective_access?.base_ticket?.code || attendee?.ticket_type_code || '';
    return code === 'VIP' ? 'VIP' : 'ATTENDEE';
};
const attemptId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random());

// ── Direct Bluetooth printing (NIIMBOT B1 / B1 Pro) ────────────────────────
// The door printer is a NIIMBOT B1 or B1 Pro. Both advertise as "B1…"; the
// driver asks the printer which it is on connect, and everything below keys
// off the answer: the B1 is 203 dpi with a 384-dot (48 mm) head and speaks
// the "b1" task, the B1 Pro is 300 dpi with a 576-dot head and speaks "v4".
// The server renders the label at the printer's dpi, so it is dropped 1:1
// onto a full-width canvas, centred — the paper sits centred under the head
// on its spring guides; a 40 mm roll gets white either side, a 50 mm roll
// loses the sliver the head cannot reach anyway. The driver (MIT,
// public/vendor/niimbot-*.js) speaks the BLE protocol from the page, so
// Chrome (desktop / Android) and Bluefy on iPhone print without the NIIMBOT
// app. It resolves only once the printer confirmed the page — no “Printed ✓”
// tap needed on that path.
const NIIMBOT_DRIVER_URL = `${process.env.PUBLIC_URL || ''}/vendor/niimbot-2.6.0.js`;
const NAME_PREFIXES = ['B1'];
const B1_MAX_ROLL_MM = 50;                    // widest roll either printer takes
// Per-printer print profile, chosen from what the printer says it is. Values
// are the driver registry's (validated on real hardware there).
const PROFILES = {
    b1: { label: 'NIIMBOT B1',     task: 'b1', dpi: 203, headPx: 384, offsetY: 4, model: { name_prefixes: NAME_PREFIXES, task: 'b1', density: 3, label_type: 1, speed: 1 } },
    v4: { label: 'NIIMBOT B1 Pro', task: 'v4', dpi: 300, headPx: 576, offsetY: 0, model: { name_prefixes: NAME_PREFIXES, task: 'v4', density: 3, label_type: 1, speed: 1 } },
};
const profileFor = (info) => {
    if (info && info.task === 'v4') return { ...PROFILES.v4, label: info.label || PROFILES.v4.label };
    return { ...PROFILES.b1, label: (info && info.label) || PROFILES.b1.label };
};
// Ask the printer what it is (pairing on the first call — that one needs a
// tap) and return the profile to print with.
const identifyPrinter = async (anyDevice) => {
    const Niimbot = await loadNiimbot();
    // The connect model only matters for the chooser filter and, if the
    // printer cannot be identified, the task fallback; the driver arms the
    // link from the printer's own answer.
    const info = await Niimbot.identify(anyDevice ? { ...PROFILES.b1.model, name_prefixes: [] } : PROFILES.b1.model);
    return { info, profile: profileFor(info) };
};
const B1_STALL_MS = 20000;                    // no word from the driver or printer for this long = stalled (its own timeouts are all shorter)
export const canPrintBluetooth = () => { try { return Boolean(navigator.bluetooth); } catch (e) { return false; } };
let niimbotLoading = null;
const loadNiimbot = () => {
    if (window.Niimbot) return Promise.resolve(window.Niimbot);
    if (!niimbotLoading) {
        niimbotLoading = new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = NIIMBOT_DRIVER_URL; el.async = true;
            el.onload = () => (window.Niimbot ? resolve(window.Niimbot) : reject(new Error('Printer driver did not initialise.')));
            el.onerror = () => { niimbotLoading = null; reject(new Error('Could not load the printer driver — check the connection and try again.')); };
            document.head.appendChild(el);
        });
    }
    return niimbotLoading;
};
// Label PNG → { url, w_px, h_px } for the B1: full head width, label centred,
// pixels untouched (a 1-bit source through a smoothing scaler would grey the QR).
const composeForB1 = async (blob, headPx) => {
    const bmp = await createImageBitmap(blob);
    const h = bmp.height;
    const canvas = document.createElement('canvas');
    canvas.width = headPx; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, headPx, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, Math.round((headPx - bmp.width) / 2), 0);   // narrower than the head → white either side; wider → the sliver past the head is cropped, centred
    bmp.close && bmp.close();
    const out = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the label.'))), 'image/png'));
    return { url: URL.createObjectURL(out), w_px: headPx, h_px: h };
};
// What the operator reads when a Bluetooth print does not go through.
const bluetoothError = (err) => {
    const name = err && err.name; const msg = String((err && err.message) || err || '');
    if (name === 'NotFoundError') return '';                                   // chooser closed without picking a printer
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Bluetooth was blocked for this site — allow it in the browser and try again.';
    if (name === 'NetworkError' || /GATT|disconnected|Not connected/i.test(msg)) return 'Lost the printer — switch the B1 on (blue light), keep it near, and try again.';
    if (/Web Bluetooth/i.test(msg)) return 'This browser cannot talk to the printer. Use Chrome on a laptop/Android, or the Bluefy browser on iPhone.';
    if (/Connected printer is/i.test(msg)) return 'That printer is not a B1 or B1 Pro — this station only prints to those.';
    if (/counter stopped|never acknowledged/i.test(msg)) return 'The printer did not confirm the label — check the paper (lid closed, roll seated) and look at what came out.';
    return msg.length > 140 ? msg.slice(0, 137) + '…' : (msg || 'Print failed.');
};

// ── One printer session for the whole page ─────────────────────────────────
// The driver keeps a single BLE link. Pairing needs a tap (the browser will
// not open its device chooser from a camera callback), so the desk connects
// once at the start of the shift; after that the label prints straight off
// a scan with no tap at all. Every print — automatic or from the dialog —
// goes through one queue, because two jobs on one link interleave into
// garbage on paper.
const b1 = { busy: false, current: null, queue: [], listeners: new Set(), lastError: '', info: null };
const b1State = () => ({ connected: b1IsConnected(), busy: b1.busy, current: b1.current, queued: b1.queue.length, lastError: b1.lastError,
                         info: b1.info, label: profileFor(b1.info).label, dpi: profileFor(b1.info).dpi });
// The dpi a label must be rendered at for the paired printer (203 until one is identified).
export const b1Dpi = () => profileFor(b1.info).dpi;
const b1Emit = () => { const st = b1State(); b1.listeners.forEach((fn) => { try { fn(st); } catch (e) { /* a listener never breaks printing */ } }); };
export const b1IsConnected = () => { try { return Boolean(window.Niimbot && window.Niimbot.isConnected && window.Niimbot.isConnected()); } catch (e) { return false; } };
// React view of the session; polls so a printer that went to sleep shows as
// disconnected without anyone touching it.
export const useB1 = () => {
    const [st, setSt] = useState(b1State);
    useEffect(() => {
        b1.listeners.add(setSt);
        const t = setInterval(() => setSt(b1State()), 3000);
        return () => { b1.listeners.delete(setSt); clearInterval(t); };
    }, []);
    return st;
};
// Pair (a tap) and identify, without printing.
export const b1Connect = async (anyDevice = false) => {
    const { info, profile } = await identifyPrinter(anyDevice);
    b1.info = info; b1.lastError = ''; b1Emit();
    return { ...info, label: profile.label, dpi: profile.dpi };
};
export const b1Disconnect = async () => { try { if (window.Niimbot) await window.Niimbot.disconnect(); } catch (e) { /* gone */ } b1.info = null; b1Emit(); };
// Run `fn` when the printer is free. `label` is what the queue shows.
export const b1Enqueue = (label, fn) => new Promise((resolve, reject) => {
    b1.queue.push({ label, fn, resolve, reject }); b1Emit(); b1Pump();
});
async function b1Pump() {
    if (b1.busy) return;
    const next = b1.queue.shift();
    if (!next) { b1Emit(); return; }
    b1.busy = true; b1.current = next.label; b1Emit();
    try { next.resolve(await next.fn()); b1.lastError = ''; }
    catch (e) { b1.lastError = (e && e.message) || String(e); next.reject(e); }
    finally { b1.busy = false; b1.current = null; b1Emit(); b1Pump(); }
}
// Compose and print one label blob — rendered at b1Dpi() — on the paired
// printer. Throws on anything short of the printer confirming the page.
export const b1PrintBlob = async (blob, opts = {}) => {
    const Niimbot = await loadNiimbot();
    const profile = profileFor(b1.info);
    const composed = await composeForB1(blob, profile.headPx);
    try {
        await Niimbot.printImage(composed.url, {
            model: opts.anyDevice ? { ...profile.model, name_prefixes: [] } : profile.model,
            size: { w_px: composed.w_px, h_px: composed.h_px, offset_y_px: profile.offsetY, dpi: profile.dpi },
            onProgress: opts.onProgress,
        });
    } finally { URL.revokeObjectURL(composed.url); }
};
export const rollFitsB1 = (key) => (LABEL_ROLLS[key] ? LABEL_ROLLS[key].w : Number(String(key).split('x')[0])) <= B1_MAX_ROLL_MM;

// `request` = { attendee, checkedInNow?, labelSize? } while the dialog is open,
// null when closed. Whoever opens it has already done whatever check-in it
// meant to do: this only renders, prints and records. A failed print never
// undoes a check-in; a reprint never checks anyone in twice.
export default function BadgeLabelDialog({ request, eventId, station, onClose, onRecorded, notify }) {
    const [job, setJob] = useState(null);           // { url, blob, error, attemptId } for the current request
    const [btStatus, setBtStatus] = useState('');   // progress line while a Bluetooth print runs ('' = idle)
    const [btAnyDevice, setBtAnyDevice] = useState(false);   // after an empty chooser: next attempt lists every nearby device, not just "B1…"
    const [btHint, setBtHint] = useState('');        // stays in the dialog (a toast is gone in 4 s) until the next attempt
    const [btTrace, setBtTrace] = useState([]);      // the driver's own log lines for this attempt — a phone has no console, so the dialog is the console
    const attendee = request?.attendee || null;
    const labelSize = request?.labelSize || savedLabelSize();
    const tell = (feedback) => { if (notify) notify(feedback); };

    useEffect(() => {
        if (!request) { setJob(null); setBtStatus(''); setBtHint(''); setBtTrace([]); setBtAnyDevice(false); return undefined; }
        let url = null; let previewUrl = null; let alive = true;
        const size = request.labelSize || savedLabelSize();
        setJob({ url: null, previewUrl: null, blob: null, error: '', attemptId: attemptId() });
        // The printers always get the roll orientation. A sticker that is
        // printed turned is previewed the way it reads on the card.
        const wanted = [badgeLabelBlob(eventId, request.attendee.id, size)];
        if (LABEL_ROLLS[size]?.upright) wanted.push(badgeLabelBlob(eventId, request.attendee.id, size, 'card'));
        Promise.all(wanted)
            .then(([roll, card]) => {
                if (!alive) return;
                url = URL.createObjectURL(roll.data);
                previewUrl = card ? URL.createObjectURL(card.data) : url;
                setJob((j) => (j ? { ...j, url, previewUrl, blob: roll.data } : j));
            })
            .catch((err) => { if (alive) setJob((j) => (j ? { ...j, error: err.response?.data?.detail || 'Could not render the label.' } : j)); });
        return () => { alive = false; if (url) URL.revokeObjectURL(url); if (previewUrl && previewUrl !== url) URL.revokeObjectURL(previewUrl); };
    }, [request, eventId]);

    // Sends the sticker to whatever printer the browser can reach (the NIIMBOT
    // desktop driver, or a bridge that registers as a system printer). The
    // page is sized to the roll so nothing is scaled. The window is opened in
    // the click itself — a pop-up opened after an await is blocked.
    const sendToPrinter = () => {
        if (!job?.url) return;
        const { w, h } = rollOf(labelSize);             // page = the roll, in mm, exactly
        const win = window.open('', '_blank', 'width=520,height=360');
        if (!win) { tell({ severity: 'warning', message: 'Pop-up blocked — allow pop-ups for this site to print.' }); return; }
        win.document.write(`<!doctype html><title>Badge label</title><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0}img{display:block;width:${w}mm;height:${h}mm;image-rendering:pixelated}</style><img src="${job.url}" onload="setTimeout(function(){window.print();},150)">`);
        win.document.close();
    };
    // iPhone without Bluefy: no NIIMBOT printer driver exists and the NIIMBOT
    // app has no link that takes an image. The one route iOS gives a web page
    // is the share sheet: hand the PNG over as a file, the operator picks
    // NIIMBOT (or Save Image, then NIIMBOT → Image label).
    const canShareLabel = () => {
        try {
            if (!job?.blob || !navigator.canShare) return false;
            return navigator.canShare({ files: [new File([job.blob], 'badge.png', { type: 'image/png' })] });
        } catch (e) { return false; }
    };
    const shareToApp = async () => {
        if (!job?.blob || !attendee) return;
        const file = new File([job.blob], `badge-${attendee.qr_code || attendee.id}.png`, { type: 'image/png' });
        try {
            await navigator.share({ files: [file], title: `${fullName(attendee)} — badge label` });
            tell({ severity: 'info', message: 'Label sent. In NIIMBOT: Image label → this picture → Print. Then tap “Printed ✓” here.' });
        } catch (err) {
            if (err && err.name === 'AbortError') return;          // operator closed the sheet
            tell({ severity: 'warning', message: 'Could not open the share sheet — use Download PNG and open it in NIIMBOT.' });
        }
    };
    const finishPrint = async (result, error = '') => {
        if (!job || !attendee) return;
        const checkedInNow = Boolean(request.checkedInNow);
        try {
            await recordBadgePrint(eventId, attendee.id, { result, station: station || undefined, error: error || undefined, client_attempt_id: job.attemptId });
            tell(result === 'printed'
                ? { severity: 'success', message: `${fullName(attendee)} — badge printed${checkedInNow ? ' · checked in' : ''}` }
                : { severity: 'warning', message: `${fullName(attendee)} — ${checkedInNow ? '✓ checked in · ' : ''}⚠ badge NOT printed. Use Retry print.` });
            if (onRecorded) await onRecorded(result, attendee);
        } catch (err) {
            tell({ severity: 'error', message: err.response?.data?.detail || 'Could not record the print.' });
        }
        if (result === 'printed') onClose();
        else setJob((j) => (j ? { ...j, attemptId: attemptId() } : j));   // the next try is its own attempt
    };
    // One tap, no app: pair the B1 (chooser on first use, then it stays
    // connected), push the label over BLE, and record the print once the
    // printer itself has confirmed the page. Anything less than confirmation
    // leaves the dialog open with the reason, so the operator decides.
    const printOnB1 = async () => {
        if (!job?.blob || btStatus || !attendee) return;
        if (rollOf(labelSize).w > B1_MAX_ROLL_MM) {
            tell({ severity: 'warning', message: `${rollText(labelSize)} is wider than the printer's 48 mm head. Pick a 40 or 50 mm roll in Station setup.` });
            return;
        }
        let composed = null; let Niimbot = null;
        // Every line the driver logs (it says which step it is on: device name,
        // characteristic, identification, write mode, handshake, packets) is
        // mirrored into the dialog, and a step that goes quiet for B1_STALL_MS is
        // called a stall — with the last line named, so "stuck on connecting"
        // becomes "stuck after <this>".
        const trace = []; let lastLine = ''; let lastActivity = Date.now();
        const note = (line) => {
            lastLine = line; lastActivity = Date.now();
            trace.push(`${new Date().toLocaleTimeString([], { hour12: false })} ${line}`);
            if (trace.length > 120) trace.shift();
            setBtTrace(trace.slice());
        };
        const origLog = console.log; let prevDebug = null; let stallTimer = null;
        console.log = function (...args) {
            try {
                const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
                if (text.startsWith('[niimbot')) note(text.replace(/^\[niimbot[^\]]*\]\s*/, ''));
            } catch (e) { /* logging never breaks printing */ }
            return origLog.apply(console, args);
        };
        setBtHint(''); setBtTrace([]); setBtStatus('loading driver…');
        try {
            Niimbot = await loadNiimbot();
            prevDebug = Niimbot.DEBUG; Niimbot.DEBUG = true;
            // Pair / identify first (this tap is the gesture the chooser needs),
            // then render the label at the dpi of whatever answered.
            setBtStatus(`connecting…${btAnyDevice ? ' (all devices)' : ''}`);
            const paired = await b1Connect(btAnyDevice);
            const profile = profileFor(paired);
            note(`printer: ${profile.label} (${profile.dpi} dpi, ${profile.headPx} px head)`);
            setBtStatus('preparing label…');
            const roll = await badgeLabelBlob(eventId, attendee.id, labelSize, 'roll', profile.dpi);
            composed = await composeForB1(roll.data, profile.headPx);
            note(`label ${composed.w_px}×${composed.h_px} px ready`);
            const stalled = new Promise((resolve, reject) => {
                stallTimer = setInterval(() => {
                    if (Date.now() - lastActivity > B1_STALL_MS) {
                        clearInterval(stallTimer); stallTimer = null;
                        const e = new Error(`stalled after: ${lastLine || 'connecting'}`); e.name = 'StallError'; reject(e);
                    }
                }, 1000);
            });
            await Promise.race([
                b1Enqueue(fullName(attendee), () => Niimbot.printImage(composed.url, {
                    model: profile.model,
                    size: { w_px: composed.w_px, h_px: composed.h_px, offset_y_px: profile.offsetY, dpi: profile.dpi },
                    onProgress: (st) => { const t = String(st || ''); setBtStatus(t); note(`progress: ${t}`); },
                })),
                stalled,
            ]);
            setBtStatus(''); setBtAnyDevice(false);
            await finishPrint('printed');
        } catch (err) {
            setBtStatus('');
            note(`✗ ${(err && (err.name + ': ' + err.message)) || err}`);
            if (err && err.name === 'StallError') {
                // Drop the link so the next tap starts clean instead of reusing a
                // half-open connection the driver would happily consider "connected".
                try { if (Niimbot) await Niimbot.disconnect(); } catch (e) { /* already gone */ }
                setBtHint(`The printer stopped answering (${err.message}). Switch the printer off and on again, make sure the NIIMBOT app is closed, and tap Print on B1 again. The printer log below shows the last step reached.`);
                return;
            }
            if (err && err.name === 'NotFoundError') {
                // The chooser closed with nothing picked — usually because it was
                // empty. A B1 that is off, asleep, or still held by the NIIMBOT app
                // does not advertise. Offer the wide net for the next attempt.
                setBtAnyDevice(true);
                setBtHint('No printer was picked. If the list was empty: switch the printer on (hold the power button until its light is on) and close the NIIMBOT app so it lets go of the printer — a printer held by another app does not show up. Then tap the print button again; the list will show every nearby Bluetooth device.');
                return;
            }
            const why = bluetoothError(err);
            if (why) tell({ severity: 'warning', message: `${fullName(attendee)} — B1 print failed: ${why}` });
        } finally {
            if (stallTimer) clearInterval(stallTimer);
            console.log = origLog;
            if (Niimbot && prevDebug !== null) Niimbot.DEBUG = prevDebug;
            if (composed?.url) URL.revokeObjectURL(composed.url);
        }
    };

    return (
        <Dialog open={Boolean(request)} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>
                {attendee ? fullName(attendee) : ''}
                {request?.checkedInNow && <Chip size="small" color="success" label="✓ Checked in" sx={{ ml: 1 }} />}
            </DialogTitle>
            <DialogContent dividers>
                {attendee && job && (
                    <Stack spacing={1.5} alignItems="center">
                        <Typography variant="body2" color="text.secondary" alignSelf="flex-start">
                            Hand over the <strong>{physicalCard(attendee)}</strong> card. Sticker: {rollText(labelSize)} — name over the badge QR, nothing else.{LABEL_ROLLS[labelSize]?.upright ? ' It comes out of the printer sideways; turn it once and it sits upright on the card.' : ''}
                        </Typography>
                        <Box sx={{ p: 2, bgcolor: '#fff', borderRadius: 1, border: '1px solid', borderColor: 'divider', width: '100%', display: 'flex', justifyContent: 'center' }}>
                            {job.url
                                ? <img src={job.previewUrl || job.url} alt="Badge label preview" style={{ maxWidth: '100%', maxHeight: 420, imageRendering: 'pixelated' }} />
                                : (job.error ? <Alert severity="error">{job.error}</Alert> : <CircularProgress size={28} />)}
                        </Box>
                        {btHint && <Alert severity="info" sx={{ width: '100%' }}>{btHint}</Alert>}
                        {btTrace.length > 0 && (
                            <Box component="details" open={Boolean(btHint)} sx={{ width: '100%', fontSize: 12, color: 'text.secondary' }}>
                                <Box component="summary" sx={{ cursor: 'pointer' }}>Printer log · last: {btTrace[btTrace.length - 1].replace(/^\S+\s/, '')}</Box>
                                <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, maxHeight: 180, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                    {btTrace.join('\n')}
                                </Box>
                            </Box>
                        )}
                        <Typography variant="caption" color="text.secondary" alignSelf="flex-start">
                            {canPrintBluetooth()
                                ? 'Print on B1 / B1 Pro records the print by itself once the printer confirms it. Any other route: print, then tell the system what happened.'
                                : 'Print, then tell the system what happened.'} A failed print never undoes the check-in; a reprint never checks anyone in twice.
                        </Typography>
                    </Stack>
                )}
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                <Button onClick={onClose}>Close</Button>
                {job?.url && attendee && <Button component="a" href={job.url} download={`badge-${attendee.qr_code || attendee.id}.png`}>Download PNG</Button>}
                {canPrintBluetooth() && (
                    <Button variant="contained" startIcon={btStatus ? <CircularProgress size={16} color="inherit" /> : <BluetoothIcon />}
                        disabled={!job?.blob || Boolean(btStatus)} onClick={printOnB1}>
                        {btStatus ? `Printer: ${btStatus}` : 'Print on B1 / B1 Pro'}
                    </Button>
                )}
                {canShareLabel() && <Button variant="outlined" startIcon={<IosShareIcon />} onClick={shareToApp}>Send to NIIMBOT app</Button>}
                <Button variant="outlined" startIcon={<PrintIcon />} disabled={!job?.url} onClick={sendToPrinter}>Print</Button>
                <Button color="warning" onClick={() => finishPrint('failed', 'Operator reported a failed print')}>Mark failed</Button>
                <Button variant="contained" color="success" onClick={() => finishPrint('printed')}>Printed ✓</Button>
            </DialogActions>
        </Dialog>
    );
}
