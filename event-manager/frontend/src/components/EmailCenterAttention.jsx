import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack,
    Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography, useMediaQuery,
} from '@mui/material';
import { ecAttentionMark, ecIssueComment, ecQueue } from '../utils/api';
import { errText, gst, NoteDialog, SeverityChip } from './EmailCenterShared';
import { AssignControls } from './EmailCenterProblems';

/**
 * Needs Attention = the work queue (GET /queue). Reconciliation problems
 * (items with issue_id) are assigned / noted here and fixed in the order's
 * Review panel; they close when the re-check no longer finds them. Other
 * items (exhibitor, delivery, approval-invalidated, flagged) keep the
 * /attention/{key} status / assign / note controls.
 */
const FILTERS = [
    ['open', 'Open'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'],
    ['mine', 'Assigned to me'], ['awaiting_approval', 'Awaiting approval'], ['ready_to_fix', 'Ready to fix'], ['resolved', 'Resolved'],
];
const STATUS = {
    open: ['Open', 'default'], in_review: ['In review', 'info'], reviewed: ['Reviewed', 'info'],
    awaiting_approval: ['Awaiting approval', 'warning'], resolved: ['Resolved', 'success'], in_progress: ['In progress', 'info'],
};
const STAGE = {
    flagged: 'Flagged', investigating: 'Investigating', correction_proposed: 'Correction proposed', confirmed: 'Confirmed',
    reviewed: 'Reviewed (kept as is)', corrected_still_flagged: 'Corrected, still flagged', revalidated: 'Revalidated',
};
const MARK_STATUS = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']];

/** The old /attention/{key} controls, for items that are not reconciliation problems. */
function MarkDialog({ eventId, item, onClose, onSaved }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [form, setForm] = useState({ status: 'open', assigned_to: '', note: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (item) setForm({ status: item.stage === 'investigating' ? 'in_progress' : 'open', assigned_to: item.assigned_name || '', note: item.note || '' });
        setError('');
    }, [item]);
    if (!item) return null;
    const save = () => {
        setBusy(true);
        ecAttentionMark(eventId, item.key, form).then(() => { onSaved(); onClose(); }).catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm" fullScreen={narrow}>
            <DialogTitle>Update: {item.problem}</DialogTitle>
            <DialogContent dividers>
                {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
                <TextField select fullWidth size="small" label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} sx={{ mb: 2 }}>
                    {MARK_STATUS.map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
                </TextField>
                <TextField fullWidth size="small" label="Assigned to" value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} sx={{ mb: 2 }} />
                <TextField fullWidth multiline minRows={2} label="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
            </DialogActions>
        </Dialog>
    );
}

export default function EmailCenterAttention({ eventId, me, goTab }) {
    const navigate = useNavigate();
    const [filter, setFilter] = useState('open');
    const [category, setCategory] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');
    const [noteFor, setNoteFor] = useState(null);
    const [markFor, setMarkFor] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => ecQueue(eventId, filter).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(errText(e))), [eventId, filter]);
    useEffect(() => { load(); }, [load]);

    const addNote = ({ note }) => {
        setBusy(true);
        ecIssueComment(eventId, noteFor.issue_id, note).then(() => { setNoteFor(null); setMsg('Note added.'); load(); })
            .catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const openItem = (it) => {
        if (it.booking) goTab('tickets', { openKey: it.booking, focus: 'problems' });
        else if (it.exhibitor && me?.exhibitors) goTab('exhibitors', { focusId: it.exhibitor });
    };

    if (!data) return error ? <Alert severity="error">{error}</Alert> : <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>;
    const cats = Object.entries(data.by_category || {}).sort((a, b) => b[1] - a[1]);
    const items = (data.items || []).filter((it) => !category || it.kind_label === category);
    const countFor = { open: data.open, awaiting_approval: data.awaiting_approval };

    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            {msg && <Alert severity="success" onClose={() => setMsg('')} sx={{ mb: 1 }}>{msg}</Alert>}
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                {FILTERS.map(([k, l]) => (
                    <Chip key={k} label={countFor[k] != null ? `${l} (${countFor[k]})` : l} clickable
                          color={filter === k ? 'primary' : 'default'} variant={filter === k ? 'filled' : 'outlined'}
                          onClick={() => { setFilter(k); setCategory(''); }} />
                ))}
            </Stack>
            {cats.length > 0 && (
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }} alignItems="center">
                    <Typography variant="caption" color="text.secondary">Open by category:</Typography>
                    {cats.map(([l, n]) => (
                        <Chip key={l} size="small" label={`${l}: ${n}`} clickable color={category === l ? 'secondary' : 'default'}
                              variant={category === l ? 'filled' : 'outlined'} onClick={() => setCategory(category === l ? '' : l)} />
                    ))}
                </Stack>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                Problems close themselves when the re-check no longer finds them — there is no 'mark resolved' for ticket problems.
                Open an order to fix its problems in “Problems &amp; fixes”.
            </Typography>

            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 1100 }}>
                    <TableHead><TableRow>
                        <TableCell>Order</TableCell><TableCell>Customer</TableCell><TableCell>Problem</TableCell><TableCell>Severity</TableCell>
                        <TableCell>Assigned</TableCell><TableCell>Status / stage</TableCell><TableCell>Recommended action</TableCell>
                        <TableCell>Last update</TableCell><TableCell>Actions</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                        {items.map((it) => {
                            const [sl, sc] = STATUS[it.status] || [String(it.status || '').replace(/_/g, ' '), 'default'];
                            const canOpen = it.booking || (it.exhibitor && me?.exhibitors);
                            return (
                                <TableRow key={it.key} hover sx={{ opacity: it.status === 'resolved' ? 0.7 : 1, verticalAlign: 'top' }}>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{it.order_number || it.booking || '—'}</TableCell>
                                    <TableCell sx={{ minWidth: 140 }}>{it.customer || '—'}</TableCell>
                                    <TableCell sx={{ minWidth: 220 }}>
                                        <Typography variant="body2" fontWeight={600}>{it.problem}</Typography>
                                        <Typography variant="caption" color="text.secondary">{it.kind_label}{it.blocks_email ? ' · blocks the email' : ''}</Typography>
                                        {it.note && <Typography variant="caption" sx={{ display: 'block' }}>Note: {it.note}</Typography>}
                                    </TableCell>
                                    <TableCell><SeverityChip s={it.severity} /></TableCell>
                                    <TableCell sx={{ minWidth: 110 }}>{it.assigned_name ? `${it.assigned_name}${it.assigned_to_me ? ' (you)' : ''}` : '—'}</TableCell>
                                    <TableCell sx={{ minWidth: 140 }}>
                                        <Chip size="small" label={sl} color={sc} />
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{STAGE[it.stage] || it.stage}</Typography>
                                        {it.proposals > 0 && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{it.proposals} proposal{it.proposals === 1 ? '' : 's'}</Typography>}
                                    </TableCell>
                                    <TableCell sx={{ minWidth: 200 }}>{it.recommended_action || '—'}</TableCell>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(it.last_update)}</TableCell>
                                    <TableCell sx={{ minWidth: 200 }}>
                                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                                            {canOpen && <Button size="small" variant="contained" onClick={() => openItem(it)}>Open</Button>}
                                            {it.issue_id && me?.review && it.status !== 'resolved' && <>
                                                <AssignControls eventId={eventId} issueId={it.issue_id} assignedTo={it.assigned_to} myId={me?.user_id}
                                                                onDone={() => { setMsg('Assignment saved.'); load(); }} onError={setError} />
                                                <Button size="small" onClick={() => setNoteFor(it)}>Add note</Button>
                                            </>}
                                            {!it.issue_id && me?.review && <Button size="small" variant="outlined" onClick={() => setMarkFor(it)}>Update</Button>}
                                            {it.kind === 'systemic' && me?.reconcile && (
                                                <Button size="small" onClick={() => navigate(`/events/${eventId}/reconcile`)}>Ticket Reconciliation</Button>)}
                                        </Stack>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                        {!items.length && (
                            <TableRow><TableCell colSpan={9}>
                                <Alert severity="success">{filter === 'resolved' ? 'Nothing resolved yet.' : 'Nothing needs attention here right now.'}</Alert>
                            </TableCell></TableRow>
                        )}
                    </TableBody>
                </Table>
            </Paper>

            <NoteDialog open={Boolean(noteFor)} title={`Add a note — ${noteFor?.problem || ''}`} busy={busy} noteLabel="Note"
                        help="Added to the problem's history (the same history as Ticket Reconciliation)."
                        confirmLabel="Add note" onClose={() => setNoteFor(null)} onConfirm={addNote} />
            <MarkDialog eventId={eventId} item={markFor} onClose={() => setMarkFor(null)} onSaved={load} />
        </Box>
    );
}
