import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Typography, Button, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, TableSortLabel, Paper, Dialog, DialogTitle, DialogContent, DialogActions,
    TextField, IconButton, Chip, Alert, Checkbox, FormControlLabel, InputAdornment,
    MenuItem, Snackbar, Stack, CircularProgress, Divider, useMediaQuery, useTheme,
} from '@mui/material';
import {
    Print as PrintIcon,
    Add as AddIcon, Delete as DeleteIcon, QrCode as QrCodeIcon, Badge as BadgeIcon,
    UploadFile as UploadFileIcon, Edit as EditIcon, Search as SearchIcon, Clear as ClearIcon,
    ManageAccounts as ManageIcon, OpenInNew as OpenInNewIcon,
    InfoOutlined as InfoOutlinedIcon,
} from '@mui/icons-material';
import { QRCodeSVG } from 'qrcode.react';
import {
    getAttendees, getAttendee, getTicketCounts, createAttendee, updateAttendee, deleteAttendee,
    generateBadge, importAttendees, searchAttendees, getTicketTypes, exportAttendees,
    revokeAttendee, reinstateAttendee, changePass, setAddonDay,
    getAcquisitionReport, badgeLabelBlob , getDoorReport} from '../utils/api';
import { formatVenueTime, STATUS_LABELS, statusLabel } from '../utils/datetime';

// The organiser's GHL location, for the authoritative refund/payment record.
const GHL_LOCATION = 'WkKl1K5RuZNQ60xR48k6';
// Human-readable lifecycle names — the admin never reads raw action codes.
const LIFECYCLE_LABELS = {
    purchased: 'Ticket purchased', addon_added: 'Add-on purchased', day_selected: 'Conference day selected',
    upgraded: 'Upgraded', refunded: 'Refunded', refund_recorded: 'Refund recorded',
    partial_refund: 'Partial refund', upgrade_refunded: 'Upgrade refunded',
    comp_upgrade: 'Complimentary upgrade', comp_downgrade: 'Complimentary downgrade',
    revoked: 'Access revoked', reinstated: 'Reinstated', reactivated: 'Reactivated',
    cancelled: 'Cancelled', mapping_correction: 'Mapping correction applied',
};
const KIND_COLOR = { 'base ticket': 'primary', 'add-on': 'success', upgrade: 'secondary' };

