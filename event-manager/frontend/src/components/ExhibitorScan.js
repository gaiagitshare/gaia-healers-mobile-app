import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Typography, Button, TextField, Alert, Paper, Stack, Chip, Rating,
    Divider, CircularProgress, IconButton, Collapse,
} from '@mui/material';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import CloseIcon from '@mui/icons-material/Close';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { getExhibitorRoster, scanQR, updatePublicLead, standLeadsCsvUrl, standFullListCsvUrl } from '../utils/api';

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
 *
 * Babak, 13 Nov 2026: stands whose package includes the full attendee list get
 * it here (the server sends it only to them, same person-level rules). Every
 * other stand keeps the count below and an offer to buy the list.
 *
 * Later on 13 Nov: scanning is free, the leads are paid. A stand without the
 * full list sees each scan as a blurred row it can rate and note; the server
 * sends no name, company or contact until its leads are unlocked, so the blur
 * is over placeholder bars, not over data.
 */
const Locked = ({ when }) => (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.6 }}>
        &#128274; Locked{when ? ` · scanned ${new Date(when).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
    </Typography>
);

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

    // Keep the screen current while it sits open at the stand (Babak, 13 Nov
    // 2026): the attendee count grows as tickets sell, and an unlock shows
    // without a reload. Quiet: a missed refresh keeps what is on screen and
    // shows no error. Skipped while the phone has the page in the background.
    useEffect(() => {
        if (!token) return undefined;
        const id = setInterval(async () => {
            if (document.visibilityState !== 'visible') return;
            try {
                const r = await getExhibitorRoster(token);
                setRoster(r.data);
            } catch (e) { /* keep the last good view */ }
        }, 60000);
        return () => clearInterval(id);
    }, [token]);

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
    // "captured" is the stand's real total; the screen lists the newest 200 and
    // the CSV download has every one of them.
    const captured = roster.captured ?? leads.length;
    const remaining = Math.max(0, (roster.attendees_total || 0) - captured);
    const full = !!roster.full_list;
    const unlocked = !!roster.leads_unlocked;
    const offers = roster.offers || {};

    return (
        <Box sx={{ maxWidth: 560, mx: 'auto', p: 2, pb: 8 }}>
            <Stack direction="row" alignItems="baseline" justifyContent="space-between" flexWrap="wrap" gap={1}>
                <Box>
                    <Typography variant="h5" fontWeight={700}>{roster.company_name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                        {roster.event_name}{roster.booth_number ? ` · Booth ${roster.booth_number}` : ''}
                    </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center">
                    <Chip color="success" label={`${captured} captured`} />
                    {captured > 0 && unlocked && (
                        <Button size="small" href={standLeadsCsvUrl(token)} download>Download CSV</Button>
                    )}
                </Stack>
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
                    {justScanned.attendee?.locked
                        ? <strong>Badge scanned and saved to your leads.</strong>
                        : <strong>{justScanned.attendee?.first_name} {justScanned.attendee?.last_name}</strong>}
                    {!justScanned.attendee?.locked && (justScanned.message ? ` — ${justScanned.message}` : ' added to your leads.')}
                    {/* What this stand may keep of the person: their own details, nothing about the ticket. */}
                    {[justScanned.attendee?.job_title, justScanned.attendee?.company].filter(Boolean).length > 0 && (
                        <div>{[justScanned.attendee?.job_title, justScanned.attendee?.company].filter(Boolean).join(' · ')}</div>
                    )}
                    {justScanned.attendee?.email && (
                        <div><a style={{ color: "inherit", fontWeight: 600 }} href={`mailto:${justScanned.attendee.email}`}>{justScanned.attendee.email}</a></div>
                    )}
                    {justScanned.attendee?.phone && (
                        <div><a style={{ color: "inherit", fontWeight: 600 }} href={`tel:${justScanned.attendee.phone}`}>{justScanned.attendee.phone}</a></div>
                    )}
                    {justScanned.attendee?.locked && (
                        <div>Their details unlock when you buy your leads. Add a note now so you remember them.</div>
                    )}
                    {!justScanned.attendee?.locked && !justScanned.attendee?.email && !justScanned.attendee?.phone && (
                        <div>No contact details shared.</div>
                    )}
                </Alert>
            )}

            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                People you have met
            </Typography>

            {leads.length === 0 ? (
                <Paper variant="outlined" sx={{ p: 2.5, textAlign: 'center', color: 'text.secondary' }}>
                    <Typography variant="body2">
                        {unlocked
                            ? 'Nobody yet. Scan a badge and they appear here, at the top.'
                            : 'Nobody yet. Every badge you scan is saved here, blurred until you unlock your leads.'}
                    </Typography>
                </Paper>
            ) : (
                <Stack spacing={1}>
                    {leads.map((l) => <LeadRow key={l.id} lead={l} token={token} onSaved={load} />)}
                </Stack>
            )}

            {full && <FullList people={roster.attendees || []} token={token} />}

            {!full && remaining > 0 && (
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
                            {unlocked
                                ? 'Scan someone\u2019s badge and their details move up into your list.'
                                : 'Scan someone\u2019s badge and they are saved to your list, blurred until you unlock your leads.'}
                        </Typography>
                    </Alert>
                </>
            )}

            {!full && (
                <Paper variant="outlined" sx={{ mt: 2, p: 2, borderStyle: 'dashed', borderColor: 'success.light' }}>
                    <Typography variant="subtitle2">
                        {unlocked ? 'Want more of the attendees?' : 'Unlock your leads'}
                    </Typography>
                    {offers.scanned_leads && (
                        <OfferLine title="Your scanned leads" offer={offers.scanned_leads}
                            note="Name, company, email and phone of everyone you scan, plus a download. Leads you scan now open too." />
                    )}
                    {(offers.lists || []).map((o, i) => (
                        <OfferLine key={i} title={o.title} offer={o} note={o.note} />
                    ))}
                    {(offers.lists || []).length === 0 && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                            More attendee-list options are coming. Details and prices to be announced.
                        </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                        To buy, ask the Gaia Healers team at the registration desk.
                    </Typography>
                </Paper>
            )}
        </Box>
    );
}

