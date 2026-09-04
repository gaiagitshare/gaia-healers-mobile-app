import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, Button, TextField, IconButton, Chip,
    Table, TableBody, TableCell, TableHead, TableRow, Dialog, DialogTitle,
    DialogContent, DialogActions, MenuItem, Select, FormControl, InputLabel,
    FormControlLabel, Switch, Alert, Stack, Rating,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
    getTicketTypes, createTicketType, updateTicketType, deleteTicketType,
    getRoles, grantRole, revokeRole,
    getPlaces, createPlace, updatePlace, deletePlace,
    getFeedbackSummary, getExhibitors,
} from '../utils/api';

/*
 * Event Setup — the operator-facing half of everything the attendee app runs on.
 *
 * Four managers, one page: passes (ticket types), staff (per-event roles), map
 * pins (venue places) and the feedback aggregates. Each was API-complete before
 * this page existed; this page is what turns "possible with curl" into
 * "possible for the person actually running the event".
 */

const PLACE_KINDS = ['room', 'booth', 'stage', 'registration', 'restroom', 'food', 'entrance', 'help', 'other'];
const ROLE_OPTIONS = [
    ['organizer', 'Organizer — full control of this event'],
    ['checkin_staff', 'Check-in staff — doors and search only'],
    ['exhibitor_manager', 'Exhibitor manager — stands and leads'],
];

const EMPTY_TT = { code: '', name: '', description: '', is_vip: false, grants_workshops: false };
const EMPTY_PLACE = { kind: 'room', name: '', description: '', x: 50, y: 50, exhibitor_id: '' };
const EMPTY_ROLE = { email: '', role: 'checkin_staff', password: '', full_name: '' };

