import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    IconButton, Menu, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography, useMediaQuery,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
    ecExhibitorActivity, ecExhibitorCheckContacts, ecExhibitorContact, ecExhibitorCreateContact, ecExhibitorHold, ecExhibitorLink, ecExhibitorManual, ecExhibitorOutcome, ecExhibitorPreview, ecExhibitorSend, ecExhibitors,
} from '../utils/api';
import {
    BatchCard, BatchConfirmDialog, copyText, DeliveryChip, EmailFrame, errText, GatedButton, gst, money, NoteDialog, REFUSED, sendBlock,
} from './EmailCenterShared';

const SETUP_LINK = {
    activated: ['Profile set up', 'success'], valid: ['Link sent / valid', 'info'], created_not_tracked: ['Link created', 'info'],
    expired: ['Link expired', 'warning'], none: ['No link yet', 'default'],
};
const KIND_LABEL = { setup: 'setup', scanner: 'scanner', reminder: 'setup reminder' };
const SENT = new Set(['accepted', 'delivered', 'opened', 'clicked', 'sent_manually', 'bounced']);
// Readiness: can this stand be emailed through GHL right now?
const READY = {
    ready: ['Ready to send', 'success'], missing_email: ['Missing contact email', 'error'],
    missing_ghl_contact: ['Missing GHL contact', 'warning'], not_checked: ['GHL not checked', 'default'],
    do_not_email: ['Do not email (GHL)', 'error'], several_contacts: ['Several GHL contacts', 'warning'],
};
const FLAG = {
    paid_or_comp_scanning_off: ['Paid/comp · scanner off', 'warning'], partially_paid: ['Partially paid · review', 'warning'],
    no_scanner_link: ['No scanner link', 'error'],
    email_changed_by_stand: ['Email changed by stand', 'info'],
    possible_duplicate: ['Possible duplicate stand', 'warning'],
};
// What an admin should do next (server decides; colour here only).
const NEXT_COLOR = {
    on_hold: 'default', add_email: 'error', check_duplicate: 'warning', check_ghl: 'info', create_contact: 'warning',
    resolve_contact: 'error', settle: 'warning', fix_setup: 'error', send_setup: 'primary', wait_setup: 'default',
    remind: 'secondary', decide_scanning: 'warning', send_scanner: 'primary', done: 'success',
};
const FAILED = new Set(['failed', 'bounced', 'unknown', 'refused']);
const kinds = (r) => [r.setup?.status, r.scanner?.status, r.reminder?.status];
// Dashboard filters: [key, label, test]
const FILTERS = [
    ['', 'All', () => true],
    ['action', 'Needs action', (r) => !['done', 'wait_setup', 'on_hold'].includes(r.next_action?.key)],
    ['ready', 'Ready to send', (r) => !r.hold && r.readiness === 'ready' && r.setup?.eligible && !SENT.has(r.setup?.status)],
    ['missing_email', 'Missing email', (r) => r.readiness === 'missing_email'],
    ['missing_ghl_contact', 'Missing GHL contact', (r) => ['missing_ghl_contact', 'several_contacts', 'do_not_email'].includes(r.readiness)],
    ['not_checked', 'GHL not checked', (r) => r.readiness === 'not_checked'],
    ['setup_sent', 'Setup invitation sent', (r) => SENT.has(r.setup?.status)],
    ['setup_completed', 'Setup completed', (r) => r.setup_completed],
    ['setup_pending', 'Invited, setup not completed', (r) => SENT.has(r.setup?.status) && !r.setup_completed],
    ['remind', 'Reminder due', (r) => r.next_action?.key === 'remind'],
    ['reminded', 'Reminder sent', (r) => SENT.has(r.reminder?.status)],
    ['scanner_sent', 'Scanner invitation sent', (r) => SENT.has(r.scanner?.status)],
    ['email_changed', 'Email changed by stand', (r) => Boolean(r.stand_email_change)],
    ['on_hold', 'On hold', (r) => Boolean(r.hold)],
    ['scanner_on', 'Scanner enabled', (r) => r.scanning_enabled],
    ['scanner_off', 'Scanner disabled', (r) => !r.scanning_enabled],
    ['failed', 'Delivery failed', (r) => kinds(r).some((k) => FAILED.has(k))],
    ['manual', 'Manually sent', (r) => kinds(r).includes('sent_manually')],
    ['review', 'Needs admin review', (r) => (r.flags || []).some((f) => FLAG[f] && f !== 'email_changed_by_stand')],
];
const reasonText = (r) => REFUSED[r] || (r ? String(r).replace(/_/g, ' ') : '');

