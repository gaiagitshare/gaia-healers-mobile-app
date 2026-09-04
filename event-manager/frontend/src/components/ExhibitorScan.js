import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Typography, Button, TextField, Alert, Paper, Stack, Chip, Rating,
    Divider, CircularProgress, IconButton, Collapse,
} from '@mui/material';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import CloseIcon from '@mui/icons-material/Close';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { getExhibitorRoster, scanQR, updatePublicLead } from '../utils/api';

/**
 * The stand's own screen: everyone at the event, and the ones they have met.
 *
 * The roster above the fold is placeholder rows — and that is the security
 * model, not a styling choice. The server sends a COUNT and nothing else: no
 * names, no emails, no ids. Blurring a real list in CSS would be theatre, since
 * the browser would be holding every name and devtools would show them.
 * Encrypting it would be the same theatre with extra steps, because a client
 * that can decrypt is a client that holds the key.
 *
 * A person becomes visible here exactly once: when they hand over their badge
 * and the server, having checked this stand is allowed to scan at all, records
 * the exchange. What comes back is consent-filtered even then.
 */
function ExhibitorScan() {
    const { token } = useParams();
    const [roster, setRoster] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [scannerOpen, setScannerOpen] = useState(false);
    const [justScanned, setJustScanned] = useState(null);
    const [manual, setManual] = useState('');
    const [busy, setBusy] = useState(false);
    const scannerRef = useRef(null);

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const r = await getExhibitorRoster(token);
            setRoster(r.data);
        } catch (e) {
            setError(e?.response?.status === 404
                ? 'This scanner link is not active. Ask the Gaia Healers team to switch it on for your stand.'
                : 'Could not load your stand.');
        } finally { setLoading(false); }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    const submit = useCallback(async (code) => {
        const value = String(code || '').trim();
        if (!value || busy) return;
        setBusy(true); setError('');
        try {
            const r = await scanQR(value, token);
            if (r.data?.success) {
                setJustScanned({ ...r.data, at: Date.now() });
                setManual('');
                load();
            } else {
                setError(r.data?.message || 'That badge was not recognised.');
            }
        } catch (e) {
            setError('No connection. Try again.');
        } finally { setBusy(false); }
    }, [busy, token, load]);

    useEffect(() => {
        if (!scannerOpen) {
            if (scannerRef.current) { scannerRef.current.clear().catch(() => {}); scannerRef.current = null; }
            return undefined;
        }
        const s = new Html5QrcodeScanner('exhibitor-qr-reader',
            { fps: 10, qrbox: { width: 250, height: 250 } }, false);
        s.render((text) => submit(text), () => {});
        scannerRef.current = s;
        return () => { s.clear().catch(() => {}); };
    }, [scannerOpen, submit]);

    if (loading) {
        return <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>;
    }
    if (!roster) {
        return <Box sx={{ p: 3, maxWidth: 520, mx: 'auto' }}><Alert severity="warning">{error}</Alert></Box>;
    }

    const leads = roster.leads || [];
    const remaining = Math.max(0, (roster.attendees_total || 0) - leads.length);

    return (
        <Box sx={{ maxWidth: 560, mx: 'auto', p: 2, pb: 8 }}>
            <Stack direction="row" alignItems="baseline" justifyContent="space-between" flexWrap="wrap" gap={1}>
                <Box>
                    <Typography variant="h5" fontWeight={700}>{roster.company_name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                        {roster.event_name}{roster.booth_number ? ` · Booth ${roster.booth_number}` : ''}
                    </Typography>
                </Box>
                <Chip color="success" label={`${leads.length} captured`} />
            </Stack>

            <Button fullWidth variant="contained" size="large" sx={{ mt: 2, py: 1.4, borderRadius: 99 }}
                startIcon={<QrCodeScannerIcon />} onClick={() => setScannerOpen((v) => !v)}>
                {scannerOpen ? 'Close scanner' : 'Scan a badge'}
            </Button>

            <Collapse in={scannerOpen}>
                <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
                    <div id="exhibitor-qr-reader" style={{ width: '100%' }} />
                    <Divider sx={{ my: 1.5 }}><Typography variant="caption">or type the code</Typography></Divider>
                    <Stack direction="row" spacing={1}>
                        <TextField size="small" fullWidth placeholder="Badge code" value={manual}
                            onChange={(e) => setManual(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && submit(manual)} />
                        <Button variant="outlined" disabled={busy || !manual.trim()}
                            onClick={() => submit(manual)}>Add</Button>
                    </Stack>
                </Paper>
            </Collapse>

            {error && <Alert severity="warning" sx={{ mt: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {justScanned && (
                <Alert severity="success" sx={{ mt: 2 }}
                    action={<IconButton size="small" onClick={() => setJustScanned(null)}><CloseIcon fontSize="small" /></IconButton>}>
                    <strong>{justScanned.attendee?.first_name} {justScanned.attendee?.last_name}</strong>
                    {justScanned.message ? ` — ${justScanned.message}` : ' added to your leads.'}
                </Alert>
            )}

            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                People you have met
            </Typography>

            {leads.length === 0 ? (
                <Paper variant="outlined" sx={{ p: 2.5, textAlign: 'center', color: 'text.secondary' }}>
                    <Typography variant="body2">
                        Nobody yet. Scan a badge and they appear here, at the top.
                    </Typography>
                </Paper>
            ) : (
                <Stack spacing={1}>
                    {leads.map((l) => <LeadRow key={l.id} lead={l} token={token} onSaved={load} />)}
                </Stack>
            )}

            {remaining > 0 && (
                <>
                    <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                        {remaining} more people at this event
                    </Typography>
                    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
                        {/* Placeholder rows. There is nothing behind the blur — the
                            server sent a number, not a list. */}
                        {Array.from({ length: Math.min(remaining, 8) }).map((_, i) => (
                            <Stack key={i} direction="row" spacing={1.5} alignItems="center"
                                sx={{ px: 2, py: 1.4, borderTop: i ? '1px solid' : 'none', borderColor: 'divider' }}>
                                <Box sx={{ width: 34, height: 34, borderRadius: '50%', bgcolor: 'action.hover' }} />
                                <Box sx={{ flex: 1, filter: 'blur(5px)', userSelect: 'none' }} aria-hidden>
                                    <Box sx={{ height: 11, width: `${45 + ((i * 37) % 40)}%`, bgcolor: 'text.disabled',
                                               borderRadius: 1, opacity: 0.5 }} />
                                    <Box sx={{ height: 9, width: `${30 + ((i * 23) % 35)}%`, bgcolor: 'text.disabled',
                                               borderRadius: 1, opacity: 0.3, mt: 0.8 }} />
                                </Box>
                            </Stack>
                        ))}
                    </Paper>
                    <Alert severity="info" icon={false} sx={{ mt: 1.5 }}>
                        <Typography variant="body2">
                            These are not hidden — they were never sent. Your stand receives someone&rsquo;s
                            details when they hand you their badge to scan, and only what they agreed to share.
                        </Typography>
                    </Alert>
                </>
            )}
        </Box>
    );
}

function LeadRow({ lead, token, onSaved }) {
    const a = lead.attendee || {};
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState(lead.notes || '');
    const [rating, setRating] = useState(lead.rating || 0);
    const [saving, setSaving] = useState(false);
    const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Attendee';

    const save = async () => {
        setSaving(true);
        try {
            await updatePublicLead(lead.id, { access_token: token, notes: note, rating });
            setOpen(false);
            onSaved();
        } finally { setSaving(false); }
    };

    return (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Box sx={{ width: 34, height: 34, borderRadius: '50%', bgcolor: 'primary.main', color: '#fff',
                           display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                           fontWeight: 700, flex: '0 0 auto' }}>
                    {(name[0] || 'A').toUpperCase()}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600}>{name}</Typography>
                    {a.company && <Typography variant="caption" color="text.secondary" display="block">{a.company}</Typography>}
                    {/* Only what the attendee agreed to share reaches this screen. */}
                    {a.email && <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }}>{a.email}</Typography>}
                    {a.phone && <Typography variant="caption" display="block">{a.phone}</Typography>}
                    {!a.email && !a.phone && (
                        <Typography variant="caption" color="text.secondary" display="block">
                            Contact details not shared
                        </Typography>
                    )}
                    {lead.rating ? <Rating size="small" value={lead.rating} readOnly sx={{ mt: 0.4 }} /> : null}
                    {lead.notes && <Typography variant="caption" display="block" sx={{ mt: 0.4 }}>{lead.notes}</Typography>}
                </Box>
                <Button size="small" onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Note'}</Button>
            </Stack>
            <Collapse in={open}>
                <Box sx={{ mt: 1.5 }}>
                    <Rating value={rating} onChange={(_, v) => setRating(v || 0)} />
                    <TextField fullWidth size="small" multiline rows={2} sx={{ mt: 1 }}
                        placeholder="What did you talk about?" value={note}
                        onChange={(e) => setNote(e.target.value)} />
                    <Button size="small" variant="contained" sx={{ mt: 1 }} disabled={saving} onClick={save}>
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </Box>
            </Collapse>
        </Paper>
    );
}

export default ExhibitorScan;
