import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell,
    Chip, Switch, Button, IconButton, Dialog, DialogTitle,
    DialogContent, DialogActions, TextField, MenuItem, Stack, Alert, Divider,
    CircularProgress, Tooltip, Checkbox, ToggleButton, ToggleButtonGroup,
    InputAdornment, Menu, Snackbar, Badge,
} from '@mui/material';
import {
    Add as AddIcon, UploadFile as UploadFileIcon, Delete as DeleteIcon,
    Search as SearchIcon, ContentCopy as CopyIcon, MoreVert as MoreIcon,
    QrCodeScanner as ScanIcon, Send as SendIcon, Visibility as VisibleIcon,
    VisibilityOff as HiddenIcon,
} from '@mui/icons-material';
import {
    getExhibitors, createExhibitor, updateExhibitor, deleteExhibitor,
    getExhibitorLeads, vendorActivationLink,
} from '../utils/api';
import ImportCsvDialog from './ImportCsvDialog';
import BulkToolbar, { useBulkSelection, SelectAllCheckbox } from './BulkToolbar';

/**
 * Exhibitors — the stands: who is coming, what they bought, what they may do,
 * and where they stand on the floor.
 *
 * This used to be two screens over one table. `Vendors` in the sidebar held the
 * commercial side (stage, package, money, permissions) and the event's
 * `Exhibitors` tab held the operational side (booth, scanner link, leads). Same
 * `Exhibitor` rows underneath, same endpoints — so the split bought nothing and
 * cost a daily translation between "vendor" and "exhibitor", plus the standing
 * risk of settling an invoice on one screen while the other still says unpaid.
 *
 * One area now, two views over the same list, because the two jobs really are
 * different and one table holding every column would be unreadable:
 *
 *   Roster     — the floor. Booth, tables, scanner link, leads, what the
 *                directory would show.
 *   Commercial — the board. Stage, package, booked, paid, and the two
 *                permissions.
 *
 * Two switches per stand, deliberately separate:
 *   In the directory — attendees can find them in the app.
 *   Can scan badges  — their lead-retrieval link actually works.
 * A booth and lead retrieval are different purchases, and one being on has
 * never meant the other should be.
 */

// Where a stand is in the conversation, not what it has paid. The planning
// sheet keeps prospects, maybes and refusals in the same list as confirmed
// stands, separated by a heading — which is right, because a maybe becomes
// confirmed the day they pay. Grouping keeps that without letting a "not
// aligned" stand sit one stray click from the attendee directory.
export const STAGES = [
    { key: 'confirmed', label: 'Confirmed', note: 'Paid or ours. These are the stands at the event.' },
    { key: 'waiting', label: 'Waiting to confirm', note: 'In conversation. Promote them when they pay.' },
    { key: 'unsure', label: 'Not sure yet', note: 'Contacted, no answer either way.' },
    { key: 'other', label: 'Others', note: 'Our own tables and anything that does not fit a package.' },
    { key: 'product_sponsor', label: 'Product-only sponsors', note: 'Sending product, not taking a booth.' },
    { key: 'next_year', label: 'Interested next year', note: 'Not for 2026. Kept so nobody re-types them in 2027.' },
    { key: 'not_attending', label: 'Not attending', note: 'Declined for this year.' },
    { key: 'not_aligned', label: 'Not aligned', note: 'Deliberately not invited. Read the note before changing anything here.' },
];

const STATUS = {
    paid: { label: 'Paid', color: 'success' },
    partial: { label: 'Part paid', color: 'warning' },
    unpaid: { label: 'Unpaid', color: 'error' },
    comp: { label: 'Ours / partner', color: 'default' },
};

const money = (v) => (v || v === 0 ? `$${Number(v).toLocaleString()}` : '—');

// What the attendee directory would actually show. A stand missing a
// description is a blank card, and the fix is to send them their setup link.
function ReadyChips({ row }) {
    return (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.4 }}>
            {[['Logo', row.logo_url], ['About', row.description],
              ['Link', row.website], ['Contact', row.public_email || row.public_phone]]
                .map(([lbl, ok]) => (
                    <Chip key={lbl} size="small" label={lbl}
                        variant={ok ? 'filled' : 'outlined'}
                        color={ok ? 'success' : 'default'}
                        sx={{ height: 17, fontSize: 10, opacity: ok ? 1 : 0.45,
                              '& .MuiChip-label': { px: 0.6 } }} />
                ))}
        </Stack>
    );
}