function Attendees({ timezone }) {
    const { id: eventId } = useParams();
    const compact = useMediaQuery(useTheme().breakpoints.down('md'));
    const [attendees, setAttendees] = useState([]);
    const [counts, setCounts] = useState(null);
    const [ticketTypes, setTicketTypes] = useState([]);
    const [openDialog, setOpenDialog] = useState(false);
    const [openImportDialog, setOpenImportDialog] = useState(false);
    const [openQR, setOpenQR] = useState(false);
    const [selectedAttendee, setSelectedAttendee] = useState(null);
    const [importFile, setImportFile] = useState(null);
    const [markPaidMember, setMarkPaidMember] = useState(true);
    const [importSource, setImportSource] = useState('paid_member_csv');
    const [importResult, setImportResult] = useState(null);
    const [importing, setImporting] = useState(false);
    const [query, setQuery] = useState('');
    // Acquisition filters + the purchase/attribution detail panel.
    const [acqDialog, setAcqDialog] = useState(null);
    const [acqDetail, setAcqDetail] = useState(null);
    const [report, setReport] = useState(null);
    const [reportLevel, setReportLevel] = useState('by_source');
    const [showReport, setShowReport] = useState(true);
    const [door, setDoor] = useState(null);
    const [showDoor, setShowDoor] = useState(false);
    const [sortBy, setSortBy] = useState('');
    const [sortDir, setSortDir] = useState('asc');
    const [fFunnel, setFFunnel] = useState('');
    const [fDomain, setFDomain] = useState('');
    const [fUtm, setFUtm] = useState('');
    const [fPage, setFPage] = useState('');
    const [fSource, setFSource] = useState('');
    const [fProduct, setFProduct] = useState('');
    const [fFrom, setFFrom] = useState('');
    const [fTo, setFTo] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);
    const [editing, setEditing] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [feedback, setFeedback] = useState(null);
    // filters
    const [fCheck, setFCheck] = useState('');
    const [fStatus, setFStatus] = useState('');
    const [fBase, setFBase] = useState('');
    const [fAddon, setFAddon] = useState('');
    const [newAttendee, setNewAttendee] = useState({ first_name: '', last_name: '', email: '', company: '', job_title: '', phone: '' });
    // manage
    const [manage, setManage] = useState(null);
    const [manageDetail, setManageDetail] = useState(null);
    const [manageBusy, setManageBusy] = useState(false);
    const [manageTier, setManageTier] = useState('');
    const [manageReason, setManageReason] = useState('');
    const [dayValue, setDayValue] = useState('');
    const [dayBusy, setDayBusy] = useState(false);
    const dayLabelFromISO = (iso) => { try { return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); } catch (e) { return iso; } };
    const doSetDay = async () => {
        if (!dayValue) return; setDayBusy(true);
        try {
            await setAddonDay(manage.id, { addon_code: 'ONE_DAY_CONFERENCE', day_label: dayLabelFromISO(dayValue), day_date: dayValue, reason: manageReason });
            getAttendee(manage.id).then((r) => setManageDetail(r.data)).catch(() => {});
            await refreshCurrentView(); loadCounts();
            setFeedback({ severity: 'success', message: 'Conference day set to ' + dayLabelFromISO(dayValue) }); setDayValue('');
        } catch (e) { setFeedback({ severity: 'error', message: e.response?.data?.detail || 'Could not set the day.' }); }
        finally { setDayBusy(false); }
    };

    useEffect(() => {
        setAttendees([]); setResults(null); setQuery(''); setEditing(null); setConfirmDelete(null);
        loadAttendees(); loadCounts();
        getTicketTypes(eventId).then((r) => setTicketTypes(r.data || [])).catch(() => setTicketTypes([]));
    }, [eventId]);

    useEffect(() => {
        const term = query.trim();
        if (!term) { setResults(null); return undefined; }
        setSearching(true);
        const timer = setTimeout(async () => {
            try { const response = await searchAttendees(eventId, term); setResults(response.data); }
            catch (error) { setFeedback({ severity: 'error', message: 'Search failed.' }); }
            finally { setSearching(false); }
        }, 300);
        return () => clearTimeout(timer);
    }, [query, eventId]);

    const loadAttendees = async () => {
        try { const response = await getAttendees(eventId); setAttendees(response.data); }
        catch (error) { console.error('Failed to load attendees:', error); }
    };
    const loadCounts = () => getTicketCounts(eventId).then((r) => setCounts(r.data)).catch(() => setCounts(null));

    const handleCreate = async () => {
        try {
            await createAttendee({ ...newAttendee, event_id: parseInt(eventId) });
            setOpenDialog(false);
            setNewAttendee({ first_name: '', last_name: '', email: '', company: '', job_title: '', phone: '' });
            loadAttendees(); loadCounts();
        } catch (error) {
            setFeedback({ severity: 'error', message: error.response?.data?.detail || 'Could not add attendee.' });
        }
    };

    const openManage = (attendee) => {
        setManage(attendee); setManageDetail(null);
        setManageTier(attendee.ticket_type_id ?? ''); setManageReason('');
        getAttendee(attendee.id).then((r) => setManageDetail(r.data)).catch(() => setManageDetail(null));
    };
    const lifecycleOf = (a) => ((a && a.custom_data && a.custom_data.lifecycle) || []);
    const orderIdOf = (a) => (a && a.custom_data && a.custom_data.order_id) || null;
    const contactIdOf = (a) => (a && a.custom_data && a.custom_data.contact_id) || null;
    const sourceOf = (a) => (a && a.custom_data && a.custom_data.source) || null;
    const effOf = (a) => (a && a.effective_access) || null;
    const addonsOf = (a) => (effOf(a)?.addons) || [];
    const ticketStatusOf = (a) => { const s = (a.registration_status || 'active').toLowerCase(); return (s === 'registered' || s === '') ? 'active' : s; };

    const afterManage = async (updated) => {
        if (updated) { setManage(updated); getAttendee(updated.id).then((r) => setManageDetail(r.data)).catch(() => {}); }
        await refreshCurrentView(); loadCounts();
    };
    const doRevoke = async () => { setManageBusy(true); try { const { data } = await revokeAttendee(manage.id, manageReason); await afterManage(data); } finally { setManageBusy(false); } };
    const doReinstate = async () => { setManageBusy(true); try { const { data } = await reinstateAttendee(manage.id, manageReason); await afterManage(data); } finally { setManageBusy(false); } };
    const doChangePass = async (allowDowngrade) => {
        if (!manageTier) return;
        setManageBusy(true);
        try {
            const { data } = await changePass(manage.id, { ticket_type_id: Number(manageTier), reason: manageReason, complimentary: true, allow_downgrade: !!allowDowngrade });
            await afterManage(data);
        } catch (e) {
            if (e.response && e.response.status === 409 && window.confirm('This is a downgrade. Apply it anyway?')) { setManageBusy(false); return doChangePass(true); }
        } finally { setManageBusy(false); }
    };

    const openEdit = (attendee) => setEditing({
        id: attendee.id, email: attendee.email || '', first_name: attendee.first_name || '', last_name: attendee.last_name || '',
        company: attendee.company || '', job_title: attendee.job_title || '', phone: attendee.phone || '',
        registration_status: attendee.registration_status || 'registered', ticket_type_id: attendee.ticket_type_id ?? '',
    });
    const saveEdit = async () => {
        const { id, ...changes } = editing;
        changes.ticket_type_id = changes.ticket_type_id === '' ? null : Number(changes.ticket_type_id);
        try {
            await updateAttendee(id, changes); setEditing(null);
            setFeedback({ severity: 'success', message: 'Attendee updated.' });
            await refreshCurrentView(); loadCounts();
        } catch (error) { setFeedback({ severity: 'error', message: error.response?.data?.detail || 'Could not save those changes.' }); }
    };

    const refreshCurrentView = async () => {
        await loadAttendees();
        if (query.trim()) { try { const response = await searchAttendees(eventId, query.trim()); setResults(response.data); } catch (error) { /* list is still correct */ } }
    };

    const displayName = (attendee) => (`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || attendee.email);

    const handleDelete = async () => {
        const attendee = confirmDelete;
        try { await deleteAttendee(attendee.id); setConfirmDelete(null); setFeedback({ severity: 'success', message: `${displayName(attendee)} deleted.` }); await refreshCurrentView(); loadCounts(); }
        catch (error) { setConfirmDelete(null); setFeedback({ severity: 'error', message: 'Could not delete that attendee.' }); }
    };

    const showQR = (attendee) => { setSelectedAttendee(attendee); setOpenQR(true); };
    const downloadBadge = async (attendee) => {
        try { const response = await generateBadge(attendee.id); const link = document.createElement('a'); link.href = response.data.badge_pdf; link.download = response.data.filename; link.click(); }
        catch (error) { console.error('Failed to generate badge:', error); }
    };
    const handleExport = async () => {
        try {
            const res = await exportAttendees(eventId);
            const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
            const a = document.createElement('a'); a.href = url; a.download = `attendees_event_${eventId}.csv`;
            document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
        } catch (e) { /* no-op */ }
    };

    const handleImport = async () => {
        if (!importFile) { setImportResult({ severity: 'error', message: 'Choose a CSV file first.' }); return; }
        setImporting(true); setImportResult(null);
        try {
            const response = await importAttendees(eventId, importFile, { markPaidMember, source: importSource });
            const { imported, skipped, errors } = response.data;
            setImportResult({ severity: 'success', message: `Imported ${imported} attendee${imported === 1 ? '' : 's'}. Skipped ${skipped}.`, errors });
            await loadAttendees(); loadCounts();
        } catch (error) { setImportResult({ severity: 'error', message: error.response?.data?.detail || 'Import failed.' }); }
        finally { setImporting(false); }
    };
    const closeImportDialog = () => { setOpenImportDialog(false); setImportFile(null); setImportResult(null); };
    const downloadSampleCsv = () => {
        const rows = [
            ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Job Title', 'Paid Member', 'Pass Type', 'Interests'],
            ['Ada', 'Lovelace', 'ada@example.com', '555-0100', 'Example Institute', 'Speaker', 'yes', 'Full Pass', 'Analytical engines'],
        ];
        const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'gaia-attendees-sample.csv'; link.click(); URL.revokeObjectURL(link.href);
    };

    const checkedInAt = (attendee) => formatVenueTime(attendee.checked_in_at, timezone);
    const statusChip = (attendee) => {
        const st = (attendee.registration_status || 'active').toLowerCase();
        if (st === 'refunded' || st === 'cancelled' || st === 'revoked') return <Chip size="small" color="error" label={LIFECYCLE_LABELS[st] || st} />;
        if (attendee.is_checked_in) return <Chip size="small" color="success" label="Checked In" />;
        return <Chip size="small" label={statusLabel(attendee)} />;
    };

    // The one place base + add-ons render together, straight from the resolver.
    const accessCell = (attendee) => {
        const ea = effOf(attendee);
        const base = ea?.base_ticket?.name || (attendee.ticket_type_id ? '—' : 'No ticket');
        const addons = addonsOf(attendee);
        return (
            <Box>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{base}</Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
                    {addons.map((ad) => (
                        <Chip key={ad.code} size="small" color="success" variant="outlined"
                            label={`+ ${ad.label}${ad.day ? ` · ${ad.day}` : ' · day TBD'}`} />
                    ))}
                </Stack>
            </Box>
        );
    };

    // The thermal sticker for this person, opened in a tab for a quick print.
    const openLabel = async (attendee) => {
        try {
            const response = await badgeLabelBlob(eventId, attendee.id, (localStorage.getItem('gha_label_size') || '40x60'));
            window.open(URL.createObjectURL(response.data), '_blank', 'noopener');
        } catch (error) { console.error('Failed to render label:', error); }
    };

    const rowActions = (attendee) => (
        <>
            <IconButton size="small" onClick={() => openManage(attendee)} aria-label="Manage / view"><ManageIcon /></IconButton>
            <IconButton size="small" onClick={() => showQR(attendee)} aria-label="Show QR code"><QrCodeIcon /></IconButton>
            <IconButton size="small" onClick={() => openEdit(attendee)} aria-label="Edit attendee"><EditIcon /></IconButton>
            <IconButton size="small" onClick={() => downloadBadge(attendee)} aria-label="Download badge"><BadgeIcon /></IconButton>
            <IconButton size="small" onClick={() => openLabel(attendee)} aria-label="Badge sticker (name + QR)" title="Badge sticker (name + QR)"><PrintIcon /></IconButton>
            <IconButton size="small" color="error" onClick={() => setConfirmDelete(attendee)} aria-label="Delete attendee"><DeleteIcon /></IconButton>
        </>
    );

    const applyFilters = (list) => list.filter((a) => {
        const ea = a.effective_access || {};
        if (fCheck === 'in' && !a.is_checked_in) return false;
        if (fCheck === 'out' && a.is_checked_in) return false;
        if (fStatus && (ea.status || ticketStatusOf(a)) !== fStatus) return false;
        if (fBase && (ea.base_ticket?.code || 'none') !== fBase) return false;
        if (fAddon && !(ea.addons || []).some((x) => x.code === fAddon)) return false;
        if (fFunnel && (a.acq_funnel_name || '') !== fFunnel) return false;
        if (fDomain && (a.acq_domain || '') !== fDomain) return false;
        if (fUtm && (a.acq_utm_source || '(none)') !== fUtm) return false;
        if (fPage && (a.acq_page_name || '') !== fPage) return false;
        if (fSource && (a.acq_source_value || a.acq_saw_on || '') !== fSource) return false;
        if (fProduct && (a.acq_product_name || '') !== fProduct) return false;
        if (fFrom && (!a.acq_purchased_at || a.acq_purchased_at.slice(0, 10) < fFrom)) return false;
        if (fTo && (!a.acq_purchased_at || a.acq_purchased_at.slice(0, 10) > fTo)) return false;
        return true;
    });
    // Where the ticket was actually bought, and when. Never invented: a field
    // GHL did not capture renders as "Not captured", not as a guess.
    // The acquisition source is only as strong as the evidence behind it. These
    // labels are shown next to the value so a contact-level guess is never read
    // as proof that THIS purchase came from that place.
    const BASIS_LABEL = {
        purchase_session_referrer: 'Referrer captured in this purchase session',
        purchase_session_utm: 'UTM captured in this purchase session',
        last_touch_referrer: 'Most recent referrer on the contact (session not provable)',
        last_touch_utm: 'Most recent UTM on the contact (session not provable)',
        contact_first_touch_referrer: 'Contact attribution - first ever visit, not this purchase',
        contact_first_touch_utm: 'Contact attribution - first ever visit, not this purchase',
        ghl_session_source: 'GHL session classification only - no referrer or UTM',
        direct_no_referrer: 'No referrer or UTM was captured',
        unknown: 'Nothing captured',
    };
    const basisStrong = (b) => b === 'purchase_session_referrer' || b === 'purchase_session_utm';
    const NC = <Typography component="span" variant="caption" color="text.disabled">Not captured</Typography>;
    const fmtWhen = (iso) => {
        if (!iso) return null;
        const d = new Date(iso);
        if (isNaN(d)) return null;
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    };
    const acquisitionCell = (a) => {
        const when = fmtWhen(a.acq_purchased_at);
        if (!a.acq_funnel_name && !when) {
            return <Chip size="small" variant="outlined" label={sourceOf(a) || 'Not captured'} />;
        }
        return (
            <Box sx={{ minWidth: 170 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.25 }}>
                    {a.acq_funnel_name || 'Not captured'}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                    {a.acq_domain || 'Not captured'}{a.acq_page_name ? ` · ${a.acq_page_name}` : ''}
                </Typography>

                {(a.acq_source_value || a.acq_saw_on) && (
                    <Chip size="small" variant="outlined"
                        color={basisStrong(a.acq_source_basis) ? 'success' : 'default'}
                        title={BASIS_LABEL[a.acq_source_basis] || 'Basis not recorded'}
                        sx={{ mt: 0.5, height: 18, fontSize: '.65rem' }}
                        label={a.acq_source_value || a.acq_saw_on} />
                )}
            </Box>
        );
    };
    // The panel shows EFFECTIVE access and the transactions behind it, which the
    // list row does not carry - so open() fetches the authoritative record.
    const openAcq = async (a) => {
        setAcqDialog(a); setAcqDetail(null);
        try { setAcqDetail(await getAttendee(a.id)); } catch (e) { setAcqDetail(null); }
    };
    useEffect(() => {
        // Sales figures are computed server-side: revenue must be summed from the
        // recorded transaction amounts, and one attendee can hold several. It
        // cannot be derived from the rows in this table.
        let alive = true;
        getAcquisitionReport(eventId)
            .then((r) => { if (alive) setReport(r.data); })
            .catch(() => { /* the table still works without the summary */ });
        getDoorReport(eventId)
            .then((r) => { if (alive) setDoor(r.data); })
            .catch(() => { /* the table still works without it */ });
        return () => { alive = false; };
    }, [eventId]);

    const sortRows = (rows) => {
        if (!sortBy) return rows;
        const val = (a) => (
            sortBy === 'purchased' ? (a.acq_purchased_at || '')
            : sortBy === 'last' ? (a.acq_last_purchased_at || '')
            : sortBy === 'source' ? (a.acq_source_value || '')
            : `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase());
        return [...rows].sort((x, y) => {
            const a = val(x); const b = val(y);
            if (a === b) return 0;
            return (a < b ? -1 : 1) * (sortDir === 'asc' ? 1 : -1);
        });
    };
    const visible = sortRows(applyFilters(results !== null ? results : attendees));
    const toggleSort = (key) => {
        if (sortBy === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        else { setSortBy(key); setSortDir(key === 'purchased' || key === 'last' ? 'desc' : 'asc'); }
    };
    const uniq = (key) => Array.from(new Set((attendees || []).map((a) => a[key]).filter(Boolean))).sort();
    const anyFilter = fCheck || fStatus || fBase || fAddon;
    const addonCodes = counts ? Object.keys(counts.by_addon || {}) : [];

    const countChip = (label, value, color) => (
        <Chip size="small" color={color} variant={color ? 'filled' : 'outlined'}
            label={<span><strong>{value}</strong> {label}</span>} sx={{ mr: 0.5, mb: 0.5 }} />
    );

    return (
        <Box>
            <Box display="flex" justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} flexDirection={{ xs: 'column', sm: 'row' }} gap={1} mb={2}>
                <Typography variant="h4">Attendees</Typography>
                <Box display="flex" gap={1} flexDirection={{ xs: 'column', sm: 'row' }}>
                    <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setOpenImportDialog(true)}>Bulk Import CSV</Button>
                    <Button variant="outlined" onClick={handleExport}>Export CSV</Button>
                    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpenDialog(true)}>Add Attendee</Button>
                </Box>
            </Box>

            {/* Operational counts — base tickets and add-ons counted SEPARATELY. */}
            {counts && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    <Box sx={{ mb: 0.5 }}>
                        {countChip('total', counts.total)}
                        {countChip('checked in', counts.checked_in, 'success')}
                        {countChip('not in', counts.not_checked_in)}
                    </Box>
                    <Typography variant="caption" color="text.secondary">Base tickets</Typography>
                    <Box sx={{ mb: 0.5 }}>
                        {Object.entries(counts.by_base_ticket || {}).map(([k, v]) => <span key={k}>{countChip(k, v, 'primary')}</span>)}
                    </Box>
                    {addonCodes.length > 0 && (
                        <>
                            <Typography variant="caption" color="text.secondary">Add-ons (counted independently, not folded into a tier)</Typography>
                            <Box sx={{ mb: 0.5 }}>
                                {Object.entries(counts.by_addon || {}).map(([k, v]) => <span key={k}>{countChip(k.replace(/_/g, ' ').toLowerCase(), v, 'success')}</span>)}
                            </Box>
                        </>
                    )}
                    {Object.entries(counts.by_status || {}).some(([k]) => ['refunded', 'revoked', 'cancelled'].includes(k)) && (
                        <Box>
                            {Object.entries(counts.by_status || {}).filter(([k]) => ['refunded', 'revoked', 'cancelled'].includes(k)).map(([k, v]) => <span key={k}>{countChip(k, v, 'error')}</span>)}
                        </Box>
                    )}
                </Paper>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1 }}>
                <TextField fullWidth size="small" placeholder="Search this event by name, email, phone or QR" value={query} onChange={(e) => setQuery(e.target.value)}
                    InputProps={{
                        startAdornment: <InputAdornment position="start">{searching ? <CircularProgress size={18} /> : <SearchIcon fontSize="small" />}</InputAdornment>,
                        endAdornment: query ? <InputAdornment position="end"><IconButton size="small" onClick={() => setQuery('')} aria-label="Clear search"><ClearIcon fontSize="small" /></IconButton></InputAdornment> : null,
                    }} />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <TextField select size="small" label="Checked in" value={fCheck} onChange={(e) => setFCheck(e.target.value)} sx={{ minWidth: 130 }}>
                    <MenuItem value="">Any</MenuItem><MenuItem value="in">Checked in</MenuItem><MenuItem value="out">Not checked in</MenuItem>
                </TextField>
                <TextField select size="small" label="Status" value={fStatus} onChange={(e) => setFStatus(e.target.value)} sx={{ minWidth: 130 }}>
                    <MenuItem value="">Any</MenuItem><MenuItem value="active">Active</MenuItem><MenuItem value="refunded">Refunded</MenuItem><MenuItem value="revoked">Revoked</MenuItem><MenuItem value="cancelled">Cancelled</MenuItem>
                </TextField>
                <TextField select size="small" label="Base ticket" value={fBase} onChange={(e) => setFBase(e.target.value)} sx={{ minWidth: 150 }}>
                    <MenuItem value="">Any</MenuItem>
                    {ticketTypes.map((t) => <MenuItem key={t.id} value={t.code}>{t.name}</MenuItem>)}
                </TextField>
                {addonCodes.length > 0 && (
                    <TextField select size="small" label="Add-on" value={fAddon} onChange={(e) => setFAddon(e.target.value)} sx={{ minWidth: 160 }}>
                        <MenuItem value="">Any</MenuItem>
                        {addonCodes.map((c) => <MenuItem key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</MenuItem>)}
                    </TextField>
                )}
                {anyFilter && <Button size="small" onClick={() => { setFCheck(''); setFStatus(''); setFBase(''); setFAddon(''); }}>Clear filters</Button>}
            </Stack>

            {(results !== null || anyFilter) && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {visible.length === 0 ? 'No match.' : `${visible.length} shown of ${attendees.length} attendee${attendees.length === 1 ? '' : 's'}`}
                </Typography>
            )}

                {report && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} flexWrap="wrap">
                        <Box display="flex" gap={3} flexWrap="wrap">
                            <Box><Typography variant="h6">{report.attendees}</Typography>
                                <Typography variant="caption" color="text.secondary">Attendees</Typography></Box>
                            <Box><Typography variant="h6">{report.purchases}</Typography>
                                <Typography variant="caption" color="text.secondary">Purchases</Typography></Box>
                            <Box><Typography variant="h6">${Math.round(report.gross_revenue).toLocaleString()}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Revenue{report.refunded && report.refunded.count > 0
                                        ? ` · net $${Math.round(report.net_revenue).toLocaleString()}` : ''}
                                </Typography></Box>
                        </Box>
                        <Button size="small" onClick={() => setShowReport(!showReport)}>
                            {showReport ? 'Hide breakdown' : 'Sales & acquisition'}
                        </Button>
                    </Box>
                    {showReport && (
                        <Box sx={{ mt: 1.5 }}>
                            <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                                {[['by_source', 'Acquisition source'], ['by_funnel', 'Funnel'],
                                  ['by_page', 'Purchase site'], ['by_product', 'Product']].map((p) => (
                                    <Chip key={p[0]} size="small" label={p[1]}
                                        color={reportLevel === p[0] ? 'primary' : 'default'}
                                        variant={reportLevel === p[0] ? 'filled' : 'outlined'}
                                        onClick={() => setReportLevel(p[0])} />
                                ))}
                                {(fFunnel || fDomain || fProduct || fSource || fPage) && (
                                    <Button size="small" onClick={() => { setFFunnel(''); setFDomain(''); setFProduct(''); setFSource(''); setFPage(''); }}>
                                        View all {report.attendees}
                                    </Button>
                                )}
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                {reportLevel === 'by_source'
                                    ? 'Source is captured against the person, not the payment, so every payment they made counts under their one source.'
                                    : 'Grouped by what each payment itself recorded, so one person can appear in more than one row. Clicking a row filters to the people behind it.'}
                            </Typography>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Breakdown</TableCell>
                                        <TableCell align="right">People</TableCell>
                                        <TableCell align="right">Payments</TableCell>
                                        <TableCell align="right">Revenue</TableCell>
                                        <TableCell>Tickets</TableCell>
                                        <TableCell>First &ndash; latest</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(report[reportLevel] || []).map((r) => {
                                        const ev = r.evidence || {};
                                        const allStrong = ev.purchase_session > 0 && !ev.weaker && !ev.none;
                                        const apply = () => {
                                            // Clicking filters to the UNIQUE PEOPLE behind the number, never
                                            // to the purchase count, which is always the larger figure.
                                            if (reportLevel === 'by_source') setFSource(r.key);
                                            if (reportLevel === 'by_funnel') setFFunnel(r.key);
                                            if (reportLevel === 'by_product') setFProduct(r.key);
                                            if (reportLevel === 'by_page') setFDomain(r.key === 'Not captured' ? '' : r.key);
                                        };
                                        return (
                                            <TableRow key={r.key} hover sx={{ cursor: 'pointer' }} onClick={apply}>
                                                <TableCell>
                                                    {r.key}
                                                    {reportLevel === 'by_source' && allStrong && (
                                                        <Typography component="span" color="success.main" sx={{ ml: 0.5 }}
                                                            title="Every attribution here was captured in that order's own checkout session">&#10003;</Typography>
                                                    )}
                                                    {reportLevel === 'by_source' && !allStrong && (
                                                        <Typography component="span" variant="caption" color="text.disabled" sx={{ ml: 0.5 }}
                                                            title={`purchase-session ${ev.purchase_session || 0} · weaker ${ev.weaker || 0} · none ${ev.none || 0}`}>~</Typography>
                                                    )}
                                                </TableCell>
                                                <TableCell align="right"><strong>{r.attendees}</strong></TableCell>
                                                <TableCell align="right">{r.purchases}</TableCell>
                                                <TableCell align="right">${Math.round(r.revenue).toLocaleString()}</TableCell>
                                                <TableCell>
                                                    <Typography variant="caption">
                                                        {Object.keys(r.tickets || {}).map((k) => `${r.tickets[k]}x${k.replace('General Admission + Conference', 'GA-CONF').replace('General Admission', 'GA').replace('VIP Pass', 'VIP')}`).join('  ')}
                                                    </Typography>
                                                </TableCell>
                                                <TableCell>
                                                    <Typography variant="caption" color="text.secondary">
                                                        {String(r.first || '').slice(0, 10)} &ndash; {String(r.last || '').slice(0, 10)}
                                                    </Typography>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </Box>
                    )}
                </Paper>
            )}

            {door && (door.walk_ins?.total > 0 || showDoor) && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} flexWrap="wrap">
                        <Box display="flex" gap={3} flexWrap="wrap" alignItems="baseline">
                            <Box><Typography variant="h6">{door.walk_ins.total}</Typography>
                                <Typography variant="caption" color="text.secondary">Walk-ins</Typography></Box>
                            <Box><Typography variant="h6">${Math.round(door.door_payments.collected_total).toLocaleString()}</Typography>
                                <Typography variant="caption" color="text.secondary">Taken at the door</Typography></Box>
                            <Box><Typography variant="h6">${Math.round(door.verified_ghl_revenue.amount).toLocaleString()}</Typography>
                                <Typography variant="caption" color="text.secondary">Verified GHL revenue</Typography></Box>
                        </Box>
                        <Button size="small" onClick={() => setShowDoor(!showDoor)}>
                            {showDoor ? 'Hide' : 'Door & walk-ins'}
                        </Button>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        These two totals are never added together. Door money is Gaia&rsquo;s own record; GHL revenue is what GHL processed.
                    </Typography>
                    {showDoor && (
                        <Box sx={{ mt: 1.5 }}>
                            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
                                {Object.keys(door.walk_ins.by_attendance_type || {}).map((k) => (
                                    <Chip key={k} size="small" variant="outlined"
                                        label={`${door.walk_ins.by_attendance_type[k]} ${k}`} />
                                ))}
                            </Stack>
                            <Table size="small">
                                <TableBody>
                                    <TableRow><TableCell>Reconciled with a GHL order</TableCell>
                                        <TableCell align="right"><strong>{door.walk_ins.reconciled_with_ghl}</strong></TableCell></TableRow>
                                    <TableRow><TableCell>Awaiting GHL reconciliation</TableCell>
                                        <TableCell align="right"><strong>{door.walk_ins.awaiting_ghl_reconciliation}</strong></TableCell></TableRow>
                                    <TableRow><TableCell>
                                        Door payment needs review
                                        <Typography variant="caption" color="text.secondary" display="block">
                                            An order arrived after cash was taken. Staff decide whether it is the same payment &mdash; Gaia never assumes.
                                        </Typography></TableCell>
                                        <TableCell align="right"><strong>{door.walk_ins.needs_review}</strong></TableCell></TableRow>
                                    {Object.keys(door.door_payments.by_method || {}).map((m) => (
                                        <TableRow key={m}>
                                            <TableCell>Taken by {m.replace('_', ' ')}</TableCell>
                                            <TableCell align="right">
                                                {door.door_payments.by_method[m].count} &middot; ${Math.round(door.door_payments.by_method[m].amount).toLocaleString()}
                                            </TableCell></TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </Box>
                    )}
                </Paper>
            )}

            <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                    Filter by acquisition
                </Typography>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                    <TextField select size="small" label="Funnel" value={fFunnel} onChange={(e) => setFFunnel(e.target.value)} sx={{ minWidth: 210 }}>
                        <MenuItem value="">All funnels</MenuItem>
                        {uniq('acq_funnel_name').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select size="small" label="Website / page" value={fDomain} onChange={(e) => setFDomain(e.target.value)} sx={{ minWidth: 200 }}>
                        <MenuItem value="">All websites</MenuItem>
                        {uniq('acq_domain').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select size="small" label="Product" value={fProduct} onChange={(e) => setFProduct(e.target.value)} sx={{ minWidth: 210 }}>
                        <MenuItem value="">All products</MenuItem>
                        {uniq('acq_product_name').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select size="small" label="Page bought on" value={fPage} onChange={(e) => setFPage(e.target.value)} sx={{ minWidth: 175 }}>
                        <MenuItem value="">All pages</MenuItem>
                        {uniq('acq_page_name').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select size="small" label="Acquisition source" value={fSource} onChange={(e) => setFSource(e.target.value)} sx={{ minWidth: 175 }}>
                        <MenuItem value="">Anywhere</MenuItem>
                        {uniq('acq_source_value').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField select size="small" label="UTM source" value={fUtm} onChange={(e) => setFUtm(e.target.value)} sx={{ minWidth: 150 }}>
                        <MenuItem value="">Any</MenuItem>
                        {uniq('acq_utm_source').map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                    </TextField>
                    <TextField size="small" type="date" label="Bought from" InputLabelProps={{ shrink: true }}
                        value={fFrom} onChange={(e) => setFFrom(e.target.value)} sx={{ minWidth: 155 }} />
                    <TextField size="small" type="date" label="Bought to" InputLabelProps={{ shrink: true }}
                        value={fTo} onChange={(e) => setFTo(e.target.value)} sx={{ minWidth: 155 }} />
                    {(fFunnel || fDomain || fProduct || fUtm || fPage || fSource || fFrom || fTo) ? (
                        <Button size="small" onClick={() => { setFFunnel(''); setFDomain(''); setFProduct(''); setFUtm(''); setFPage(''); setFSource(''); setFFrom(''); setFTo(''); }}>
                            Clear
                        </Button>
                    ) : null}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Showing {visible.length} of {(results !== null ? results : attendees).length}
                </Typography>
            </Paper>

            {visible.length === 0 ? (
                <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
                    <Typography variant="subtitle1" gutterBottom>{(results !== null || anyFilter) ? 'Nobody matches that' : 'No attendees yet'}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        {(results !== null || anyFilter) ? 'Try a shorter term or clear the filters.' : 'Add one by hand, or bring a list in from CSV.'}
                    </Typography>
                    {(results !== null || anyFilter) ? (
                        <Button onClick={() => { setQuery(''); setFCheck(''); setFStatus(''); setFBase(''); setFAddon(''); }}>Clear</Button>
                    ) : (
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="center">
                            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpenDialog(true)}>Add Attendee</Button>
                            <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setOpenImportDialog(true)}>Bulk Import CSV</Button>
                        </Stack>
                    )}
                </Paper>
            ) : compact ? (
                <Stack spacing={1.5}>
                    {visible.map((attendee) => (
                        <Paper key={attendee.id} variant="outlined" sx={{ p: 2 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{attendee.first_name} {attendee.last_name}</Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{attendee.email}</Typography>
                            {attendee.phone && <Typography variant="body2" color="text.secondary">{attendee.phone}</Typography>}
                            <Box sx={{ mt: 1 }}>{accessCell(attendee)}</Box>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                                {statusChip(attendee)}
                                <Chip size="small" variant="outlined" onClick={() => openAcq(attendee)}
                                    label={attendee.acq_funnel_name || sourceOf(attendee) || 'Not captured'} />
                            </Stack>
                            {attendee.is_checked_in && checkedInAt(attendee) && <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>Checked in {checkedInAt(attendee)}</Typography>}
                            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>{rowActions(attendee)}</Stack>
                        </Paper>
                    ))}
                </Stack>
            ) : (
                <TableContainer component={Paper} sx={{ width: '100%', overflowX: 'auto' }}>
                    <Table sx={{ minWidth: 900 }}>
                        <TableHead>
                            <TableRow>
                                <TableCell>Name / Phone</TableCell>
                                <TableCell>Email</TableCell>
                                <TableCell>Ticket / Access</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                    <TableSortLabel active={sortBy === 'purchased'}
                                        direction={sortBy === 'purchased' ? sortDir : 'desc'}
                                        onClick={() => toggleSort('purchased')}>Purchased</TableSortLabel>
                                    <Box>
                                        <TableSortLabel active={sortBy === 'last'}
                                            direction={sortBy === 'last' ? sortDir : 'desc'}
                                            onClick={() => toggleSort('last')}>
                                            <Typography variant="caption" color="text.secondary">latest</Typography>
                                        </TableSortLabel>
                                    </Box>
                                </TableCell>
                                <TableCell>
                                    <TableSortLabel active={sortBy === 'source'}
                                        direction={sortBy === 'source' ? sortDir : 'asc'}
                                        onClick={() => toggleSort('source')}>Acquisition source</TableSortLabel>
                                </TableCell>
                                <TableCell>QR</TableCell>
                                <TableCell>Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {visible.map((attendee) => (
                                <TableRow key={attendee.id} hover>
                                    <TableCell>
                                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{attendee.first_name} {attendee.last_name}</Typography>
                                        {attendee.phone && <Typography variant="caption" color="text.secondary">{attendee.phone}</Typography>}
                                    </TableCell>
                                    <TableCell sx={{ wordBreak: 'break-all' }}>{attendee.email}</TableCell>
                                    <TableCell>{accessCell(attendee)}</TableCell>
                                    <TableCell>
                                        {statusChip(attendee)}
                                        {attendee.is_checked_in && checkedInAt(attendee) && <Typography variant="caption" display="block" color="text.secondary">{checkedInAt(attendee)}</Typography>}
                                    </TableCell>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        <Typography variant="body2">{fmtWhen(attendee.acq_purchased_at) || 'Not captured'}</Typography>
                                        {attendee.acq_purchase_count > 1 && (
                                            <Typography variant="caption" color="text.secondary" display="block">
                                                {attendee.acq_purchase_count} purchases &middot; latest {fmtWhen(attendee.acq_last_purchased_at) || '&mdash;'}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <Box display="flex" alignItems="center" gap={0.5}>
                                            {acquisitionCell(attendee)}
                                            <IconButton size="small" title="Purchase & attribution"
                                                onClick={() => openAcq(attendee)}>
                                                <InfoOutlinedIcon fontSize="small" />
                                            </IconButton>
                                        </Box>
                                    </TableCell>
                                    <TableCell><Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{attendee.qr_code}</Typography></TableCell>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{rowActions(attendee)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            {/* Attendee detail / Manage ticket — the operational source of truth. */}
            <Dialog open={Boolean(manage)} onClose={() => setManage(null)} maxWidth="md" fullWidth>
                <DialogTitle>{manage ? displayName(manage) : ''}</DialogTitle>
                <DialogContent dividers>
                    {manage && (
                        <Stack spacing={2}>
                            {/* Effective access — the headline answer */}
                            <Alert severity={effOf(manageDetail || manage)?.active === false ? 'error' : 'info'} icon={false}>
                                <Typography variant="overline" color="text.secondary">Effective access</Typography>
                                <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
                                    {effOf(manageDetail || manage)?.effective_label || (manage.ticket_type_id ? '…' : 'No ticket')}
                                </Typography>
                            </Alert>

                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                                {/* Identity + event + QR */}
                                <Box sx={{ flex: 1 }}>
                                    <Typography variant="subtitle2" gutterBottom>Who</Typography>
                                    <Typography variant="body2">{displayName(manage)}</Typography>
                                    <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{manage.email}</Typography>
                                    {manage.phone && <Typography variant="body2" color="text.secondary">{manage.phone}</Typography>}
                                    <Typography variant="caption" color="text.secondary">Attendee #{manage.id}</Typography>
                                    <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center" flexWrap="wrap">
                                        {statusChip(manage)}
                                        {manage.is_checked_in && checkedInAt(manage) ? (
                                            <Chip size="small" variant="outlined" label={`Checked in ${checkedInAt(manage)}`} />
                                        ) : <Chip size="small" variant="outlined" label="Not checked in" />}
                                        <Chip size="small" label={sourceOf(manage) || 'Direct'} />
                                    </Stack>
                                </Box>
                                {/* QR — the identity credential, never regenerated */}
                                <Box sx={{ textAlign: 'center' }}>
                                    <QRCodeSVG value={manage.qr_code} size={128} />
                                    <Typography variant="caption" display="block" sx={{ fontFamily: 'monospace', mt: 0.5 }}>{manage.qr_code}</Typography>
                                    <Button size="small" onClick={() => showQR(manage)}>Enlarge</Button>
                                </Box>
                            </Stack>

                            {/* The printed badge: one permanent link, the person's own data behind it. */}
                            {(manageDetail || manage).card_url && (
                                <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                                    <Typography variant="subtitle2" gutterBottom>Badge card</Typography>
                                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
                                        <a href={(manageDetail || manage).card_url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'monospace', fontSize: '.9rem' }}>
                                            {(manageDetail || manage).card_url.replace(/^https?:\/\//, '')}
                                        </a>
                                        <Chip size="small"
                                            color={(manageDetail || manage).card_state === 'public' ? 'success' : 'default'}
                                            variant={(manageDetail || manage).card_state === 'unclaimed' ? 'outlined' : 'filled'}
                                            label={(manageDetail || manage).card_state === 'public' ? 'Public' : (manageDetail || manage).card_state === 'private' ? 'Set up · private' : 'Unclaimed'} />
                                        <Button size="small" variant="outlined" startIcon={<PrintIcon />} onClick={() => openLabel(manage)}>
                                            {(manage.badge_print_count || 0) > 0 ? 'Reprint sticker' : 'Print sticker'}
                                        </Button>
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                                        The QR on the sticker opens this link. If they ask how to add their phone or company: “scan the QR on your badge and tap Set up your card”. Nothing is ever reprinted.
                                    </Typography>
                                </Box>
                            )}

                            {/* What they own — each entitlement independently */}
                            <Box>
                                <Typography variant="subtitle2" gutterBottom>Entitlements</Typography>
                                {!manageDetail ? <CircularProgress size={18} /> : (
                                    (manageDetail.effective_access?.entitlement_history || []).length === 0 ? (
                                        <Typography variant="body2" color="text.secondary">No purchase records — access is admin-assigned.</Typography>
                                    ) : (
                                        <Stack spacing={0.75}>
                                            {manageDetail.effective_access.entitlement_history.map((e, i) => (
                                                <Paper key={i} variant="outlined" sx={{ p: 1 }}>
                                                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                                        <Chip size="small" color={KIND_COLOR[e.kind] || 'default'} label={e.kind} />
                                                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{e.label}</Typography>
                                                        {e.day && <Chip size="small" variant="outlined" label={e.day} />}
                                                        <Chip size="small" color={e.status === 'refunded' ? 'error' : 'success'} variant="outlined" label={e.status} />
                                                        {e.order_id && <Typography variant="caption" color="text.secondary">order <code>{e.order_id}</code></Typography>}
                                                    </Stack>
                                                </Paper>
                                            ))}
                                        </Stack>
                                    )
                                )}
                            </Box>

                            {manageDetail && (manageDetail.effective_access?.addons || []).some((a) => a.code === 'ONE_DAY_CONFERENCE') && (
                                <Box>
                                    <Typography variant="subtitle2" gutterBottom>Conference day (One-Day Speaker Access)</Typography>
                                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                        {(() => { const ad = (manageDetail.effective_access.addons || []).find((a) => a.code === 'ONE_DAY_CONFERENCE'); return <Chip size="small" color={ad && ad.day ? 'success' : 'warning'} label={ad && ad.day ? ('Currently: ' + ad.day) : 'Day not selected'} />; })()}
                                        <TextField size="small" type="date" value={dayValue} onChange={(e) => setDayValue(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ minWidth: 170 }} />
                                        <Button variant="outlined" disabled={dayBusy || !dayValue} onClick={doSetDay}>Set day</Button>
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary">Scanner grants conference access only on this day. Change is recorded in history.</Typography>
                                </Box>
                            )}
                            {contactIdOf(manage) && (
                                <Button size="small" variant="outlined" startIcon={<OpenInNewIcon />}
                                    href={`https://crm.gaiahealers.com/v2/location/${GHL_LOCATION}/contacts/detail/${contactIdOf(manage)}`}
                                    target="_blank" rel="noopener noreferrer" sx={{ alignSelf: 'flex-start' }}>
                                    Open in GHL to refund (payments)
                                </Button>
                            )}
                            <Typography variant="caption" color="text.secondary">
                                Refunds are issued in GHL; this app syncs the refunded status back and the scanner then rejects the ticket. The QR never changes on upgrade, refund, add-on or day change.
                            </Typography>

                            <Divider />
                            <Box>
                                <Typography variant="subtitle2" gutterBottom>Change pass (complimentary)</Typography>
                                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                    <TextField select size="small" label="Base pass" value={manageTier} onChange={(e) => setManageTier(e.target.value)} sx={{ minWidth: 200 }}>
                                        {ticketTypes.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
                                    </TextField>
                                    <Button variant="contained" disabled={manageBusy || !manageTier || Number(manageTier) === manage.ticket_type_id} onClick={() => doChangePass(false)}>Apply</Button>
                                    {ticketStatusOf(manage) === 'active' ? (
                                        <Button color="error" variant="outlined" disabled={manageBusy} onClick={doRevoke}>Revoke access</Button>
                                    ) : (
                                        <Button color="success" variant="outlined" disabled={manageBusy} onClick={doReinstate}>Reinstate</Button>
                                    )}
                                    {manageBusy && <CircularProgress size={24} />}
                                </Stack>
                                <TextField size="small" label="Reason (recorded in history)" value={manageReason} onChange={(e) => setManageReason(e.target.value)} fullWidth sx={{ mt: 1 }} />
                            </Box>

                            <Divider />
                            <Box>
                                <Typography variant="subtitle2" gutterBottom>History</Typography>
                                {lifecycleOf(manageDetail || manage).length === 0 ? (
                                    <Typography variant="body2" color="text.secondary">No lifecycle events yet.</Typography>
                                ) : (
                                    <Stack spacing={0.5}>
                                        {lifecycleOf(manageDetail || manage).slice().reverse().map((e, i) => (
                                            <Typography key={i} variant="body2">
                                                <strong>{LIFECYCLE_LABELS[e.action] || e.action}</strong>
                                                {e.day ? ` — ${e.day}` : ''}{e.reason ? ` — ${e.reason}` : ''}
                                                {' '}<Typography component="span" variant="caption" color="text.secondary">
                                                    {e.actor}{e.ts ? ` · ${formatVenueTime(e.ts, timezone)}` : ''}
                                                </Typography>
                                            </Typography>
                                        ))}
                                    </Stack>
                                )}
                            </Box>
                        </Stack>
                    )}
                </DialogContent>
                <DialogActions><Button onClick={() => setManage(null)}>Close</Button></DialogActions>
            </Dialog>

            <Dialog open={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)}>
                <DialogTitle>Delete {confirmDelete ? displayName(confirmDelete) : ''}?</DialogTitle>
                <DialogContent><Typography variant="body2" color="text.secondary">This removes them from this event only, and cannot be undone from the admin.</Typography></DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={handleDelete}>Delete</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Edit Attendee</DialogTitle>
                <DialogContent>
                    {editing && (
                        <Box sx={{ pt: 1 }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                <TextField fullWidth label="First Name" margin="normal" value={editing.first_name} onChange={(e) => setEditing({ ...editing, first_name: e.target.value })} />
                                <TextField fullWidth label="Last Name" margin="normal" value={editing.last_name} onChange={(e) => setEditing({ ...editing, last_name: e.target.value })} />
                            </Stack>
                            <TextField fullWidth label="Email" type="email" margin="normal" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} sx={{ mb: 1 }} />
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                <TextField fullWidth label="Company" margin="normal" value={editing.company} onChange={(e) => setEditing({ ...editing, company: e.target.value })} />
                                <TextField fullWidth label="Job Title" margin="normal" value={editing.job_title} onChange={(e) => setEditing({ ...editing, job_title: e.target.value })} />
                            </Stack>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                <TextField fullWidth label="Phone" margin="normal" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
                                <TextField select fullWidth label="Registration Status" margin="normal" value={editing.registration_status} onChange={(e) => setEditing({ ...editing, registration_status: e.target.value })}>
                                    {Object.entries(STATUS_LABELS).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
                                </TextField>
                            </Stack>
                            <TextField select fullWidth label="Base pass (ticket type)" margin="normal" value={editing.ticket_type_id} onChange={(e) => setEditing({ ...editing, ticket_type_id: e.target.value })}
                                helperText="Access follows the pass, never its name. Add-ons are separate and shown in the detail view.">
                                <MenuItem value="">— no pass —</MenuItem>
                                {ticketTypes.map((tt) => <MenuItem key={tt.id} value={tt.id}>{tt.name} ({tt.code})</MenuItem>)}
                            </TextField>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                    <Button variant="contained" onClick={saveEdit}>Save Changes</Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={Boolean(feedback)} autoHideDuration={4000} onClose={() => setFeedback(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
                {feedback ? <Alert severity={feedback.severity}>{feedback.message}</Alert> : undefined}
            </Snackbar>

            <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Add Attendee</DialogTitle>
                <DialogContent sx={{ '& .MuiFormControl-root:first-of-type': { mt: 3 } }}>
                    <TextField fullWidth label="First Name" value={newAttendee.first_name} onChange={(e) => setNewAttendee({ ...newAttendee, first_name: e.target.value })} margin="normal" required />
                    <TextField fullWidth label="Last Name" value={newAttendee.last_name} onChange={(e) => setNewAttendee({ ...newAttendee, last_name: e.target.value })} margin="normal" required />
                    <TextField fullWidth label="Email" type="email" value={newAttendee.email} onChange={(e) => setNewAttendee({ ...newAttendee, email: e.target.value })} margin="normal" required />
                    <TextField fullWidth label="Company" value={newAttendee.company} onChange={(e) => setNewAttendee({ ...newAttendee, company: e.target.value })} margin="normal" />
                    <TextField fullWidth label="Job Title" value={newAttendee.job_title} onChange={(e) => setNewAttendee({ ...newAttendee, job_title: e.target.value })} margin="normal" />
                    <TextField fullWidth label="Phone" value={newAttendee.phone} onChange={(e) => setNewAttendee({ ...newAttendee, phone: e.target.value })} margin="normal" />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
                    <Button onClick={handleCreate} variant="contained">Add</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={openImportDialog} onClose={closeImportDialog} maxWidth="sm" fullWidth>
                <DialogTitle>Bulk Import Attendees</DialogTitle>
                <DialogContent>
                    {importResult && (
                        <Alert severity={importResult.severity} sx={{ mb: 2 }}>
                            {importResult.message}
                            {importResult.errors?.length ? <Box component="ul" sx={{ mt: 1, mb: 0, pl: 2 }}>{importResult.errors.slice(0, 5).map((error, index) => <li key={index}>{error}</li>)}</Box> : null}
                        </Alert>
                    )}
                    <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>Upload a GHL or spreadsheet CSV with columns like First Name, Last Name, Email, Phone, Company, Job Title.</Typography>
                    <Box display="flex" gap={1} flexWrap="wrap">
                        <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>Choose CSV<input hidden type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files?.[0] || null)} /></Button>
                        <Button variant="text" onClick={downloadSampleCsv}>Download Sample CSV</Button>
                    </Box>
                    {importFile && <Typography variant="body2" sx={{ mt: 1 }}>{importFile.name}</Typography>}
                    <TextField fullWidth label="Import source" value={importSource} onChange={(e) => setImportSource(e.target.value)} margin="normal" />
                    <FormControlLabel control={<Checkbox checked={markPaidMember} onChange={(e) => setMarkPaidMember(e.target.checked)} />} label="Mark imported attendees as paid members" />
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeImportDialog}>Close</Button>
                    <Button onClick={handleImport} variant="contained" disabled={importing}>{importing ? 'Importing...' : 'Import'}</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={openQR} onClose={() => setOpenQR(false)} maxWidth="xs" fullWidth>
                <DialogTitle>Attendee QR Code</DialogTitle>
                <DialogContent>
                    {selectedAttendee && (
                        <Box display="flex" flexDirection="column" alignItems="center" p={2}>
                            <Typography variant="h6" gutterBottom>{selectedAttendee.first_name} {selectedAttendee.last_name}</Typography>
                            <QRCodeSVG value={selectedAttendee.qr_code} size={220} />
                            <Typography variant="body2" color="textSecondary" sx={{ mt: 2, fontFamily: 'monospace' }}>{selectedAttendee.qr_code}</Typography>
                            {effOf(selectedAttendee) && <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>{effOf(selectedAttendee).effective_label}</Typography>}
                        </Box>
                    )}
                </DialogContent>
                <DialogActions><Button onClick={() => setOpenQR(false)}>Close</Button></DialogActions>
            </Dialog>
            <Dialog open={Boolean(acqDialog)} onClose={() => setAcqDialog(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Purchase &amp; attribution</DialogTitle>
                <DialogContent dividers>
                    {acqDialog && (() => {
                        const a = acqDialog;
                        // Two different questions, deliberately separated:
                        //   "where did they buy"  = the funnel / page the checkout lives on
                        //   "where did they come from" = landing URL, referrer, UTM
                        const row = (label, value, mono) => (
                            <Box sx={{ display: 'flex', gap: 2, py: 0.6, borderBottom: '1px solid', borderColor: 'divider' }}>
                                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 160, flexShrink: 0 }}>{label}</Typography>
                                {value
                                    ? <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: mono ? 'monospace' : undefined }}>{value}</Typography>
                                    : NC}
                            </Box>
                        );
                        return (
                            <Box>
                                <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>{a.first_name} {a.last_name}</Typography>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{a.email}</Typography>

                                <Typography variant="overline" color="text.secondary">Purchase</Typography>
                                {row('Purchased', fmtWhen(a.acq_purchased_at))}
                                {row('Product', a.acq_product_name)}
                                {row('Price paid', a.acq_price != null ? `${a.acq_price}` : null)}
                                {row('Order status', a.acq_order_status)}
                                {row('Order ID', a.acq_order_id, true)}
                                {row('Contact ID', a.acq_contact_id, true)}
                                {row('Product ID', a.acq_product_id, true)}

                                <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 2 }}>Ticket</Typography>
                                {row('QR / ticket ID', a.qr_code, true)}
                                {row('Base ticket purchased', (ticketTypes.find((t) => t.id === a.ticket_type_id) || {}).name || null)}
                                {row('Effective access', (acqDetail && acqDetail.effective_access && acqDetail.effective_access.effective) || null)}
                                {row('Status', statusLabel ? statusLabel(a) : (a.registration_status || null))}
                                {a.acq_issued_at
                                    ? row('Ticket issued', `${fmtWhen(a.acq_issued_at)}${a.acq_purchased_at ? ` · ${Math.max(0, Math.round((new Date(a.acq_issued_at) - new Date(a.acq_purchased_at)) / 1000))} sec after payment` : ''}`)
                                    : (
                                        <Box sx={{ display: 'flex', gap: 2, py: 0.6, borderBottom: '1px solid', borderColor: 'divider' }}>
                                            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 160, flexShrink: 0 }}>Original QR issuance</Typography>
                                            <Typography variant="body2" color="text.disabled">Historical / not independently known</Typography>
                                        </Box>
                                    )}

                                {acqDetail && Array.isArray(acqDetail.entitlement_history) && acqDetail.entitlement_history.length > 0 && (
                                    <Box sx={{ mt: 1.5 }}>
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                            Why their access is what it is - every transaction, in order:
                                        </Typography>
                                        {acqDetail.entitlement_history.map((h, i) => (
                                            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', py: 0.3 }}>
                                                <Chip size="small" variant="outlined" label={h.kind} sx={{ height: 18, fontSize: '.62rem' }} />
                                                <Typography variant="body2">{h.label}</Typography>
                                                <Typography variant="caption" color="text.disabled">
                                                    {h.ts ? fmtWhen(h.ts) : ''}{h.status ? ` · ${h.status}` : ''}
                                                </Typography>
                                            </Box>
                                        ))}
                                    </Box>
                                )}

                                <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 2 }}>System</Typography>
                                {row('Gaia record created', fmtWhen(a.created_at))}
                                {row('Creation method', ({
                                    webhook: 'Webhook - created moments after payment',
                                    reconciler: 'Reconciler - the minute-by-minute job',
                                    historical_backfill: 'Historical backfill - bulk import, not the original issuance',
                                    year_split_migration: 'Year split migration (2026-09-03) - not an issuance event',
                                    unknown: 'Not established',
                                })[a.acq_issuance_method] || null)}

                                <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 2 }}>Where they bought it</Typography>
                                {row('Funnel', a.acq_funnel_name)}
                                {row('Funnel ID', a.acq_funnel_id, true)}
                                {row('Checkout type', a.acq_checkout_type)}
                                {row('Website', a.acq_domain)}
                                {row('Page name', a.acq_page_name)}
                                {row('Page path', a.acq_page_url)}
                                {row('Full purchase URL', a.acq_purchase_url)}
                                {row('Page ID', a.acq_page_id, true)}

                                <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 2 }}>Where they came from</Typography>
                                {row('Landing URL', a.acq_landing_url)}
                                {row('Acquisition source', a.acq_source_value || a.acq_saw_on)}
                                {row('Evidence basis', BASIS_LABEL[a.acq_source_basis] || null)}
                                {row('Referring site', a.acq_referrer_domain)}
                                {row('Referrer (full)', a.acq_referrer)}
                                {row('GHL session source', a.acq_session_source)}
                                {row('GHL contact source', a.acq_contact_source)}
                                {row('utm_source', a.acq_utm_source)}
                                {row('utm_medium', a.acq_utm_medium)}
                                {row('utm_campaign', a.acq_utm_campaign)}
                                {row('utm_content', a.acq_utm_content)}
                                {row('utm_term', a.acq_utm_term)}

                                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
                                    Ingestion method (internal): {sourceOf(a) || 'n/a'}. Blank fields are shown as
                                    &quot;Not captured&quot; - GHL did not record them for this buyer; nothing here is inferred.
                                </Typography>
                            </Box>
                        );
                    })()}
                </DialogContent>
                <DialogActions><Button onClick={() => setAcqDialog(null)}>Close</Button></DialogActions>
            </Dialog>

        </Box>
    );
}

export default Attendees;