function OfferLine({ title, offer, note }) {
    const price = offer?.status === 'price_set' && offer.price
        ? `$${Number(offer.price).toLocaleString('en-US')}` : 'Price to be announced';
    return (
        <Box sx={{ mt: 1 }}>
            <Stack direction="row" justifyContent="space-between" gap={1}>
                <Typography variant="body2" fontWeight={600}>{title}</Typography>
                <Typography variant="body2" fontWeight={600} color="success.main">{price}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">{note}</Typography>
        </Box>
    );
}

function FullList({ people, token }) {
    const [q, setQ] = useState('');
    const [limit, setLimit] = useState(50);
    const needle = q.trim().toLowerCase();
    const hits = needle
        ? people.filter((p) => [p.first_name, p.last_name, p.company, p.job_title, p.email]
            .filter(Boolean).join(' ').toLowerCase().includes(needle))
        : people;
    return (
        <>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 3, mb: 1 }} gap={1} flexWrap="wrap">
                <Typography variant="subtitle2">Everyone at the event · {people.length}</Typography>
                <Button size="small" variant="outlined" href={standFullListCsvUrl(token)} download>Download full list</Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                Included in your package. Email and phone show where the attendee shares them.
            </Typography>
            <TextField size="small" fullWidth placeholder="Search name, company or email" value={q}
                onChange={(e) => { setQ(e.target.value); setLimit(50); }} sx={{ mb: 1 }} />
            <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
                {hits.slice(0, limit).map((p, i) => {
                    const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Attendee';
                    return (
                        <Box key={p.attendee_id || i} sx={{ px: 2, py: 1.2, borderTop: i ? '1px solid' : 'none', borderColor: 'divider' }}>
                            <Typography variant="body2" fontWeight={600}>{name}</Typography>
                            {(p.job_title || p.company) && (
                                <Typography variant="caption" color="text.secondary" display="block">
                                    {[p.job_title, p.company].filter(Boolean).join(' · ')}
                                </Typography>
                            )}
                            <Typography variant="caption" display="block" sx={{ wordBreak: 'break-all' }}>
                                {p.email && <a style={{ color: 'inherit' }} href={`mailto:${p.email}`}>{p.email}</a>}
                                {p.email && p.phone && ' · '}
                                {p.phone && <a style={{ color: 'inherit' }} href={`tel:${p.phone}`}>{p.phone}</a>}
                            </Typography>
                        </Box>
                    );
                })}
                {hits.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>No match.</Typography>
                )}
            </Paper>
            {hits.length > limit && (
                <Button fullWidth size="small" sx={{ mt: 1 }} onClick={() => setLimit((n) => n + 100)}>
                    Show more ({hits.length - limit} left)
                </Button>
            )}
        </>
    );
}

function LeadRow({ lead, token, onSaved }) {
    const a = lead.attendee || {};
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState(lead.notes || '');
    const [rating, setRating] = useState(lead.rating || 0);
    const [saving, setSaving] = useState(false);
    const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Attendee';

    const [saveError, setSaveError] = useState('');

    const save = async () => {
        setSaving(true);
        setSaveError('');
        try {
            // updatePublicLead(leadId, accessToken, data). Passing the token
            // inside the data object sent it as an object and every save was
            // rejected (422), so notes typed at the stand were lost (audit
            // 7 Nov 2026). An unset rating is 0 in the widget but must be sent
            // as "no rating": the API accepts 1-5 only.
            await updatePublicLead(lead.id, token, { notes: note, rating: rating >= 1 ? rating : null });
            setOpen(false);
            onSaved();
        } catch (e) {
            setSaveError('Not saved — check the connection and press Save again.');
        } finally { setSaving(false); }
    };

    return (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Box sx={{ width: 34, height: 34, borderRadius: '50%', bgcolor: 'primary.main', color: '#fff',
                           display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                           fontWeight: 700, flex: '0 0 auto' }}>
                    {a.locked ? '?' : (name[0] || 'A').toUpperCase()}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    {a.locked ? (
                        <Box aria-label="Locked lead" sx={{ filter: 'blur(4px)', userSelect: 'none' }}>
                            {/* Placeholder bars: the server sent no details for a locked lead. */}
                            <Box sx={{ height: 12, width: '55%', bgcolor: 'text.disabled', opacity: 0.5, borderRadius: 1, mt: 0.4 }} />
                            <Box sx={{ height: 9, width: '38%', bgcolor: 'text.disabled', opacity: 0.3, borderRadius: 1, mt: 0.8 }} />
                        </Box>
                    ) : (
                        <>
                            <Typography variant="body2" fontWeight={600}>{name}</Typography>
                            {a.company && <Typography variant="caption" color="text.secondary" display="block">{a.company}</Typography>}
                        </>
                    )}
                    {/* Only what the attendee agreed to share reaches this screen. */}
                    {a.locked && <Locked when={lead.scanned_at} />}
                    {a.email && <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }}>{a.email}</Typography>}
                    {a.phone && <Typography variant="caption" display="block">{a.phone}</Typography>}
                    {!a.locked && !a.email && !a.phone && (
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
                    {saveError && <Alert severity="error" sx={{ mt: 1 }}>{saveError}</Alert>}
                </Box>
            </Collapse>
        </Paper>
    );
}

export default ExhibitorScan;
