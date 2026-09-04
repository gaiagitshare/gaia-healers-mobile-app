import React, { useCallback, useEffect, useState } from 'react';
import {
    Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell,
    Chip, Switch, Button, Dialog, DialogTitle, DialogContent, DialogActions,
    TextField, MenuItem, Stack, Alert, CircularProgress, Tooltip, Divider,
} from '@mui/material';
import {
    getEvents, getExhibitors, updateExhibitor, createExhibitor, getExhibitorLeads,
    vendorActivationLink,
} from '../utils/api';

/**
 * Vendors — the stands, what they bought, and what they may do.
 *
 * This lived in a spreadsheet: a free-text payment column and a green
 * highlight. That is fine for planning and cannot be the thing that decides who
 * may scan attendees on the day, so the money moved here and the green stayed
 * there.
 *
 * Two switches per vendor, deliberately separate:
 *   In the directory — attendees can find them in the app.
 *   Can scan badges  — their lead-retrieval link actually works.
 * Paying for a booth and paying for lead retrieval are different purchases, and
 * one being on has never meant the other should be.
 */

// Where a stand is in the conversation, and how much attention it deserves.
// The sheet keeps prospects, maybes and refusals in the same list as confirmed
// stands, separated by a heading — which is right, because a maybe becomes
// confirmed the day they pay. Grouping keeps that without letting a "not
// aligned" stand sit one stray click from the attendee directory.
const STAGES = [
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

export default function Vendors() {
    const [events, setEvents] = useState([]);
    const [eventId, setEventId] = useState('');
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(null);
    const [saving, setSaving] = useState(false);
    const [leads, setLeads] = useState(null);
    const [invite, setInvite] = useState(null);
    const [openStages, setOpenStages] = useState({ confirmed: true });
    const [granting, setGranting] = useState(false);

    useEffect(() => {
        getEvents()
            .then((r) => {
                const list = r.data || [];
                setEvents(list);
                if (list.length && !eventId) setEventId(String(list[0].id));
            })
            .catch(() => setEvents([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const load = useCallback(async () => {
        if (!eventId) return;
        setLoading(true); setError('');
        try {
            const r = await getExhibitors(eventId);
            setRows(r.data || []);
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not load the vendors.');
        } finally { setLoading(false); }
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

    // Money means the CONFIRMED stands. A prospect has not booked anything, and
    // rolling them in would make "booked" a number nobody could act on.
    const confirmed = rows.filter((r) => (r.stage || 'confirmed') === 'confirmed');
    const totals = confirmed.reduce((a, r) => ({
        due: a.due + (r.amount_due || 0),
        paid: a.paid + (r.amount_paid || 0),
        published: a.published + (r.is_published ? 1 : 0),
        scanning: a.scanning + (r.can_scan_leads ? 1 : 0),
    }), { due: 0, paid: 0, published: 0, scanning: 0 });
    const outstanding = totals.due - totals.paid;

    return (
        <Box>
            <Typography variant="h4" gutterBottom>Vendors</Typography>

            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
                    <TextField select size="small" label="Event" value={eventId}
                        onChange={(e) => setEventId(e.target.value)} sx={{ minWidth: 260 }}>
                        {events.map((ev) => <MenuItem key={ev.id} value={String(ev.id)}>{ev.name}</MenuItem>)}
                    </TextField>
                    <Button size="small" onClick={load} disabled={loading}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </Button>
                    <Box flexGrow={1} />
                    <Button size="small" variant="outlined" onClick={() => setEditing({ isNew: true, event_id: Number(eventId) })}>
                        Add a vendor
                    </Button>
                </Stack>
            </Paper>

            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {rows.length > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 3 }}>
                    <Stack direction="row" gap={3} flexWrap="wrap" alignItems="baseline">
                        <Box><Typography variant="h6">{confirmed.length}</Typography>
                            <Typography variant="caption" color="text.secondary">Confirmed</Typography></Box>
                        <Box><Typography variant="h6">{rows.length - confirmed.length}</Typography>
                            <Typography variant="caption" color="text.secondary">In the pipeline</Typography></Box>
                        <Box><Typography variant="h6">{money(totals.due)}</Typography>
                            <Typography variant="caption" color="text.secondary">Booked</Typography></Box>
                        <Box><Typography variant="h6">{money(totals.paid)}</Typography>
                            <Typography variant="caption" color="text.secondary">Collected</Typography></Box>
                        <Box>
                            <Typography variant="h6" color={outstanding > 0 ? 'warning.main' : 'text.primary'}>
                                {money(outstanding)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">Outstanding</Typography>
                        </Box>
                        <Box><Typography variant="h6">{totals.published}</Typography>
                            <Typography variant="caption" color="text.secondary">In the directory</Typography></Box>
                        <Box><Typography variant="h6">{totals.scanning}</Typography>
                            <Typography variant="caption" color="text.secondary">Can scan badges</Typography></Box>
                    </Stack>
                </Paper>
            )}

            {/* Scanning is sold, and paying for a booth is not the same purchase —
                but in practice these should agree, and when they drift it is
                worth saying so rather than discovering it at the door. */}
            {(() => {
                const paid = confirmed.filter((r) => r.payment_status === 'paid' || r.payment_status === 'comp');
                const paidNoScan = paid.filter((r) => !r.can_scan_leads);
                const scanUnpaid = confirmed.filter((r) => r.can_scan_leads
                    && r.payment_status !== 'paid' && r.payment_status !== 'comp');
                if (!paidNoScan.length && !scanUnpaid.length) return null;
                return (
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
                );
            })()}

            {loading && rows.length === 0 ? <CircularProgress size={26} /> : STAGES.map((stage) => {
                const group = rows.filter((r) => (r.stage || 'confirmed') === stage.key);
                if (!group.length) return null;
                const open = openStages[stage.key] !== false && (openStages[stage.key] || stage.key === 'confirmed');
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
                    {open && (
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
                            {group.map((r) => {
                                const st = STATUS[r.payment_status] || STATUS.unpaid;
                                const owes = (r.amount_due || 0) - (r.amount_paid || 0);
                                return (
                                    <TableRow key={r.id} hover>
                                        <TableCell>
                                            <Stack direction="row" spacing={1.25} alignItems="center">
                                                {r.logo_url
                                                    ? <Box component="img" src={r.logo_url} alt=""
                                                        sx={{ width: 34, height: 34, objectFit: 'contain',
                                                              borderRadius: 1, bgcolor: '#fff', p: 0.25, flex: '0 0 auto' }} />
                                                    : <Box sx={{ width: 34, height: 34, borderRadius: 1,
                                                                 border: '1px dashed', borderColor: 'divider', flex: '0 0 auto' }} />}
                                                <Box sx={{ minWidth: 0 }}>
                                                    <Typography variant="body2" fontWeight={600}>{r.company_name}</Typography>
                                                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                                                        {r.booth_number ? `Booth ${r.booth_number} · ` : ''}
                                                        {r.tables ? `${r.tables} table${r.tables > 1 ? 's' : ''} · ` : ''}
                                                        {r.category || 'Exhibitor'}
                                                    </Typography>
                                                    {/* What the attendee directory would actually show. A stand
                                                        missing a description is a blank card, and the fix is to
                                                        send them their setup link. */}
                                                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.4 }}>
                                                        {[['Logo', r.logo_url], ['About', r.description],
                                                          ['Link', r.website], ['Contact', r.public_email || r.public_phone]]
                                                            .map(([lbl, ok]) => (
                                                                <Chip key={lbl} size="small" label={lbl}
                                                                    variant={ok ? 'filled' : 'outlined'}
                                                                    color={ok ? 'success' : 'default'}
                                                                    sx={{ height: 17, fontSize: 10,
                                                                          opacity: ok ? 1 : 0.45,
                                                                          '& .MuiChip-label': { px: 0.6 } }} />
                                                            ))}
                                                    </Stack>
                                                </Box>
                                            </Stack>
                                        </TableCell>
                                        <TableCell>
                                            <Typography variant="caption">{r.package || '—'}</Typography>
                                        </TableCell>
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
                                            <Button size="small" onClick={() => setEditing({ ...r })}>Edit</Button>
                                            <Button size="small" onClick={async () => {
                                                try {
                                                    const l = await getExhibitorLeads(r.id);
                                                    setLeads({ company: r.company_name, items: l.data || [] });
                                                } catch (e) { setError('Could not load their leads.'); }
                                            }}>Leads</Button>
                                            <Button size="small" onClick={async () => {
                                                try {
                                                    const l = await vendorActivationLink(r.id);
                                                    setInvite(l.data);
                                                } catch (e) {
                                                    setError(e?.response?.data?.detail || 'Could not make a setup link.');
                                                }
                                            }}>Setup link</Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </Paper>
                    )}
                </Box>
                );
            })}

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                <strong>In the directory</strong> puts them in front of attendees in the app.
                <strong> Can scan badges</strong> makes their lead-retrieval link work. A booth and lead
                retrieval are separate purchases, so these are separate switches — neither implies the other.
            </Typography>

            <VendorDialog
                vendor={editing}
                saving={saving}
                onClose={() => setEditing(null)}
                onSave={async (body) => {
                    setSaving(true);
                    try {
                        if (editing.isNew) await createExhibitor({ ...body, event_id: Number(eventId) });
                        else await updateExhibitor(editing.id, body);
                        setEditing(null);
                        load();
                    } catch (e) {
                        setError(e?.response?.data?.detail || 'That did not save.');
                    } finally { setSaving(false); }
                }}
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
                        <Button size="small" variant="contained" onClick={() => {
                            navigator.clipboard?.writeText(invite.url);
                        }}>Copy link</Button>
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
        </Box>
    );
}

function VendorDialog({ vendor, saving, onClose, onSave }) {
    const [f, setF] = useState({});
    useEffect(() => { setF(vendor ? { ...vendor } : {}); }, [vendor]);
    if (!vendor) return null;
    const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
    const field = (label, key, extra = {}) => (
        <TextField label={label} size="small" fullWidth value={f[key] ?? ''} onChange={set(key)} {...extra} />
    );
    return (
        <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
            <DialogTitle>{vendor.isNew ? 'Add a vendor' : f.company_name}</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                    {field('Company name', 'company_name', { required: true })}
                    <TextField select label="Stage" size="small" fullWidth
                        value={f.stage || 'confirmed'} onChange={set('stage')}
                        helperText="Move a stand to Confirmed when they pay.">
                        {STAGES.map((st) => <MenuItem key={st.key} value={st.key}>{st.label}</MenuItem>)}
                    </TextField>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Booth number', 'booth_number', {
                            helperText: 'Shown to attendees. A label, not a number — "#7 & #8" is fine.',
                        })}
                        {field('Tables', 'tables', { type: 'number', inputProps: { min: 0, max: 20 } })}
                        {field('Category', 'category')}
                    </Stack>
                    {field('Website', 'website', { placeholder: 'https://…' })}
                    {field('Description', 'description', {
                        multiline: true, rows: 2,
                        helperText: 'Shown in the attendee directory.',
                    })}

                    {field('Tagline', 'tagline', { helperText: 'The one line they lead with on their own site.' })}
                    {field('Logo URL', 'logo_url')}

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
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <Switch size="small" checked={!!f.show_contact_publicly}
                            onChange={(e) => setF({ ...f, show_contact_publicly: e.target.checked })} />
                        <Box>
                            <Typography variant="body2">Also show our contact in the directory</Typography>
                            <Typography variant="caption" color="text.secondary">
                                Off by default. This is whoever booked the booth and is often a personal
                                mobile — the directory already uses the public details above.
                            </Typography>
                        </Box>
                    </Stack>

                    <Divider textAlign="left"><Typography variant="caption">What they bought</Typography></Divider>
                    {field('Package', 'package')}
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        {field('Booked', 'amount_due', { type: 'number' })}
                        {field('Paid', 'amount_paid', { type: 'number' })}
                        <TextField select label="Status" size="small" fullWidth
                            value={f.payment_status || 'unpaid'}
                            onChange={set('payment_status')}>
                            {Object.entries(STATUS).map(([k, v]) => (
                                <MenuItem key={k} value={k}>{v.label}</MenuItem>
                            ))}
                        </TextField>
                    </Stack>
                    {field('Payment note', 'payment_note', {
                        multiline: true, rows: 2,
                        helperText: 'Kept exactly as it was written in the planning sheet.',
                    })}
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
                        ['amount_due', 'amount_paid', 'tables'].forEach((k) => {
                            body[k] = f[k] === '' || f[k] == null ? null : Number(f[k]);
                        });
                        onSave(body);
                    }}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
