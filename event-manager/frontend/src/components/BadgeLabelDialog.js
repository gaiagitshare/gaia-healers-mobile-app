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
export const DEFAULT_LABEL_SIZE = '40x60';
// Every roll the station can print on. Key = the server's size id (width x
// length, mm); w/h are the exact page dimensions the print window is sized
// to, so nothing is scaled. The 3 x 5 inch label is 76.2 x 127 mm on a
// 3"-wide printer and gets the same name-over-QR design, scaled to the width.
export const LABEL_ROLLS = {
    '40x60':  { w: 40,   h: 60,  text: '40 × 60 mm',      menu: '40 × 60 mm · portrait — in stock' },
    '40x50':  { w: 40,   h: 50,  text: '40 × 50 mm',      menu: '40 × 50 mm · portrait — design target, roll not sold by NIIMBOT' },
    '40x40':  { w: 40,   h: 40,  text: '40 × 40 mm',      menu: '40 × 40 mm — in stock' },
    '40x30':  { w: 40,   h: 30,  text: '40 × 30 mm',      menu: '40 × 30 mm — in stock' },
    '50x30':  { w: 50,   h: 30,  text: '50 × 30 mm',      menu: '50 × 30 mm · landscape — in stock' },
    '76x127': { w: 76.2, h: 127, text: '3 × 5 in (76 × 127 mm)', menu: '3 × 5 in · portrait (76 × 127 mm) — 3" label printer' },
};
export const rollText = (key) => (LABEL_ROLLS[key] ? LABEL_ROLLS[key].text : key.replace('x', ' × ') + ' mm');
const rollOf = (key) => LABEL_ROLLS[key] || { w: Number(String(key).split('x')[0]), h: Number(String(key).split('x')[1]) };
export const savedLabelSize = () => { try { return localStorage.getItem(LABEL_SIZE_KEY) || DEFAULT_LABEL_SIZE; } catch (e) { return DEFAULT_LABEL_SIZE; } };
export const savedStation = () => { try { return localStorage.getItem(STATION_KEY) || ''; } catch (e) { return ''; } };
export const fullName = (attendee) => (`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || attendee.email);
// Which of the pre-printed coloured cards to hand over. The sticker never
// repeats the tier; the card already says it.
export const physicalCard = (attendee) => {
    const code = attendee?.effective_access?.base_ticket?.code || attendee?.ticket_type_code || '';
    return code === 'VIP' ? 'VIP' : 'ATTENDEE';
};
const attemptId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random());

// ── Direct Bluetooth printing (NIIMBOT B1) ─────────────────────────────────
// The door printer is a NIIMBOT B1: 203 dpi, 384-dot (48 mm) printhead, paper
// centred under the head by its spring guides. The label PNG the server renders
// is already 203 dpi (40 mm = 320 px), so it is dropped 1:1 onto a full-width
// canvas, centred — a 40 mm roll gets 4 mm of white each side, a 50 mm roll
// loses the 1 mm per side the head cannot reach anyway. The driver (MIT,
// public/vendor/niimbot-*.js) speaks the B1's BLE protocol from the page, so
// Chrome (desktop / Android) and Bluefy on iPhone print without the NIIMBOT
// app. It resolves only once the printer confirmed the page — no “Printed ✓”
// tap needed on that path.
const NIIMBOT_DRIVER_URL = `${process.env.PUBLIC_URL || ''}/vendor/niimbot-2.6.0.js`;
const B1_MODEL = { name_prefixes: ['B1'], task: 'b1', density: 3, label_type: 1, speed: 1 };
const B1_DPI = 203;
const B1_HEAD_PX = 384;                       // 48 mm at 203 dpi
const B1_OFFSET_Y_PX = 4;                     // paper registration measured on a B1 (driver's T50x30_b1)
const B1_MAX_ROLL_MM = 50;                    // widest roll the B1 takes
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
const composeForB1 = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const h = bmp.height;
    const canvas = document.createElement('canvas');
    canvas.width = B1_HEAD_PX; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, B1_HEAD_PX, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, Math.round((B1_HEAD_PX - bmp.width) / 2), 0);   // 320 px → 32 px white each side; 400 px → 8 px cropped each side
    bmp.close && bmp.close();
    const out = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the label.'))), 'image/png'));
    return { url: URL.createObjectURL(out), w_px: B1_HEAD_PX, h_px: h };
};
// What the operator reads when a Bluetooth print does not go through.
const bluetoothError = (err) => {
    const name = err && err.name; const msg = String((err && err.message) || err || '');
    if (name === 'NotFoundError') return '';                                   // chooser closed without picking a printer
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Bluetooth was blocked for this site — allow it in the browser and try again.';
    if (name === 'NetworkError' || /GATT|disconnected|Not connected/i.test(msg)) return 'Lost the printer — switch the B1 on (blue light), keep it near, and try again.';
    if (/Web Bluetooth/i.test(msg)) return 'This browser cannot talk to the printer. Use Chrome on a laptop/Android, or the Bluefy browser on iPhone.';
    if (/Connected printer is/i.test(msg)) return 'That is not a B1 — this station is set up for the NIIMBOT B1.';
    if (/counter stopped|never acknowledged/i.test(msg)) return 'The printer did not confirm the label — check the paper (lid closed, roll seated) and look at what came out.';
    return msg.length > 140 ? msg.slice(0, 137) + '…' : (msg || 'Print failed.');
};

// `request` = { attendee, checkedInNow?, labelSize? } while the dialog is open,
// null when closed. Whoever opens it has already done whatever check-in it
// meant to do: this only renders, prints and records. A failed print never
// undoes a check-in; a reprint never checks anyone in twice.
export default function BadgeLabelDialog({ request, eventId, station, onClose, onRecorded, notify }) {
    const [job, setJob] = useState(null);           // { url, blob, error, attemptId } for the current request
    const [btStatus, setBtStatus] = useState('');   // progress line while a Bluetooth print runs ('' = idle)
    const [btAnyDevice, setBtAnyDevice] = useState(false);   // after an empty chooser: next attempt lists every nearby device, not just "B1…"
    const [btHint, setBtHint] = useState('');        // stays in the dialog (a toast is gone in 4 s) until the next attempt
    const attendee = request?.attendee || null;
    const labelSize = request?.labelSize || savedLabelSize();
    const tell = (feedback) => { if (notify) notify(feedback); };

    useEffect(() => {
        if (!request) { setJob(null); setBtStatus(''); setBtHint(''); setBtAnyDevice(false); return undefined; }
        let url = null; let alive = true;
        setJob({ url: null, blob: null, error: '', attemptId: attemptId() });
        badgeLabelBlob(eventId, request.attendee.id, request.labelSize || savedLabelSize())
            .then((response) => {
                if (!alive) return;
                url = URL.createObjectURL(response.data);
                setJob((j) => (j ? { ...j, url, blob: response.data } : j));
            })
            .catch((err) => { if (alive) setJob((j) => (j ? { ...j, error: err.response?.data?.detail || 'Could not render the label.' } : j)); });
        return () => { alive = false; if (url) URL.revokeObjectURL(url); };
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
            tell({ severity: 'warning', message: `${rollText(labelSize)} is wider than the B1's 48 mm printhead. Pick a 40 or 50 mm roll in Station setup, or use Print / Send for the 3-inch printer.` });
            return;
        }
        let composed = null;
        setBtHint(''); setBtStatus('loading driver…');
        try {
            const Niimbot = await loadNiimbot();
            setBtStatus('preparing label…');
            composed = await composeForB1(job.blob);
            await Niimbot.printImage(composed.url, {
                model: btAnyDevice ? { ...B1_MODEL, name_prefixes: [] } : B1_MODEL,   // no prefix = the driver's discovery path
                size: { w_px: composed.w_px, h_px: composed.h_px, offset_y_px: B1_OFFSET_Y_PX, dpi: B1_DPI },
                onProgress: (s) => setBtStatus(String(s || '')),
            });
            setBtStatus(''); setBtAnyDevice(false);
            await finishPrint('printed');
        } catch (err) {
            setBtStatus('');
            if (err && err.name === 'NotFoundError') {
                // The chooser closed with nothing picked — usually because it was
                // empty. A B1 that is off, asleep, or still held by the NIIMBOT app
                // does not advertise. Offer the wide net for the next attempt.
                setBtAnyDevice(true);
                setBtHint('No printer was picked. If the list was empty: switch the B1 on (hold the power button until its light is on) and close the NIIMBOT app so it lets go of the printer — a printer held by another app does not show up. Then tap Print on B1 again; the list will show every nearby Bluetooth device.');
                return;
            }
            const why = bluetoothError(err);
            if (why) tell({ severity: 'warning', message: `${fullName(attendee)} — B1 print failed: ${why}` });
        } finally {
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
                            Hand over the <strong>{physicalCard(attendee)}</strong> card. Sticker: {rollText(labelSize)} — full name over the badge QR, nothing else.
                        </Typography>
                        <Box sx={{ p: 2, bgcolor: '#fff', borderRadius: 1, border: '1px solid', borderColor: 'divider', width: '100%', display: 'flex', justifyContent: 'center' }}>
                            {job.url
                                ? <img src={job.url} alt="Badge label preview" style={{ maxWidth: '100%', maxHeight: 420, imageRendering: 'pixelated' }} />
                                : (job.error ? <Alert severity="error">{job.error}</Alert> : <CircularProgress size={28} />)}
                        </Box>
                        {btHint && <Alert severity="info" sx={{ width: '100%' }}>{btHint}</Alert>}
                        <Typography variant="caption" color="text.secondary" alignSelf="flex-start">
                            {canPrintBluetooth()
                                ? 'Print on B1 records the print by itself once the printer confirms it. Any other route: print, then tell the system what happened.'
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
                        {btStatus ? `B1: ${btStatus}` : 'Print on B1'}
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