function EventSetup() {
    const { id } = useParams();
    const [ticketTypes, setTicketTypes] = useState([]);
    const [roles, setRoles] = useState([]);
    const [places, setPlaces] = useState([]);
    const [exhibitors, setExhibitors] = useState([]);
    const [feedback, setFeedback] = useState(null);
    const [error, setError] = useState('');

    const [ttDialog, setTtDialog] = useState(false);
    const [ttDraft, setTtDraft] = useState(EMPTY_TT);
    const [ttEditing, setTtEditing] = useState(null);

    const [placeDialog, setPlaceDialog] = useState(false);
    const [placeDraft, setPlaceDraft] = useState(EMPTY_PLACE);
    const [placeEditing, setPlaceEditing] = useState(null);

    const [roleDialog, setRoleDialog] = useState(false);
    const [roleDraft, setRoleDraft] = useState(EMPTY_ROLE);

    const load = useCallback(async () => {
        // Each panel degrades alone: a feedback hiccup must not blank the passes.
        const grab = async (call, set, fallback) => {
            try { const r = await call(); set(r.data); } catch (_) { set(fallback); }
        };
        await Promise.all([
            grab(() => getTicketTypes(id), setTicketTypes, []),
            grab(() => getRoles(id), setRoles, []),
            grab(() => getPlaces(id), setPlaces, []),
            grab(() => getExhibitors(id), setExhibitors, []),
            grab(() => getFeedbackSummary(id), setFeedback, null),
        ]);
    }, [id]);

    useEffect(() => { load(); }, [load]);

    const say = (e, fallback) => setError(e?.response?.data?.detail || fallback);

    const saveTicketType = async () => {
        try {
            if (ttEditing) await updateTicketType(ttEditing, ttDraft);
            else await createTicketType(id, ttDraft);
            setTtDialog(false); setError(''); load();
        } catch (e) { say(e, 'Could not save the pass.'); }
    };

    const savePlace = async () => {
        const payload = {
            ...placeDraft,
            x: Number(placeDraft.x) || 0,
            y: Number(placeDraft.y) || 0,
            exhibitor_id: placeDraft.exhibitor_id === '' ? null : Number(placeDraft.exhibitor_id),
        };
        try {
            if (placeEditing) await updatePlace(placeEditing, payload);
            else await createPlace(id, payload);
            setPlaceDialog(false); setError(''); load();
        } catch (e) { say(e, 'Could not save the place.'); }
    };

    const saveRole = async () => {
        try {
            await grantRole(id, {
                ...roleDraft,
                password: roleDraft.password || undefined,
                full_name: roleDraft.full_name || undefined,
            });
            setRoleDialog(false); setRoleDraft(EMPTY_ROLE); setError(''); load();
        } catch (e) { say(e, 'Could not grant the role.'); }
    };

    return (
        <Box>
            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {/* ── Passes ─────────────────────────────────────────────────── */}
            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                        <Box>
                            <Typography variant="h6">Passes (ticket types)</Typography>
                            <Typography variant="body2" color="textSecondary">
                                Access comes from these rows, never from a pass's name — so marketing
                                can rename "VIP" freely without changing who gets into the VIP room.
                            </Typography>
                        </Box>
                        <Button variant="contained" onClick={() => { setTtDraft(EMPTY_TT); setTtEditing(null); setTtDialog(true); }}>
                            Add pass
                        </Button>
                    </Box>
                    {ticketTypes.length === 0
                        ? <Alert severity="info">No passes yet. Attendees without a pass hold no special access.</Alert>
                        : (
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Code (canonical)</TableCell>
                                        <TableCell>Name (shown)</TableCell>
                                        <TableCell>Grants</TableCell>
                                        <TableCell align="right" />
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {ticketTypes.map((tt) => (
                                        <TableRow key={tt.id}>
                                            <TableCell><code>{tt.code}</code></TableCell>
                                            <TableCell>{tt.name}</TableCell>
                                            <TableCell>
                                                {tt.is_vip && <Chip size="small" color="warning" label="VIP" sx={{ mr: 0.5 }} />}
                                                {tt.grants_workshops && <Chip size="small" color="success" label="Workshops" />}
                                                {!tt.is_vip && !tt.grants_workshops && <Typography variant="body2" color="textSecondary">standard</Typography>}
                                            </TableCell>
                                            <TableCell align="right">
                                                <IconButton size="small" aria-label={`Edit ${tt.name}`}
                                                    onClick={() => { setTtDraft(tt); setTtEditing(tt.id); setTtDialog(true); }}>
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                                <IconButton size="small" aria-label={`Delete ${tt.name}`}
                                                    onClick={async () => {
                                                        try { await deleteTicketType(tt.id); setError(''); load(); }
                                                        catch (e) { say(e, 'Could not delete.'); }
                                                    }}>
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                </CardContent>
            </Card>

            {/* ── Staff & roles ──────────────────────────────────────────── */}
            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                        <Box>
                            <Typography variant="h6">Staff & roles</Typography>
                            <Typography variant="body2" color="textSecondary">
                                Roles apply to this event only. Door staff hired for this weekend
                                cannot touch any other event, and nothing here can create an admin.
                            </Typography>
                        </Box>
                        <Button variant="contained" onClick={() => setRoleDialog(true)}>Grant a role</Button>
                    </Box>
                    {roles.length === 0
                        ? <Alert severity="info">Nobody has a scoped role here yet. Platform admins always have access.</Alert>
                        : roles.map((r) => (
                            <Box key={r.id} display="flex" justifyContent="space-between" alignItems="center"
                                sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                                <Box>
                                    <Typography variant="body1">{r.full_name || r.email}</Typography>
                                    <Typography variant="body2" color="textSecondary">{r.email}</Typography>
                                </Box>
                                <Box display="flex" gap={1} alignItems="center">
                                    <Chip size="small" label={r.role.replace('_', ' ')} />
                                    <IconButton size="small" aria-label={`Revoke ${r.email}`}
                                        onClick={async () => { await revokeRole(r.id); load(); }}>
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                </Box>
                            </Box>
                        ))}
                </CardContent>
            </Card>

            {/* ── Venue places ───────────────────────────────────────────── */}
            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                        <Box>
                            <Typography variant="h6">Venue places (map pins)</Typography>
                            <Typography variant="body2" color="textSecondary">
                                Positions are percentages of the map image — 0,0 is the top-left,
                                100,100 the bottom-right. Set the map image itself on the Overview tab.
                            </Typography>
                        </Box>
                        <Button variant="contained" onClick={() => { setPlaceDraft(EMPTY_PLACE); setPlaceEditing(null); setPlaceDialog(true); }}>
                            Add place
                        </Button>
                    </Box>
                    {places.length === 0
                        ? <Alert severity="info">No places yet — the app hides the Map tab until there is something to find.</Alert>
                        : (
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Name</TableCell>
                                        <TableCell>Kind</TableCell>
                                        <TableCell>Position</TableCell>
                                        <TableCell>Exhibitor</TableCell>
                                        <TableCell align="right" />
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {places.map((p) => (
                                        <TableRow key={p.id}>
                                            <TableCell>{p.name}</TableCell>
                                            <TableCell><Chip size="small" label={p.kind} /></TableCell>
                                            <TableCell>{p.x}%, {p.y}%</TableCell>
                                            <TableCell>
                                                {p.exhibitor_id
                                                    ? (exhibitors.find((e) => e.id === p.exhibitor_id)?.company_name || `#${p.exhibitor_id}`)
                                                    : '—'}
                                            </TableCell>
                                            <TableCell align="right">
                                                <IconButton size="small" aria-label={`Edit ${p.name}`}
                                                    onClick={() => {
                                                        setPlaceDraft({ ...p, exhibitor_id: p.exhibitor_id ?? '' });
                                                        setPlaceEditing(p.id); setPlaceDialog(true);
                                                    }}>
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                                <IconButton size="small" aria-label={`Delete ${p.name}`}
                                                    onClick={async () => { await deletePlace(p.id); load(); }}>
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                </CardContent>
            </Card>

            {/* ── Feedback ───────────────────────────────────────────────── */}
            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="h6">Feedback</Typography>
                    <Typography variant="body2" color="textSecondary" gutterBottom>
                        Counts, averages and unattributed comments. Individual responses are
                        private by design — you learn what was said, never who said it.
                    </Typography>
                    {!feedback || !(feedback.summary || []).length
                        ? <Alert severity="info">No ratings yet. Stars appear for attendees once the event is running.</Alert>
                        : (feedback.summary || []).map((row) => (
                            <Box key={row.session_id || 'event'} sx={{ py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                                <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                                    <Typography variant="body1">{row.title}</Typography>
                                    <Box display="flex" alignItems="center" gap={1}>
                                        <Rating value={row.average || 0} precision={0.1} readOnly size="small" />
                                        <Typography variant="body2" color="textSecondary">
                                            {row.average} · {row.count} rating{row.count === 1 ? '' : 's'}
                                        </Typography>
                                    </Box>
                                </Box>
                                {(row.comments || []).map((comment, index) => (
                                    <Typography key={index} variant="body2" color="textSecondary" sx={{ mt: 0.5, fontStyle: 'italic' }}>
                                        “{comment}”
                                    </Typography>
                                ))}
                            </Box>
                        ))}
                </CardContent>
            </Card>

            {/* ── Dialogs ────────────────────────────────────────────────── */}
            <Dialog open={ttDialog} onClose={() => setTtDialog(false)} fullWidth maxWidth="sm">
                <DialogTitle>{ttEditing ? 'Edit pass' : 'Add pass'}</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth margin="normal" label="Canonical code" value={ttDraft.code}
                        onChange={(e) => setTtDraft({ ...ttDraft, code: e.target.value })}
                        helperText="The product/price id from the seller (e.g. a GHL price id). This is what access keys on — it must never change once sold."
                        disabled={Boolean(ttEditing)}
                    />
                    <TextField
                        fullWidth margin="normal" label="Display name" value={ttDraft.name}
                        onChange={(e) => setTtDraft({ ...ttDraft, name: e.target.value })}
                        helperText="What the attendee sees on their ticket. Rename freely."
                    />
                    <TextField
                        fullWidth margin="normal" label="Description" value={ttDraft.description || ''}
                        onChange={(e) => setTtDraft({ ...ttDraft, description: e.target.value })}
                    />
                    <Stack direction="row" spacing={2}>
                        <FormControlLabel
                            control={<Switch checked={Boolean(ttDraft.is_vip)}
                                onChange={(e) => setTtDraft({ ...ttDraft, is_vip: e.target.checked })} />}
                            label="VIP access"
                        />
                        <FormControlLabel
                            control={<Switch checked={Boolean(ttDraft.grants_workshops)}
                                onChange={(e) => setTtDraft({ ...ttDraft, grants_workshops: e.target.checked })} />}
                            label="Workshop access"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setTtDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveTicketType}>Save</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={placeDialog} onClose={() => setPlaceDialog(false)} fullWidth maxWidth="sm">
                <DialogTitle>{placeEditing ? 'Edit place' : 'Add place'}</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth margin="normal" label="Name" value={placeDraft.name}
                        onChange={(e) => setPlaceDraft({ ...placeDraft, name: e.target.value })}
                        helperText='Rooms must match the agenda exactly — a session in "Room 2" finds the place named "Room 2".'
                    />
                    <FormControl fullWidth margin="normal">
                        <InputLabel id="place-kind">Kind</InputLabel>
                        <Select labelId="place-kind" label="Kind" value={placeDraft.kind}
                            onChange={(e) => setPlaceDraft({ ...placeDraft, kind: e.target.value })}>
                            {PLACE_KINDS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                        </Select>
                    </FormControl>
                    <Stack direction="row" spacing={2}>
                        <TextField
                            label="X (% from left)" type="number" fullWidth value={placeDraft.x}
                            onChange={(e) => setPlaceDraft({ ...placeDraft, x: e.target.value })}
                        />
                        <TextField
                            label="Y (% from top)" type="number" fullWidth value={placeDraft.y}
                            onChange={(e) => setPlaceDraft({ ...placeDraft, y: e.target.value })}
                        />
                    </Stack>
                    <FormControl fullWidth margin="normal">
                        <InputLabel id="place-exhibitor">Exhibitor (booths)</InputLabel>
                        <Select labelId="place-exhibitor" label="Exhibitor (booths)"
                            value={placeDraft.exhibitor_id}
                            onChange={(e) => setPlaceDraft({ ...placeDraft, exhibitor_id: e.target.value })}>
                            <MenuItem value="">— none —</MenuItem>
                            {exhibitors.map((ex) => (
                                <MenuItem key={ex.id} value={ex.id}>{ex.company_name}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField
                        fullWidth margin="normal" label="Description" value={placeDraft.description || ''}
                        onChange={(e) => setPlaceDraft({ ...placeDraft, description: e.target.value })}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPlaceDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={savePlace}>Save</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={roleDialog} onClose={() => setRoleDialog(false)} fullWidth maxWidth="sm">
                <DialogTitle>Grant a role at this event</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth margin="normal" label="Email" value={roleDraft.email}
                        onChange={(e) => setRoleDraft({ ...roleDraft, email: e.target.value })}
                    />
                    <FormControl fullWidth margin="normal">
                        <InputLabel id="role-pick">Role</InputLabel>
                        <Select labelId="role-pick" label="Role" value={roleDraft.role}
                            onChange={(e) => setRoleDraft({ ...roleDraft, role: e.target.value })}>
                            {ROLE_OPTIONS.map(([value, label]) => (
                                <MenuItem key={value} value={value}>{label}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField
                        fullWidth margin="normal" label="Full name (new accounts)" value={roleDraft.full_name}
                        onChange={(e) => setRoleDraft({ ...roleDraft, full_name: e.target.value })}
                    />
                    <TextField
                        fullWidth margin="normal" type="password"
                        label="Password (only if this person has no account yet)"
                        value={roleDraft.password}
                        onChange={(e) => setRoleDraft({ ...roleDraft, password: e.target.value })}
                        helperText="At least 10 characters. Ignored for existing accounts."
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRoleDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveRole}>Grant</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default EventSetup;