export default function EmailCenterExhibitors({ eventId, me: meIn, focusId }) {
    // Every send control here follows the EXHIBITOR switch, never the ticket one.
    const me = { ...meIn, sending: meIn?.sending_exhibitors || { enabled: false, reason: 'Exhibitor sending is switched off.' } };
    const [filter, setFilter] = useState('');
    const [checking, setChecking] = useState(false);
    const [createAsk, setCreateAsk] = useState(null); // {row, note, confirmed}
    const [activity, setActivity] = useState(null); // {row, items}
    const [holdAsk, setHoldAsk] = useState(null); // {row, hold, reason}
    const narrow = useMediaQuery('(max-width:700px)');
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(null); // {severity, text, row?, kind?}
    const [q, setQ] = useState('');
    const [picked, setPicked] = useState(new Set());
    const [menu, setMenu] = useState(null); // {anchor, row}
    const [contact, setContact] = useState(null); // {row, name, email}
    const [preview, setPreview] = useState(null);
    const [sendAsk, setSendAsk] = useState(null); // {row, kind}
    const [resendReason, setResendReason] = useState('');
    const [noteAsk, setNoteAsk] = useState(null); // {type: manual|outcome, row, kind?}
    const [batchAsk, setBatchAsk] = useState(null);
    const [batchId, setBatchId] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => ecExhibitors(eventId)
        .then((r) => { setRows(r.data.items || []); setError(''); })
        .catch((e) => setError(errText(e)))
        .finally(() => setLoading(false)), [eventId]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (!focusId || !rows.length) return;
        const el = document.getElementById(`ec-ex-${focusId}`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [focusId, rows]);

    const sBlock = sendBlock(me);
    const fTest = (FILTERS.find((f) => f[0] === filter) || FILTERS[0])[2];
    const shown = rows.filter(fTest).filter((r) => !q.trim() || [r.company_name, r.booth_number, r.contact_name, r.contact_email]
        .some((v) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())));
    const toggle = (k) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

    const closeMenu = () => setMenu(null);
    const doPreview = (row, kind) => {
        closeMenu(); setPreview({ loading: true, row, kind });
        ecExhibitorPreview(eventId, row.id, kind).then((r) => setPreview({ ...r.data, row, kind }))
            .catch((e) => { setPreview(null); setError(errText(e)); });
    };
    const copyLink = (row, kind) => {
        closeMenu();
        ecExhibitorLink(eventId, row.id, kind).then((r) => copyText(r.data.url, () => setNotice({
            severity: 'success',
            text: `${kind === 'setup' ? 'Setup' : 'Scanner'} link for ${row.company_name} copied.${r.data.created ? ' A new setup link was created.' : ''} Send it only to this stand's contact.`,
        }))).catch((e) => setError(errText(e)));
    };
    const send = () => {
        const { row, kind } = sendAsk;
        const already = SENT.has(row[kind]?.status);
        setBusy(true);
        ecExhibitorSend(eventId, row.id, already ? { kind, resend_reason: resendReason.trim() } : { kind })
            .then((r) => {
                const s = r.data.state;
                if (s === 'accepted') setNotice({ severity: 'success', text: `${row.company_name}: ${kind} email accepted by GHL.` });
                else if (s === 'refused' || s === 'skipped') setNotice({ severity: 'warning', text: `${row.company_name}: not sent. ${reasonText(r.data.reason)}`, row, kind, reason: r.data.reason });
                else if (s === 'unknown') setNotice({ severity: 'warning', text: `${row.company_name}: GHL gave no clear answer. Check GHL before trying again, then settle the outcome.` });
                else setNotice({ severity: 'error', text: `${row.company_name}: GHL refused the email.${r.data.reason ? ` ${reasonText(r.data.reason)}` : ''}` });
                setSendAsk(null); load();
            })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const saveContact = () => {
        setBusy(true);
        ecExhibitorContact(eventId, contact.row.id, { contact_name: contact.name, contact_email: contact.email })
            .then(() => { setContact(null); setNotice({ severity: 'success', text: 'Contact saved.' }); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const submitNote = ({ note, kind, outcome }) => {
        const { type, row } = noteAsk;
        const k = kind || noteAsk.kind;
        setBusy(true);
        const p = type === 'manual' ? ecExhibitorManual(eventId, row.id, { kind: k, note })
            : ecExhibitorOutcome(eventId, row.id, { kind: k, outcome, note });
        p.then(() => { setNoteAsk(null); setNotice({ severity: 'success', text: type === 'manual' ? `${row.company_name}: ${k} email marked as sent by hand.` : 'Outcome recorded.' }); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };

    const checkContacts = () => {
        setChecking(true);
        ecExhibitorCheckContacts(eventId).then((r) => {
            const t = r.data.results || {};
            setNotice({ severity: 'success', text: `Checked ${r.data.checked} stand email(s) in GHL (read-only): ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing to check'}.` });
            load();
        }).catch((e) => setError(errText(e))).finally(() => setChecking(false));
    };
    const createContact = () => {
        setBusy(true);
        ecExhibitorCreateContact(eventId, createAsk.row.id, { confirm_representative: true, note: createAsk.note.trim() })
            .then((r) => { setNotice({ severity: 'success', text: `${createAsk.row.company_name}: ${r.data.created ? 'GHL contact created' : 'an existing GHL contact was found and used as it is'}.` }); setCreateAsk(null); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const openActivity = (row) => {
        closeMenu(); setActivity({ row, items: null });
        ecExhibitorActivity(eventId, row.id).then((r) => setActivity({ row, items: r.data.items || [] }))
            .catch((e) => { setActivity(null); setError(errText(e)); });
    };
    const saveHold = () => {
        setBusy(true);
        ecExhibitorHold(eventId, holdAsk.row.id, { hold: holdAsk.hold, reason: holdAsk.reason.trim() })
            .then(() => { setNotice({ severity: 'success', text: `${holdAsk.row.company_name}: ${holdAsk.hold ? 'put on hold' : 'hold released'}.` }); setHoldAsk(null); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const counts = Object.fromEntries(FILTERS.map(([k, , t]) => [k, rows.filter(t).length]));

    const m = menu?.row;
    const unknownKinds = (r) => ['setup', 'scanner'].filter((k) => r?.[k]?.status === 'unknown');

    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            {notice && (
                <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 1 }}
                       action={['no_ghl_contact', 'several_ghl_contacts'].includes(notice.reason) ? (
                           <Stack direction="row" spacing={1}>
                               <Button size="small" color="inherit" onClick={() => copyLink(notice.row, notice.kind)}>Copy link</Button>
                               <Button size="small" color="inherit" onClick={() => setNoteAsk({ type: 'manual', row: notice.row, kind: notice.kind })}>Mark sent manually</Button>
                           </Stack>) : undefined}>
                    {notice.text}
                </Alert>
            )}
            {batchId && <Box sx={{ mb: 2 }}><BatchCard eventId={eventId} id={batchId} me={me} onFinished={load} /></Box>}

            <Stack direction={narrow ? 'column' : 'row'} spacing={1} sx={{ mb: 1.5 }} alignItems={narrow ? 'stretch' : 'center'}>
                {me?.exhibitors && (
                    <Button variant="outlined" disabled={checking} onClick={checkContacts}>{checking ? 'Checking GHL…' : 'Check GHL contacts'}</Button>
                )}
                <TextField size="small" label="Search company, booth or contact" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 220 }} />
                {me?.send && (
                    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                        <GatedButton variant="contained" reason={sBlock || (!picked.size ? 'Select stands first.' : '')}
                                     onClick={() => setBatchAsk({ selector: { exhibitor_kind: 'setup', ids: [...picked] }, title: `Send setup email to ${picked.size} stand(s)` })}>
                            Send setup to selected
                        </GatedButton>
                        <GatedButton variant="outlined" reason={sBlock || (!picked.size ? 'Select stands first.' : '')}
                                     onClick={() => setBatchAsk({ selector: { exhibitor_kind: 'reminder', ids: [...picked] }, title: `Send setup reminder to ${picked.size} stand(s)` })}>
                            Send reminder to selected
                        </GatedButton>
                        {me?.scanner_links && (
                            <GatedButton variant="outlined" reason={sBlock || (!picked.size ? 'Select stands first.' : '')}
                                         onClick={() => setBatchAsk({ selector: { exhibitor_kind: 'scanner', ids: [...picked] }, title: `Send scanner email to ${picked.size} stand(s)` })}>
                                Send scanner to selected
                            </GatedButton>
                        )}
                    </Stack>
                )}
            </Stack>

            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                {FILTERS.map(([k, l]) => (
                    <Chip key={k || 'all'} label={`${l} ${counts[k] ?? 0}`} clickable onClick={() => setFilter(k)}
                          color={filter === k ? 'primary' : 'default'} variant={filter === k ? 'filled' : 'outlined'} />
                ))}
            </Stack>

            <Card variant="outlined">
                <Box sx={{ overflowX: 'auto' }}>
                    {loading ? <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box> : (
                        <Table size="small" sx={{ minWidth: 1400 }}>
                            <TableHead><TableRow>
                                <TableCell padding="checkbox">
                                    <Checkbox size="small" checked={allPicked} indeterminate={picked.size > 0 && !allPicked} inputProps={{ 'aria-label': 'Select all shown' }}
                                              onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((r) => r.id)))} />
                                </TableCell>
                                <TableCell>Booth</TableCell><TableCell>Company</TableCell><TableCell>Next action</TableCell><TableCell>Status</TableCell><TableCell>Contact</TableCell><TableCell>Email</TableCell>
                                <TableCell>Payment</TableCell><TableCell>Profile setup</TableCell><TableCell>Scanner</TableCell><TableCell>Scanner link</TableCell>
                                <TableCell>Setup email</TableCell><TableCell>Reminder</TableCell><TableCell>Scanner email</TableCell><TableCell>Last sent</TableCell>
                                <TableCell>First scan</TableCell><TableCell align="right">Leads</TableCell><TableCell>Actions</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {shown.map((r) => {
                                    const [sl, sc] = SETUP_LINK[r.setup_link] || [r.setup_link || '—', 'default'];
                                    const lastSent = [r.setup?.last_sent, r.scanner?.last_sent].filter(Boolean).sort().pop();
                                    return (
                                        <TableRow key={r.id} id={`ec-ex-${r.id}`} hover selected={picked.has(r.id) || String(focusId) === String(r.id)}>
                                            <TableCell padding="checkbox">
                                                <Checkbox size="small" checked={picked.has(r.id)} onChange={() => toggle(r.id)} inputProps={{ 'aria-label': `Select ${r.company_name}` }} />
                                            </TableCell>
                                            <TableCell>{r.booth_number || '—'}</TableCell>
                                            <TableCell>{r.company_name}</TableCell>
                                            <TableCell sx={{ minWidth: 160 }}>
                                                <Chip size="small" label={r.next_action?.label || '—'} color={NEXT_COLOR[r.next_action?.key] || 'default'}
                                                      variant={['wait_setup', 'done', 'on_hold'].includes(r.next_action?.key) ? 'outlined' : 'filled'} />
                                                {r.hold && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.hold.reason} · {r.hold.by}</Typography>}
                                            </TableCell>
                                            <TableCell sx={{ minWidth: 170 }}>
                                                <Stack spacing={0.5} alignItems="flex-start">
                                                    {(() => { const [l, c] = READY[r.readiness] || [r.readiness || '—', 'default']; return <Chip size="small" label={l} color={c} />; })()}
                                                    {(r.flags || []).filter((f) => FLAG[f]).map((f) => <Chip key={f} size="small" variant="outlined" label={FLAG[f][0]} color={FLAG[f][1]} />)}
                                                    {r.stand_email_change && <Typography variant="caption" color="info.main">Changed by the stand {gst(r.stand_email_change.at)}{r.stand_email_change.old ? ` (was ${r.stand_email_change.old})` : ''}</Typography>}
                                                    {r.possible_duplicate && <Typography variant="caption" color="warning.main">Pending online purchase: {r.possible_duplicate.name}{r.possible_duplicate.package ? ` (${r.possible_duplicate.package})` : ''}</Typography>}
                                                    {r.ghl_contact?.checked_at && <Typography variant="caption" color="text.secondary">GHL checked {gst(r.ghl_contact.checked_at)}</Typography>}
                                                </Stack>
                                            </TableCell>
                                            <TableCell>{r.contact_name || '—'}</TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                                {r.email_valid ? r.contact_email : <Chip size="small" color="error" label="Missing contact email" />}
                                                <Button size="small" onClick={() => setContact({ row: r, name: r.contact_name || '', email: r.contact_email || '' })}>Edit</Button>
                                            </TableCell>
                                            <TableCell>
                                                {r.payment_status || '—'}{r.package ? ` · ${r.package}` : ''}
                                                {r.amount_mismatch && <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>Paid {money(r.amount_paid)} of {money(r.amount_due)}</Typography>}
                                            </TableCell>
                                            <TableCell>
                                                <Chip size="small" variant="outlined" label={sl} color={sc} />
                                                {r.profile_activated_at && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{gst(r.profile_activated_at)}</Typography>}
                                            </TableCell>
                                            <TableCell><Chip size="small" label={r.scanning_enabled ? 'On' : 'Off'} color={r.scanning_enabled ? 'success' : 'default'} /></TableCell>
                                            <TableCell>{r.scanning_enabled ? (r.scanner_link_available ? 'Available' : 'Not available') : '—'}</TableCell>
                                            <TableCell>
                                                <DeliveryChip s={r.setup?.status} />
                                                {r.setup?.last_error && <Typography variant="caption" color="error" sx={{ display: 'block' }}>{reasonText(r.setup.last_error)}</Typography>}
                                            </TableCell>
                                            <TableCell><DeliveryChip s={r.reminder?.status} /></TableCell>
                                            <TableCell>
                                                <DeliveryChip s={r.scanner?.status} />
                                                {r.scanner?.last_error && <Typography variant="caption" color="error" sx={{ display: 'block' }}>{reasonText(r.scanner.last_error)}</Typography>}
                                            </TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(lastSent)}</TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(r.first_scan_at)}</TableCell>
                                            <TableCell align="right">{r.leads ?? 0}</TableCell>
                                            <TableCell>
                                                <IconButton size="small" aria-label={`Actions for ${r.company_name}`} onClick={(e) => setMenu({ anchor: e.currentTarget, row: r })}><MoreVertIcon fontSize="small" /></IconButton>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                                {!shown.length && <TableRow><TableCell colSpan={18}>No stands match.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    )}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                    {shown.length} stand(s){picked.size ? ` · ${picked.size} selected` : ''}. Scanning is switched on/off in Exhibitors, not here.
                </Typography>
            </Card>

            <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={closeMenu}>
                {m && [
                    <MenuItem key="ps" onClick={() => doPreview(m, 'setup')}>Preview setup email</MenuItem>,
                    <MenuItem key="pr" onClick={() => doPreview(m, 'reminder')}>Preview setup reminder</MenuItem>,
                    me?.send && <MenuItem key="ss" disabled={Boolean(sBlock) || !m.setup?.eligible} onClick={() => { closeMenu(); setResendReason(''); setSendAsk({ row: m, kind: 'setup' }); }}>
                        Send setup email{!m.setup?.eligible ? (m.email_valid ? ' (profile already set up)' : ' (no contact email)') : ''}</MenuItem>,
                    <MenuItem key="cs" onClick={() => copyLink(m, 'setup')}>Copy setup link</MenuItem>,
                    me?.send && <MenuItem key="rm" disabled={Boolean(sBlock) || !m.reminder?.eligible} onClick={() => { closeMenu(); setResendReason(''); setSendAsk({ row: m, kind: 'reminder' }); }}>
                        Send setup reminder{!m.reminder?.eligible ? (m.setup_completed ? ' (already set up)' : m.hold ? ' (on hold)' : ' (send setup first)') : ''}</MenuItem>,
                    me?.scanner_links && <MenuItem key="pc" onClick={() => doPreview(m, 'scanner')}>Preview scanner email</MenuItem>,
                    me?.scanner_links && me?.send && m.scanner?.eligible && (
                        <MenuItem key="sc" disabled={Boolean(sBlock)} onClick={() => { closeMenu(); setResendReason(''); setSendAsk({ row: m, kind: 'scanner' }); }}>Send scanner email</MenuItem>),
                    me?.scanner_links && m.scanning_enabled && <MenuItem key="cc" onClick={() => copyLink(m, 'scanner')}>Copy scanner link</MenuItem>,
                    <MenuItem key="ac" onClick={() => openActivity(m)}>Activity</MenuItem>,
                    me?.exhibitors && <MenuItem key="hd" onClick={() => { closeMenu(); setHoldAsk({ row: m, hold: !m.hold, reason: '' }); }}>{m.hold ? 'Release hold…' : 'Put on hold…'}</MenuItem>,
                    me?.platform_admin && ['missing_ghl_contact', 'not_checked'].includes(m.readiness) && m.email_valid && (
                        <MenuItem key="gc" onClick={() => { closeMenu(); setCreateAsk({ row: m, note: '', confirmed: false }); }}>Create GHL contact…</MenuItem>),
                    <MenuItem key="mm" onClick={() => { closeMenu(); setNoteAsk({ type: 'manual', row: m }); }}>Mark sent manually</MenuItem>,
                    me?.send && unknownKinds(m).length > 0 && (
                        <MenuItem key="so" onClick={() => { closeMenu(); setNoteAsk({ type: 'outcome', row: m }); }}>Settle uncertain outcome</MenuItem>),
                ].filter(Boolean)}
            </Menu>

            {/* Send confirmation */}
            <Dialog open={Boolean(sendAsk)} onClose={() => setSendAsk(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {sendAsk && <>
                    <DialogTitle>Send {KIND_LABEL[sendAsk.kind]} email to {sendAsk.row.company_name}</DialogTitle>
                    <DialogContent dividers>
                        {me?.sending?.fake_gateway && <Alert severity="info" sx={{ mb: 1 }}>Test mode — emails go to a simulated mailbox; nothing reaches anyone.</Alert>}
                        <Typography variant="body2">To: <b>{sendAsk.row.contact_email}</b>{sendAsk.row.contact_name ? ` (${sendAsk.row.contact_name})` : ''}</Typography>
                        <Typography variant="body2" sx={{ mb: 2 }}>Booth {sendAsk.row.booth_number || '—'}</Typography>
                        {SENT.has(sendAsk.row[sendAsk.kind]?.status) && <>
                            <Alert severity="warning" sx={{ mb: 1 }}>
                                This email was already {String(sendAsk.row[sendAsk.kind].status).replace(/_/g, ' ')} ({gst(sendAsk.row[sendAsk.kind].last_sent)}). Say why it should go again.
                            </Alert>
                            <TextField fullWidth multiline minRows={2} label="Reason for resending (required)" value={resendReason} onChange={(e) => setResendReason(e.target.value)} />
                        </>}
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setSendAsk(null)}>Cancel</Button>
                        <GatedButton variant="contained" reason={sBlock}
                                     disabled={busy || (SENT.has(sendAsk.row[sendAsk.kind]?.status) && !resendReason.trim())} onClick={send}>
                            {busy ? 'Sending…' : 'Send now'}
                        </GatedButton>
                    </DialogActions>
                </>}
            </Dialog>

            {/* Contact */}
            <Dialog open={Boolean(contact)} onClose={() => setContact(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {contact && <>
                    <DialogTitle>Edit contact — {contact.row.company_name}</DialogTitle>
                    <DialogContent dividers>
                        <TextField fullWidth label="Contact name" sx={{ mb: 2, mt: 1 }} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
                        <TextField fullWidth label="Contact email" type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setContact(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy} onClick={saveContact}>Save</Button>
                    </DialogActions>
                </>}
            </Dialog>

            {/* Manual / outcome */}
            <NoteDialog open={noteAsk?.type === 'manual'} busy={busy} title={`Mark sent manually — ${noteAsk?.row?.company_name || ''}`}
                        help="Record that you sent this email yourself (for example after copying the link). Say how and when."
                        fields={noteAsk?.kind ? [] : [{ key: 'kind', label: 'Which email', options: [['setup', 'Setup email'], ...(me?.scanner_links ? [['scanner', 'Scanner email']] : [])] }]}
                        confirmLabel="Mark sent" onClose={() => setNoteAsk(null)} onConfirm={submitNote} />
            <NoteDialog open={noteAsk?.type === 'outcome'} busy={busy} title={`Settle uncertain outcome — ${noteAsk?.row?.company_name || ''}`} noteLabel="How you checked GHL"
                        help="The send got no clear answer. Look the email up in GHL first, then record what GHL shows."
                        fields={[
                            { key: 'kind', label: 'Which email', options: unknownKinds(noteAsk?.row).map((k) => [k, k === 'setup' ? 'Setup email' : 'Scanner email']) },
                            { key: 'outcome', label: 'What GHL shows', options: [['sent', 'I checked GHL: it WAS sent'], ['not_sent', 'I checked GHL: it was NOT sent']] },
                        ]}
                        confirmLabel="Record outcome" onClose={() => setNoteAsk(null)} onConfirm={submitNote} />

            {/* Preview */}
            <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} fullWidth maxWidth="md" fullScreen={narrow}>
                <DialogTitle>{preview?.kind === 'scanner' ? 'Scanner' : 'Setup'} email — {preview?.row?.company_name}</DialogTitle>
                <DialogContent dividers>
                    {preview?.loading ? <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box> : preview && <>
                        <Typography variant="body2"><b>To:</b> {preview.recipient || <span style={{ color: 'red' }}>no contact email</span>}</Typography>
                        <Typography variant="body2" sx={{ mb: 1 }}><b>Subject:</b> {preview.subject}</Typography>
                        <EmailFrame html={preview.html} title="Exhibitor email preview" />
                    </>}
                </DialogContent>
                <DialogActions><Button onClick={() => setPreview(null)}>Close</Button></DialogActions>
            </Dialog>

            {batchAsk && (
                <BatchConfirmDialog eventId={eventId} selector={batchAsk.selector} title={batchAsk.title} me={me}
                                    onClose={() => setBatchAsk(null)}
                                    onStarted={(bid) => { setBatchAsk(null); setBatchId(bid); setPicked(new Set()); load(); }} />
            )}
            {/* Create GHL contact: admin, deliberate, one stand */}
            <Dialog open={Boolean(createAsk)} onClose={() => setCreateAsk(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {createAsk && <>
                    <DialogTitle>Create GHL contact — {createAsk.row.company_name}</DialogTitle>
                    <DialogContent dividers>
                        <Typography variant="body2" sx={{ mb: 1 }}>Email: <b>{createAsk.row.contact_email}</b>{createAsk.row.contact_name ? ` (${createAsk.row.contact_name})` : ''}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                            GHL is checked first: an existing contact is used as it is. Otherwise one contact is created with no tags and the source
                            "Gaia Healers event - Exhibitor". No email is sent.
                        </Typography>
                        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
                            <Checkbox checked={createAsk.confirmed} onChange={(e) => setCreateAsk({ ...createAsk, confirmed: e.target.checked })} />
                            <Typography variant="body2">I confirm this address belongs to the stand's authorised representative.</Typography>
                        </Stack>
                        <TextField fullWidth multiline minRows={2} label="How you know (required)" value={createAsk.note} onChange={(e) => setCreateAsk({ ...createAsk, note: e.target.value })} />
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setCreateAsk(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy || !createAsk.confirmed || createAsk.note.trim().length < 5} onClick={createContact}>
                            {busy ? 'Working…' : 'Create contact'}
                        </Button>
                    </DialogActions>
                </>}
            </Dialog>

            {/* Activity trail */}
            <Dialog open={Boolean(activity)} onClose={() => setActivity(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {activity && <>
                    <DialogTitle>Activity — {activity.row.company_name}</DialogTitle>
                    <DialogContent dividers>
                        {!activity.items ? <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={22} /></Box>
                            : !activity.items.length ? <Typography variant="body2">Nothing recorded yet.</Typography>
                                : activity.items.map((it, i) => (
                                    <Box key={i} sx={{ py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
                                        <Typography variant="body2"><b>{it.what}</b></Typography>
                                        <Typography variant="caption" color="text.secondary">{gst(it.at)} · {it.actor || '—'}{it.note ? ` · ${it.note}` : ''}</Typography>
                                    </Box>
                                ))}
                    </DialogContent>
                    <DialogActions><Button onClick={() => setActivity(null)}>Close</Button></DialogActions>
                </>}
            </Dialog>
            {/* Hold / release */}
            <Dialog open={Boolean(holdAsk)} onClose={() => setHoldAsk(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                {holdAsk && <>
                    <DialogTitle>{holdAsk.hold ? 'Put on hold' : 'Release hold'} — {holdAsk.row.company_name}</DialogTitle>
                    <DialogContent dividers>
                        <Typography variant="body2" sx={{ mb: 2 }}>
                            {holdAsk.hold ? 'No exhibitor email (setup, reminder or scanner) can be sent to this stand while it is on hold. Payment, scanning and the listing do not change.'
                                : 'The stand can be emailed again.'}
                        </Typography>
                        <TextField autoFocus fullWidth multiline minRows={2} label="Reason (required)" value={holdAsk.reason} onChange={(e) => setHoldAsk({ ...holdAsk, reason: e.target.value })} />
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setHoldAsk(null)}>Cancel</Button>
                        <Button variant="contained" disabled={busy || holdAsk.reason.trim().length < 3} onClick={saveHold}>{busy ? 'Saving…' : holdAsk.hold ? 'Put on hold' : 'Release'}</Button>
                    </DialogActions>
                </>}
            </Dialog>
        </Box>
    );
}