function Logo({ row, size = 34 }) {
    return row.logo_url
        ? <Box component="img" src={row.logo_url} alt=""
            sx={{ width: size, height: size, objectFit: 'contain', borderRadius: 1,
                  bgcolor: '#fff', p: 0.25, flex: '0 0 auto' }} />
        : <Box sx={{ width: size, height: size, borderRadius: 1, border: '1px dashed',
                     borderColor: 'divider', flex: '0 0 auto' }} />;
}

export default function Exhibitors({ eventId, onCountChange }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [view, setView] = useState('roster');
    const [q, setQ] = useState('');
    const [stageFilter, setStageFilter] = useState('');
    const [editing, setEditing] = useState(null);
    const [saving, setSaving] = useState(false);
    const [leads, setLeads] = useState(null);
    const [invite, setInvite] = useState(null);
    const [importOpen, setImportOpen] = useState(false);
    const [granting, setGranting] = useState(false);
    const [openStages, setOpenStages] = useState({ confirmed: true });
    const [toast, setToast] = useState('');

    const sel = useBulkSelection(rows);

    const load = useCallback(async () => {
        if (!eventId) return;
        setLoading(true); setError('');
        try {
            const r = await getExhibitors(eventId);
            setRows(r.data || []);
            if (onCountChange) onCountChange((r.data || []).length);
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not load the exhibitors.');
        } finally { setLoading(false); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventId]);

    useEffect(() => { load(); }, [load]);

    const patch = async (row, body) => {
        // Optimistic: a switch that waits for a round trip feels broken.
        setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...body } : r)));
        try {
            await updateExhibitor(row.id, body);
        } catch (e) {
            setError(e?.response?.data?.detail || 'That change did not save.');
            load();
        }
    };

    const remove = async (row) => {
        if (!window.confirm(`Delete ${row.company_name}? Their captured leads are deleted too.`)) return;
        try {
            await deleteExhibitor(row.id);
            load();
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not delete that stand.');
        }
    };

    const showLeads = async (row) => {
        try {
            const l = await getExhibitorLeads(row.id);
            setLeads({ company: row.company_name, items: l.data || [] });
        } catch (e) { setError('Could not load their leads.'); }
    };

    const setupLink = async (row) => {
        try {
            const l = await vendorActivationLink(row.id);
            setInvite(l.data);
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not make a setup link.');
        }
    };

    // A copy that gives no sign it happened is indistinguishable from a
    // dead button, and people click it twice to be sure.
    const copy = (text, what = 'Link') => {
        navigator.clipboard?.writeText(text);
        setToast(`${what} copied`);
    };
    const scanUrl = (row) => `${window.location.origin}/event/scan/${row.access_token}`;

    // Money means the CONFIRMED stands. A prospect has not booked anything, and
    // rolling them in would make "booked" a number nobody could act on.
    const confirmed = useMemo(
        () => rows.filter((r) => (r.stage || 'confirmed') === 'confirmed'), [rows]);
    const totals = confirmed.reduce((a, r) => ({
        due: a.due + (r.amount_due || 0),
        paid: a.paid + (r.amount_paid || 0),
        published: a.published + (r.is_published ? 1 : 0),
        scanning: a.scanning + (r.can_scan_leads ? 1 : 0),
    }), { due: 0, paid: 0, published: 0, scanning: 0 });
    const outstanding = totals.due - totals.paid;

    const visible = useMemo(() => {
        const needle = q.trim().toLowerCase();
        return rows.filter((r) => {
            if (stageFilter && (r.stage || 'confirmed') !== stageFilter) return false;
            if (!needle) return true;
            return [r.company_name, r.category, r.booth_number, r.package,
                    r.contact_email, r.public_email, r.website, r.tagline]
                .filter(Boolean).join(' ').toLowerCase().includes(needle);
        });
    }, [rows, q, stageFilter]);

    // Scanning is sold, and paying for a booth is not the same purchase — but in
    // practice these should agree, and when they drift it is worth saying so
    // rather than discovering it at the door.
    const paidNoScan = confirmed.filter(
        (r) => (r.payment_status === 'paid' || r.payment_status === 'comp') && !r.can_scan_leads);
    const scanUnpaid = confirmed.filter(
        (r) => r.can_scan_leads && r.payment_status !== 'paid' && r.payment_status !== 'comp');

    const grouped = STAGES.map((stage) => ({
        stage,
        group: visible.filter((r) => (r.stage || 'confirmed') === stage.key),
    })).filter((g) => g.group.length);

    return (
        <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center"
                   flexWrap="wrap" gap={1} mb={2}>
                <Typography variant="h6">
                    Exhibitors
                    <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                        {rows.length} on the board · {confirmed.length} confirmed
                    </Typography>
                </Typography>
                <Box display="flex" gap={1} flexWrap="wrap">
                    <Button variant="outlined" size="small" startIcon={<AddIcon />}
                        onClick={() => setEditing({ isNew: true })}>
                        Add exhibitor
                    </Button>
                    <Button variant="outlined" size="small" startIcon={<UploadFileIcon />}
                        onClick={() => setImportOpen(true)}>
                        Import CSV
                    </Button>
                    {rows.length > 0 && <SelectAllCheckbox selection={sel} />}
                </Box>
            </Stack>

            <BulkToolbar eventId={eventId} entity="exhibitors" label="exhibitors"
                         selection={sel} onDone={load} />

            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {rows.length > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                    {/* Three kinds of fact, kept apart: how many stands, how much
                        money, and how many are switched on. Run together they read
                        as one undifferentiated row of numbers. */}
                    <Stack direction="row" gap={2.5} flexWrap="wrap" alignItems="stretch"
                           divider={<Divider orientation="vertical" flexItem />}>
                        <Stack direction="row" gap={2.5}>
                            <Figure value={confirmed.length} label="Confirmed" />
                            <Figure value={rows.length - confirmed.length} label="In the pipeline" />
                        </Stack>
                        <Stack direction="row" gap={2.5}>
                            <Figure value={money(totals.due)} label="Booked" />
                            <Figure value={money(totals.paid)} label="Collected" />
                            <Figure value={money(outstanding)} label="Outstanding"
                                    color={outstanding > 0 ? 'warning.main' : 'text.primary'} />
                        </Stack>
                        <Stack direction="row" gap={2.5}>
                            <Figure value={totals.published} label="In the directory" />
                            <Figure value={totals.scanning} label="Can scan badges" />
                        </Stack>
                    </Stack>
                </Paper>
            )}

            {(paidNoScan.length > 0 || scanUnpaid.length > 0) && (
                <Alert severity={scanUnpaid.length ? 'warning' : 'info'} sx={{ mb: 2 }}
                    action={paidNoScan.length ? (
                        <Button size="small" color="inherit" disabled={granting}
                            onClick={async () => {
                                setGranting(true);
                                try {
                                    for (const r of paidNoScan) {
                                        await updateExhibitor(r.id, { can_scan_leads: true });
                                    }
                                    await load();
                                } catch (e) {
                                    setError('Could not grant scanning to every stand.');
                                } finally { setGranting(false); }
                            }}>
                            {granting ? 'Granting…' : `Let all ${paidNoScan.length} scan`}
                        </Button>
                    ) : null}>
                    {paidNoScan.length > 0 && (
                        <>{paidNoScan.length} settled {paidNoScan.length === 1 ? 'stand' : 'stands'} cannot
                        scan badges yet. </>
                    )}
                    {scanUnpaid.length > 0 && (
                        <><strong>{scanUnpaid.length} {scanUnpaid.length === 1 ? 'stand' : 'stands'} can scan
                        but {scanUnpaid.length === 1 ? 'has' : 'have'} not settled:</strong>{' '}
                        {scanUnpaid.map((r) => r.company_name).join(', ')}.</>
                    )}
                </Alert>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}
                   alignItems={{ sm: 'center' }}>
                <TextField size="small" placeholder="Search company, booth, category, package, email"
                    value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 300, flex: 1 }}
                    InputProps={{ startAdornment: (
                        <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
                    ) }} />
                <TextField select size="small" label="Stage" value={stageFilter}
                    onChange={(e) => setStageFilter(e.target.value)} sx={{ minWidth: 180 }}>
                    <MenuItem value="">All stages</MenuItem>
                    {STAGES.map((s) => <MenuItem key={s.key} value={s.key}>{s.label}</MenuItem>)}
                </TextField>
                {/* Two jobs, two views. One table with every column would be
                    unreadable, and hiding the money behind a dialog is how the
                    board drifted out of date in the first place. */}
                <ToggleButtonGroup size="small" exclusive value={view}
                    onChange={(_, v) => v && setView(v)}>
                    <ToggleButton value="roster">Roster</ToggleButton>
                    <ToggleButton value="commercial">Commercial</ToggleButton>
                </ToggleButtonGroup>
            </Stack>

            {loading && rows.length === 0 ? <CircularProgress size={26} /> : null}

            {!loading && !visible.length && (
                <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                    <Typography variant="body2">
                        {rows.length ? 'No stand matches that.' : 'No exhibitors on this event yet.'}
                    </Typography>
                </Paper>
            )}

            {grouped.map(({ stage, group }) => {
                const open = openStages[stage.key] !== false
                    && (openStages[stage.key] || stage.key === 'confirmed' || Boolean(q) || Boolean(stageFilter));
                return (
                    <Box key={stage.key} sx={{ mb: 2 }}>
                        <Stack direction="row" alignItems="baseline" gap={1.5} flexWrap="wrap"
                            sx={{ cursor: 'pointer', py: 1 }}
                            onClick={() => setOpenStages((o) => ({ ...o, [stage.key]: !open }))}>
                            <Typography variant="subtitle1" fontWeight={700}>{stage.label}</Typography>
                            <Chip size="small" label={group.length} sx={{ height: 20 }} />
                            <Typography variant="caption" color="text.secondary">{stage.note}</Typography>
                            <Box flexGrow={1} />
                            <Button size="small">{open ? 'Hide' : 'Show'}</Button>
                        </Stack>
                        {open && (view === 'roster'
                            ? <RosterCards rows={group} sel={sel} patch={patch} onEdit={setEditing}
                                           onLeads={showLeads} onSetup={setupLink} onDelete={remove}
                                           copy={copy} scanUrl={scanUrl} />
                            : <CommercialTable rows={group} patch={patch} onEdit={setEditing}
                                               onLeads={showLeads} onSetup={setupLink} />)}
                    </Box>
                );
            })}

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                <strong>In the directory</strong> puts them in front of attendees in the app.
                <strong> Can scan badges</strong> makes their lead-retrieval link work. A booth and lead
                retrieval are separate purchases, so these are separate switches — neither implies the other.
            </Typography>

            <ExhibitorDialog
                row={editing}
                saving={saving}
                onClose={() => setEditing(null)}
                onSave={async (body) => {
                    setSaving(true);
                    try {
                        if (editing.isNew) {
                            const r = await createExhibitor({ ...body, event_id: Number(eventId) });
                            setEditing(null);
                            load();
                            // The scanner link is the one thing they cannot get
                            // back without us, so show it while it is on screen.
                            if (r?.data?.access_token) {
                                window.alert(`${body.company_name} added.\n\nScanner link:\n`
                                    + `${window.location.origin}/event/scan/${r.data.access_token}`);
                            }
                        } else {
                            await updateExhibitor(editing.id, body);
                            setEditing(null);
                            load();
                        }
                    } catch (e) {
                        setError(e?.response?.data?.detail || 'That did not save.');
                    } finally { setSaving(false); }
                }}
            />

            {/* Reload on close, not on a success callback: the dialog reports
                its own result and closing is the only signal it gives. */}
            <ImportCsvDialog
                open={importOpen}
                entity="exhibitors"
                eventId={eventId}
                onClose={() => { setImportOpen(false); load(); }}
            />

            <Dialog open={Boolean(invite)} onClose={() => setInvite(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Setup link — {invite?.company_name}</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        Send this to the stand. They fill in their own description, website and logo, and
                        publishing themselves puts them in the attendee directory. It cannot change their
                        booth, their package, what they paid, or whether they may scan badges.
                    </Typography>
                    <TextField fullWidth size="small" value={invite?.url || ''} multiline
                        InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12.5 } }} />
                    <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                        <Button size="small" variant="contained" onClick={() => copy(invite.url, 'Setup link')}>
                            Copy link
                        </Button>
                        {invite?.email && (
                            <Button size="small" component="a"
                                href={`mailto:${invite.email}?subject=${encodeURIComponent('Set up your stand — Gaia Healers Elevate 2026')}&body=${encodeURIComponent(`Hi,\n\nHere is your link to set up your stand for Elevate 2026. Add your description, website and logo, and you will appear in the attendee directory.\n\n${invite.url}\n\nThe link expires in ${invite.expires_in_days} days — ask us for a new one if it runs out.\n\nGaia Healers`)}`}>
                                Email it to {invite.email}
                            </Button>
                        )}
                    </Stack>
                    <Alert severity="info" sx={{ mt: 2 }} icon={false}>
                        Expires in {invite?.expires_in_days} days. Making a new link stops the old one working.
                    </Alert>
                </DialogContent>
                <DialogActions><Button onClick={() => setInvite(null)}>Close</Button></DialogActions>
            </Dialog>

            <Dialog open={Boolean(leads)} onClose={() => setLeads(null)} maxWidth="sm" fullWidth>
                <DialogTitle>{leads?.company} — leads</DialogTitle>
                <DialogContent dividers>
                    {!leads?.items?.length ? (
                        <Alert severity="info">No badges scanned at this stand yet.</Alert>
                    ) : (
                        <Table size="small">
                            <TableBody>
                                {leads.items.map((l) => (
                                    <TableRow key={l.id}>
                                        <TableCell>{l.attendee?.first_name} {l.attendee?.last_name}</TableCell>
                                        <TableCell>{l.attendee?.company || ''}</TableCell>
                                        <TableCell align="right">{l.rating ? `${l.rating}★` : ''}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </DialogContent>
                <DialogActions><Button onClick={() => setLeads(null)}>Close</Button></DialogActions>
            </Dialog>

            <Snackbar open={Boolean(toast)} autoHideDuration={2000}
                onClose={() => setToast('')} message={toast}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
        </Box>
    );
}

function Figure({ value, label, color }) {
    return (
        <Box>
            <Typography variant="h6" color={color} sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
                {value}
            </Typography>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
        </Box>
    );
}

/**
 * The floor: booth, tables, who may scan, and what the directory would show.
 *
 * One line per stand, because there are fifty-two of them and the job is
 * scanning down the list, not reading one card. The scanner URL used to sit in
 * a full-width box on every row — nobody reads a token, they copy it, so it is
 * a button now. Everything except Edit and Leads moved behind the overflow
 * menu, which is also where Delete belongs: it should take a deliberate second
 * click, not sit under the thumb next to "List".
 */
function RosterCards({ rows, sel, patch, onEdit, onLeads, onSetup, onDelete, copy, scanUrl }) {
    const [menu, setMenu] = useState(null);
    const row = menu?.row;
    return (
        <Paper variant="outlined">
            {rows.map((ex, i) => (
                <Box key={ex.id}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1.25,
                          // Wraps rather than squeezing: on a narrow screen the
                          // chips and actions drop to their own line instead of
                          // crushing the company name to two letters.
                          flexWrap: 'wrap',
                          borderTop: i ? '1px solid' : 0, borderColor: 'divider',
                          '&:hover': { bgcolor: 'action.hover' } }}>
                    <Checkbox size="small" checked={sel.isSelected(ex.id)}
                        onChange={() => sel.toggle(ex.id)}
                        inputProps={{ 'aria-label': `Select ${ex.company_name}` }} />
                    <Logo row={ex} size={38} />

                    <Box sx={{ minWidth: 0, flex: '1 1 220px' }}>
                        <Typography variant="body2" fontWeight={600} noWrap>{ex.company_name}</Typography>
                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                            {ex.booth_number ? `Booth ${ex.booth_number}` : 'No booth'}
                            {ex.tables ? ` · ${ex.tables} table${ex.tables > 1 ? 's' : ''}` : ''}
                            {ex.category ? ` · ${ex.category}` : ''}
                        </Typography>
                        <ReadyChips row={ex} />
                    </Box>

                    {/* Both are one click, and both say what they are rather than
                        what they would become — a chip that reads "List" leaves
                        you guessing whether it is the state or the action. */}
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap
                           sx={{ flex: '0 1 auto' }}>
                        <Tooltip title={ex.is_published
                            ? 'Attendees can find this stand. Click to unlist.'
                            : 'Hidden from attendees. Click to list.'}>
                            <Chip size="small" icon={ex.is_published ? <VisibleIcon /> : <HiddenIcon />}
                                color={ex.is_published ? 'primary' : 'default'}
                                variant={ex.is_published ? 'filled' : 'outlined'}
                                label={ex.is_published ? 'Listed' : 'Not listed'}
                                onClick={() => patch(ex, { is_published: !ex.is_published })}
                                sx={{ height: 24 }} />
                        </Tooltip>
                        <Tooltip title={ex.can_scan_leads
                            ? 'Their scanner link works. Click to revoke.'
                            : 'Their scanner link is dead. Click to grant.'}>
                            <Chip size="small" icon={<ScanIcon />}
                                color={ex.can_scan_leads ? 'success' : 'default'}
                                variant={ex.can_scan_leads ? 'filled' : 'outlined'}
                                label={ex.can_scan_leads ? 'Can scan' : 'No scanning'}
                                onClick={() => patch(ex, { can_scan_leads: !ex.can_scan_leads })}
                                sx={{ height: 24 }} />
                        </Tooltip>
                    </Stack>

                    <Stack direction="row" spacing={0.5} alignItems="center"
                           sx={{ flex: '0 0 auto', ml: { xs: 0, sm: 'auto' } }}>
                        <Tooltip title={ex.lead_count ? 'See their captured leads' : 'No badges scanned yet'}>
                            <span>
                                <Badge badgeContent={ex.lead_count || 0} color="primary" showZero={false}>
                                    <Button size="small" onClick={() => onLeads(ex)}>Leads</Button>
                                </Badge>
                            </span>
                        </Tooltip>
                        <Button size="small" onClick={() => onEdit({ ...ex })}>Edit</Button>
                        <Tooltip title="More">
                            <IconButton size="small" aria-label={`More for ${ex.company_name}`}
                                onClick={(e) => setMenu({ el: e.currentTarget, row: ex })}>
                                <MoreIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    </Stack>
                </Box>
            ))}

            <Menu open={Boolean(menu)} anchorEl={menu?.el} onClose={() => setMenu(null)}>
                <MenuItem onClick={() => { copy(scanUrl(row), 'Scanner link'); setMenu(null); }}>
                    <CopyIcon fontSize="small" style={{ marginRight: 8 }} /> Copy scanner link
                </MenuItem>
                <MenuItem onClick={() => { onSetup(row); setMenu(null); }}>
                    <SendIcon fontSize="small" style={{ marginRight: 8 }} /> Send setup link
                </MenuItem>
                <Divider />
                <MenuItem onClick={() => { onDelete(row); setMenu(null); }}
                    sx={{ color: 'error.main' }}>
                    <DeleteIcon fontSize="small" style={{ marginRight: 8 }} /> Delete stand
                </MenuItem>
            </Menu>
        </Paper>
    );
}

/** The board: stage, package, money, and the two permissions. */
function CommercialTable({ rows, patch, onEdit, onLeads, onSetup }) {
    return (
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small">
                <TableHead>
                    <TableRow>
                        <TableCell>Company</TableCell>
                        <TableCell>Package</TableCell>
                        <TableCell align="right">Booked</TableCell>
                        <TableCell align="right">Paid</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="center">In the directory</TableCell>
                        <TableCell align="center">Can scan badges</TableCell>
                        <TableCell align="right" />
                    </TableRow>
                </TableHead>
                <TableBody>
                    {rows.map((r) => {
                        const st = STATUS[r.payment_status] || STATUS.unpaid;
                        const owes = (r.amount_due || 0) - (r.amount_paid || 0);
                        return (
                            <TableRow key={r.id} hover>
                                <TableCell>
                                    <Stack direction="row" spacing={1.25} alignItems="center">
                                        <Logo row={r} />
                                        <Box sx={{ minWidth: 0 }}>
                                            <Typography variant="body2" fontWeight={600}>{r.company_name}</Typography>
                                            <Typography variant="caption" color="text.secondary" noWrap display="block">
                                                {r.booth_number ? `Booth ${r.booth_number} · ` : ''}
                                                {r.tables ? `${r.tables} table${r.tables > 1 ? 's' : ''} · ` : ''}
                                                {r.category || 'Exhibitor'}
                                            </Typography>
                                            <ReadyChips row={r} />
                                        </Box>
                                    </Stack>
                                </TableCell>
                                <TableCell><Typography variant="caption">{r.package || '—'}</Typography></TableCell>
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amount_due)}</TableCell>
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amount_paid)}</TableCell>
                                <TableCell>
                                    <Tooltip title={r.payment_note || ''} placement="top">
                                        <span>
                                            <Chip size="small" color={st.color} label={st.label} sx={{ height: 20, fontSize: 11 }} />
                                            {owes > 0 && (
                                                <Typography variant="caption" color="warning.main" display="block">
                                                    {money(owes)} owing
                                                </Typography>
                                            )}
                                        </span>
                                    </Tooltip>
                                </TableCell>
                                <TableCell align="center">
                                    <Switch size="small" checked={!!r.is_published}
                                        onChange={(e) => patch(r, { is_published: e.target.checked })} />
                                </TableCell>
                                <TableCell align="center">
                                    <Switch size="small" checked={!!r.can_scan_leads}
                                        onChange={(e) => patch(r, { can_scan_leads: e.target.checked })} />
                                </TableCell>
                                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                                    <Button size="small" onClick={() => onEdit({ ...r })}>Edit</Button>
                                    <Button size="small" onClick={() => onLeads(r)}>Leads</Button>
                                    <Button size="small" onClick={() => onSetup(r)}>Setup link</Button>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Paper>
    );
}

/**
 * One dialog for one stand. There used to be two — a short "profile" on the
 * event tab and a full "edit" on the Vendors screen — which meant the answer to
 * "where do I change the booth?" depended on which screen you happened to be
 * on. Sections, not tabs: it is one record and it is short enough to read.
 */
function ExhibitorDialog({ row, saving, onClose, onSave }) {
    const [f, setF] = useState({});
    useEffect(() => { setF(row ? { ...row } : {}); }, [row]);
    if (!row) return null;
    const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
    const field = (label, key, extra = {}) => (
        <TextField label={label} size="small" fullWidth value={f[key] ?? ''} onChange={set(key)} {...extra} />
    );
    const toggle = (key, title, note) => (
        <Stack direction="row" alignItems="center" spacing={1}>
            <Switch size="small" checked={!!f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} />
            <Box>
                <Typography variant="body2">{title}</Typography>
                <Typography variant="caption" color="text.secondary">{note}</Typography>
            </Box>
        </Stack>
    );
    return (
        <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
            <DialogTitle>{row.isNew ? 'Add an exhibitor' : f.company_name}</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {field('Company name', 'company_name', { required: true })}
                    <TextField select label="Stage" size="small" fullWidth
                        value={f.stage || 'confirmed'} onChange={set('stage')}
                        helperText="Move a stand to Confirmed when they pay.">
                        {STAGES.map((st) => <MenuItem key={st.key} value={st.key}>{st.label}</MenuItem>)}
                    </TextField>

                    <Divider textAlign="left"><Typography variant="caption">On the floor</Typography></Divider>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Booth number', 'booth_number', {
                            helperText: 'Shown to attendees. A label, not a number — "#7 & #8" is fine.',
                        })}
                        {field('Tables', 'tables', { type: 'number', inputProps: { min: 0, max: 20 } })}
                        {field('Category', 'category')}
                    </Stack>
                    {field('Sort order', 'sort_order', {
                        type: 'number',
                        helperText: 'Lower sorts first in the attendee directory.',
                    })}

                    <Divider textAlign="left"><Typography variant="caption">Directory entry</Typography></Divider>
                    {field('Website', 'website', { placeholder: 'https://…' })}
                    {field('Description', 'description', {
                        multiline: true, rows: 2, helperText: 'Shown in the attendee directory.',
                    })}
                    {field('Tagline', 'tagline', { helperText: 'The one line they lead with on their own site.' })}
                    {field('Logo URL', 'logo_url')}
                    {toggle('logo_on_dark', 'Logo needs a dark tile',
                            'For white artwork that would disappear on a white card.')}
                    {toggle('is_published', 'In the attendee directory',
                            'Attendees can find this stand in the app.')}

                    <Divider textAlign="left"><Typography variant="caption">Public contact — from their website</Typography></Divider>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
                        Already published by the company, so it appears in the directory without asking.
                    </Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Public email', 'public_email')}
                        {field('Public phone', 'public_phone')}
                    </Stack>
                    {field('Address', 'address')}

                    <Divider textAlign="left"><Typography variant="caption">Our contact — internal</Typography></Divider>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Email', 'contact_email')}
                        {field('Phone', 'contact_phone')}
                    </Stack>
                    {toggle('show_contact_publicly', 'Also show our contact in the directory',
                            'Off by default. This is whoever booked the booth and is often a personal '
                            + 'mobile — the directory already uses the public details above.')}

                    <Divider textAlign="left"><Typography variant="caption">What they bought</Typography></Divider>
                    {field('Package', 'package')}
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Booked', 'amount_due', { type: 'number' })}
                        {field('Paid', 'amount_paid', { type: 'number' })}
                        <TextField select label="Status" size="small" fullWidth
                            value={f.payment_status || 'unpaid'} onChange={set('payment_status')}>
                            {Object.entries(STATUS).map(([k, v]) => (
                                <MenuItem key={k} value={k}>{v.label}</MenuItem>
                            ))}
                        </TextField>
                    </Stack>
                    {field('Payment note', 'payment_note', {
                        multiline: true, rows: 2,
                        helperText: 'Kept exactly as it was written in the planning sheet.',
                    })}
                    {toggle('can_scan_leads', 'Can scan badges',
                            'Makes their lead-retrieval link work. Sold separately from the booth.')}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={saving}>Cancel</Button>
                <Button variant="contained" disabled={saving || !f.company_name}
                    onClick={() => {
                        const body = {};
                        ['company_name', 'stage', 'booth_number', 'category', 'website', 'description',
                         'tagline', 'logo_url', 'public_email', 'public_phone', 'address',
                         'contact_email', 'contact_phone', 'package', 'payment_note'].forEach((k) => {
                            if (f[k] !== undefined) body[k] = f[k] === '' ? null : f[k];
                        });
                        body.payment_status = f.payment_status || 'unpaid';
                        body.show_contact_publicly = !!f.show_contact_publicly;
                        body.logo_on_dark = !!f.logo_on_dark;
                        body.can_scan_leads = !!f.can_scan_leads;
                        // A new stand goes into the directory unless said otherwise;
                        // an existing one keeps whatever the switch shows.
                        body.is_published = row.isNew ? (f.is_published !== false) : !!f.is_published;
                        ['amount_due', 'amount_paid', 'tables', 'sort_order'].forEach((k) => {
                            body[k] = f[k] === '' || f[k] == null ? null : Number(f[k]);
                        });
                        // Creating requires a contact email even when nobody has
                        // one yet — the old Add form always sent the empty box,
                        // and the old Vendors form omitted it and 400'd. Send it.
                        if (row.isNew) {
                            body.contact_email = f.contact_email || '';
                            body.contact_phone = f.contact_phone || '';
                        }
                        onSave(body);
                    }}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
