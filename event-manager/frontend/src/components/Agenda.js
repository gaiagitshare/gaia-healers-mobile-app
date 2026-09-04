import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Typography, Button, Card, CardContent, Chip, Stack, Tabs, Tab, Divider,
    Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
    Select, InputLabel, FormControl, OutlinedInput, Switch, FormControlLabel,
    IconButton, Alert, CircularProgress, Tooltip,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ImportCsvDialog from './ImportCsvDialog';
import BulkToolbar, { useBulkSelection, SelectAllCheckbox } from './BulkToolbar';
import Checkbox from '@mui/material/Checkbox';
import {
    getEvent, updateEvent, getSessions, createSession, updateSession, deleteSession,
    getSpeakers, createSpeaker, updateSpeaker, deleteSpeaker,
    getSponsors, createSponsor, updateSponsor, deleteSponsor,
    getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
} from '../utils/api';

const SPONSOR_TIERS = ['headline', 'gold', 'silver', 'partner'];
const EMPTY_SPONSOR = { name: '', tier: 'gold', logo_url: '', website: '', blurb: '', sort_order: 0, is_published: true };
const EMPTY_ANNOUNCEMENT = { title: '', body: '', is_pinned: false, is_published: true, scheduled_for: '', audience_type: 'all' };

const SESSION_TYPES = ['talk', 'workshop', 'panel', 'break', 'social'];

const EMPTY_SESSION = {
    title: '', description: '', session_type: 'talk', track: '', room: '',
    start_time: '', end_time: '', capacity: '', sort_order: 0, is_published: false, speaker_ids: [],
    requires_registration: false, needs_workshop_pass: false,
};

const EMPTY_SPEAKER = {
    name: '', role: '', company: '', bio: '', photo_url: '', sort_order: 0, is_published: false,
};

// The API speaks venue-local naive times ("2026-11-20T09:00:00") and the
// datetime-local input wants "2026-11-20T09:00". No timezone maths in either
// direction — the event's timezone says what these times mean.
const toInput = (value) => (value ? String(value).slice(0, 16) : '');
const toApi = (value) => (value ? `${String(value).slice(0, 16)}:00` : null);

const timeLabel = (value) => {
    if (!value) return '—';
    const [, time] = String(value).split('T');
    if (!time) return '—';
    const [hourText, minute] = time.split(':');
    const hour = Number(hourText);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display}:${minute} ${suffix}`;
};

const dayLabel = (isoDate) => {
    const date = new Date(`${isoDate}T00:00:00`);
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

function Agenda({ section }) {
    const { id } = useParams();
    // Section index when the workspace drives which panel shows.
    const SECTION_INDEX = { schedule: 0, speakers: 1, sponsors: 2, updates: 3, live: -1 };
    const navigate = useNavigate();

    const [event, setEvent] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [speakers, setSpeakers] = useState([]);
    const [tab, setTab] = useState(section && SECTION_INDEX[section] >= 0 ? SECTION_INDEX[section] : 0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [sessionDialog, setSessionDialog] = useState(false);
    const [sessionDraft, setSessionDraft] = useState(EMPTY_SESSION);
    const [editingSessionId, setEditingSessionId] = useState(null);

    const [speakerDialog, setSpeakerDialog] = useState(false);
    const [speakerDraft, setSpeakerDraft] = useState(EMPTY_SPEAKER);
    const [editingSpeakerId, setEditingSpeakerId] = useState(null);

    const [sponsors, setSponsors] = useState([]);
    const [sponsorDialog, setSponsorDialog] = useState(false);
    const [sponsorDraft, setSponsorDraft] = useState(EMPTY_SPONSOR);
    const [editingSponsorId, setEditingSponsorId] = useState(null);

    // Which entity the CSV wizard is open for, if any.
    const [importEntity, setImportEntity] = useState(null);
    const [announcements, setAnnouncements] = useState([]);
    const [noteDialog, setNoteDialog] = useState(false);
    const [noteDraft, setNoteDraft] = useState(EMPTY_ANNOUNCEMENT);
    const [editingNoteId, setEditingNoteId] = useState(null);

    const load = useCallback(async () => {
        // Only the first load blanks the screen. Later refreshes keep the tree
        // mounted so in-flight feedback survives.
        setLoading((current) => (event ? current : true));
        try {
            const [eventRes, sessionRes, speakerRes, sponsorRes, noteRes] = await Promise.all([
                getEvent(id), getSessions(id), getSpeakers(id), getSponsors(id), getAnnouncements(id),
            ]);
            setEvent(eventRes.data);
            setSessions(sessionRes.data);
            setSpeakers(speakerRes.data);
            setSponsors(sponsorRes.data);
            setAnnouncements(noteRes.data);
            setError('');
        } catch (err) {
            setError('Could not load the agenda. Check that you are still signed in.');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => { load(); }, [load]);

    const sessionSel = useBulkSelection(sessions);
    const speakerSel = useBulkSelection(speakers);
    const sponsorSel = useBulkSelection(sponsors);
    const noteSel = useBulkSelection(announcements);

    // ---- sessions ----------------------------------------------------------
    const openNewSession = () => {
        setEditingSessionId(null);
        setSessionDraft({
            ...EMPTY_SESSION,
            // Prefill the first day so a new slot lands on the event, not today.
            start_time: event?.start_date ? toInput(event.start_date) : '',
        });
        setSessionDialog(true);
    };

    const openEditSession = (session) => {
        setEditingSessionId(session.id);
        setSessionDraft({
            title: session.title || '',
            description: session.description || '',
            session_type: session.session_type || 'talk',
            track: session.track || '',
            room: session.room || '',
            start_time: toInput(session.start_time),
            end_time: toInput(session.end_time),
            capacity: session.capacity ?? '',
            requires_registration: Boolean(session.requires_registration),
            needs_workshop_pass: Boolean(session.needs_workshop_pass),
            sort_order: session.sort_order ?? 0,
            is_published: Boolean(session.is_published),
            speaker_ids: (session.speakers || []).map((s) => s.id),
        });
        setSessionDialog(true);
    };

    const saveSession = async () => {
        const payload = {
            ...sessionDraft,
            start_time: toApi(sessionDraft.start_time),
            end_time: toApi(sessionDraft.end_time),
            capacity: sessionDraft.capacity === '' ? null : Number(sessionDraft.capacity),
        };
        try {
            if (editingSessionId) await updateSession(editingSessionId, payload);
            else await createSession(id, payload);
            setSessionDialog(false);
            load();
        } catch (err) {
            setError(err?.response?.data?.detail || 'Could not save the session.');
        }
    };

    const removeSession = async (session) => {
        if (!window.confirm(`Delete "${session.title}"?`)) return;
        await deleteSession(session.id);
        load();
    };

    const togglePublished = async (session) => {
        await updateSession(session.id, { is_published: !session.is_published });
        load();
    };

    // ---- speakers ----------------------------------------------------------
    const openNewSpeaker = () => {
        setEditingSpeakerId(null);
        setSpeakerDraft(EMPTY_SPEAKER);
        setSpeakerDialog(true);
    };

    const openEditSpeaker = (speaker) => {
        setEditingSpeakerId(speaker.id);
        setSpeakerDraft({
            name: speaker.name || '', role: speaker.role || '', company: speaker.company || '',
            bio: speaker.bio || '', photo_url: speaker.photo_url || '',
            sort_order: speaker.sort_order ?? 0,
            is_published: Boolean(speaker.is_published),
        });
        setSpeakerDialog(true);
    };

    const saveSpeaker = async () => {
        try {
            if (editingSpeakerId) await updateSpeaker(editingSpeakerId, speakerDraft);
            else await createSpeaker(id, speakerDraft);
            setSpeakerDialog(false);
            load();
        } catch (err) {
            setError(err?.response?.data?.detail || 'Could not save the speaker.');
        }
    };

    const removeSpeaker = async (speaker) => {
        if (!window.confirm(`Delete ${speaker.name}? They will be removed from any sessions.`)) return;
        await deleteSpeaker(speaker.id);
        load();
    };

    // ---- sponsors ----------------------------------------------------------
    const openSponsor = (sponsor) => {
        setEditingSponsorId(sponsor ? sponsor.id : null);
        setSponsorDraft(sponsor ? {
            name: sponsor.name || '', tier: sponsor.tier || 'partner', logo_url: sponsor.logo_url || '',
            website: sponsor.website || '', blurb: sponsor.blurb || '',
            sort_order: sponsor.sort_order ?? 0, is_published: Boolean(sponsor.is_published),
        } : EMPTY_SPONSOR);
        setSponsorDialog(true);
    };

    const saveSponsor = async () => {
        try {
            if (editingSponsorId) await updateSponsor(editingSponsorId, sponsorDraft);
            else await createSponsor(id, sponsorDraft);
            setSponsorDialog(false);
            load();
        } catch (err) {
            setError(err?.response?.data?.detail || 'Could not save the sponsor.');
        }
    };

    const removeSponsor = async (sponsor) => {
        if (!window.confirm(`Remove ${sponsor.name} from the sponsors?`)) return;
        await deleteSponsor(sponsor.id);
        load();
    };

    // ---- announcements -----------------------------------------------------
    const openNote = (note) => {
        setEditingNoteId(note ? note.id : null);
        setNoteDraft(note ? {
            title: note.title || '', body: note.body || '',
            is_pinned: Boolean(note.is_pinned), is_published: Boolean(note.is_published),
            scheduled_for: note.scheduled_for ? String(note.scheduled_for).slice(0, 16) : '',
            audience_type: (note.audience && note.audience.type) ? note.audience.type : 'all',
        } : EMPTY_ANNOUNCEMENT);
        setNoteDialog(true);
    };

    const saveNote = async () => {
        try {
            const { audience_type, ...noteRest } = noteDraft;
            const payload = { ...noteRest, scheduled_for: noteDraft.scheduled_for || null,
                audience: (audience_type && audience_type !== 'all') ? { type: audience_type } : null };
            if (editingNoteId) await updateAnnouncement(editingNoteId, payload);
            else await createAnnouncement(id, payload);
            setNoteDialog(false);
            load();
        } catch (err) {
            setError(err?.response?.data?.detail || 'Could not save the announcement.');
        }
    };

    const removeNote = async (note) => {
        if (!window.confirm(`Delete "${note.title}"?`)) return;
        await deleteAnnouncement(note.id);
        load();
    };

    // ---- live switch -------------------------------------------------------
    const setLive = async (enabled) => {
        try {
            const res = await updateEvent(id, { live_enabled: enabled });
            setEvent(res.data);
        } catch (err) {
            setError('Could not change the live page.');
        }
    };

    const saveLiveMessage = async (message) => {
        try {
            const res = await updateEvent(id, { live_message: message });
            setEvent(res.data);
        } catch (err) {
            setError('Could not save the live message.');
        }
    };

    // ---- grouping ----------------------------------------------------------
    const scheduled = sessions.filter((s) => s.start_time);
    const unscheduled = sessions.filter((s) => !s.start_time);
    const days = [];
    const byDay = {};
    scheduled
        .slice()
        .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
        .forEach((session) => {
            const key = String(session.start_time).slice(0, 10);
            if (!byDay[key]) { byDay[key] = []; days.push(key); }
            byDay[key].push(session);
        });

    if (loading && !event) {
        return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>;
    }

    const publishedCount = sessions.filter((s) => s.is_published).length;

    return (
        <Box>
            {!section && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                    <IconButton onClick={() => navigate(`/events/${id}`)} size="small"><ArrowBackIcon /></IconButton>
                    <Typography variant="h3">Agenda</Typography>
                </Stack>
            )}
            <Typography color="text.secondary" sx={{ mb: 3 }}>
                {event?.name} · times are local to the venue ({event?.timezone || 'UTC'})
                {' · '}{publishedCount} of {sessions.length} sessions published
            </Typography>

            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

            {/* Live page control — the switch an operator flips when doors open. */}
            <Card sx={{ mb: 3, border: (t) => `1px solid ${event?.live_enabled ? t.palette.primary.main : 'transparent'}` }}>
                <CardContent>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ sm: 'center' }}>
                        <Box>
                            <Typography variant="h4">Live page</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {event?.live_enabled
                                    ? 'On — attendees see “happening now”, counts and sponsors in the app.'
                                    : 'Off — the app shows the normal event page. Turn this on when doors open.'}
                            </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                            <FormControlLabel
                                control={<Switch checked={Boolean(event?.live_enabled)} onChange={(e) => setLive(e.target.checked)} />}
                                label={event?.live_enabled ? 'Live' : 'Off'}
                            />
                            <Button
                                variant="outlined"
                                href={`/event/display.html?event=${id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Open venue display
                            </Button>
                        </Stack>
                    </Stack>
                    <TextField
                        fullWidth
                        size="small"
                        sx={{ mt: 2 }}
                        label="Banner message (optional)"
                        placeholder="e.g. Lunch is served in the Exhibit Hall"
                        defaultValue={event?.live_message || ''}
                        onBlur={(e) => saveLiveMessage(e.target.value)}
                        helperText="Saved when you click away. Shows on the app live panel and the venue display."
                    />
                </CardContent>
            </Card>

            {!section && (
            <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ mb: 2 }}>
                <Tab label={`Schedule (${sessions.length})`} />
                <Tab label={`Speakers (${speakers.length})`} />
                <Tab label={`Sponsors (${sponsors.length})`} />
                <Tab label={`Announcements (${announcements.length})`} />
            </Tabs>
            )}

            {tab === 0 && (
                <Box>
                    <Stack direction="row" spacing={1} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
                        <Button variant="contained" startIcon={<AddIcon />} onClick={openNewSession}>
                            Add session
                        </Button>
                        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setImportEntity('sessions')}>
                            Import CSV
                        </Button>
                        {sessions.length > 0 && <SelectAllCheckbox selection={sessionSel} />}
                    </Stack>
                    <BulkToolbar eventId={id} entity="sessions" label="sessions" supportsFeature
                                 selection={sessionSel} onDone={load} />

                    {sessions.length === 0 && (
                        <Alert severity="info">
                            No sessions yet. Add the first one — it stays a draft until you publish it,
                            so nothing appears in the app while you are still building the schedule.
                        </Alert>
                    )}

                    {days.map((day) => (
                        <Box key={day} sx={{ mb: 4 }}>
                            <Typography variant="h4" sx={{ mb: 1 }}>{dayLabel(day)}</Typography>
                            <Divider sx={{ mb: 2 }} />
                            <Stack spacing={1.5}>
                                {byDay[day].map((session) => (
                                    <Card key={session.id}>
                                        <CardContent>
                                            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                                                <Checkbox size="small" sx={{ mt: -1, ml: -1 }}
                                                          checked={sessionSel.isSelected(session.id)}
                                                          onChange={() => sessionSel.toggle(session.id)}
                                                          inputProps={{ 'aria-label': `Select ${session.title}` }} />
                                                <Box sx={{ minWidth: 0, flex: 1 }}>
                                                    <Typography variant="overline" color="text.secondary">
                                                        {timeLabel(session.start_time)} – {timeLabel(session.end_time)}
                                                        {session.room ? ` · ${session.room}` : ''}
                                                    </Typography>
                                                    <Typography variant="h4">{session.title}</Typography>
                                                    <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>
                                                        <Chip size="small" label={session.session_type} />
                                                        {session.track && <Chip size="small" variant="outlined" label={session.track} />}
                                                        {(session.speakers || []).map((s) => (
                                                            <Chip key={s.id} size="small" color="secondary" variant="outlined" label={s.name} />
                                                        ))}
                                                    </Stack>
                                                </Box>
                                                <Stack direction="row" alignItems="center">
                                                    <Tooltip title={session.is_published ? 'Visible in the app' : 'Draft — hidden from the app'}>
                                                        <FormControlLabel
                                                            control={<Switch checked={Boolean(session.is_published)} onChange={() => togglePublished(session)} />}
                                                            label={session.is_published ? 'Live' : 'Draft'}
                                                        />
                                                    </Tooltip>
                                                    <IconButton onClick={() => openEditSession(session)}><EditIcon /></IconButton>
                                                    <IconButton onClick={() => removeSession(session)}><DeleteIcon /></IconButton>
                                                </Stack>
                                            </Stack>
                                        </CardContent>
                                    </Card>
                                ))}
                            </Stack>
                        </Box>
                    ))}

                    {unscheduled.length > 0 && (
                        <Box sx={{ mb: 4 }}>
                            <Typography variant="h4" sx={{ mb: 1 }}>Not scheduled yet</Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                These have no time set, so they never appear in the app.
                            </Typography>
                            <Stack spacing={1.5}>
                                {unscheduled.map((session) => (
                                    <Card key={session.id}>
                                        <CardContent>
                                            <Stack direction="row" justifyContent="space-between" alignItems="center">
                                                <Typography variant="h4">{session.title}</Typography>
                                                <Box>
                                                    <IconButton onClick={() => openEditSession(session)}><EditIcon /></IconButton>
                                                    <IconButton onClick={() => removeSession(session)}><DeleteIcon /></IconButton>
                                                </Box>
                                            </Stack>
                                        </CardContent>
                                    </Card>
                                ))}
                            </Stack>
                        </Box>
                    )}
                </Box>
            )}

            {tab === 1 && (
                <Box>
                    <Stack direction="row" spacing={1} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
                        <Button variant="contained" startIcon={<AddIcon />} onClick={openNewSpeaker}>
                            Add speaker
                        </Button>
                        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setImportEntity('speakers')}>
                            Import CSV
                        </Button>
                        {speakers.length > 0 && <SelectAllCheckbox selection={speakerSel} />}
                    </Stack>
                    <BulkToolbar eventId={id} entity="speakers" label="speakers" supportsFeature
                                 selection={speakerSel} onDone={load} />
                    {speakers.length === 0 && <Alert severity="info">No speakers yet.</Alert>}
                    <Stack spacing={1.5}>
                        {speakers.map((speaker) => (
                            <Card key={speaker.id}>
                                <CardContent>
                                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                                        <Checkbox size="small" sx={{ mt: -1, ml: -1 }}
                                                  checked={speakerSel.isSelected(speaker.id)}
                                                  onChange={() => speakerSel.toggle(speaker.id)}
                                                  inputProps={{ 'aria-label': `Select ${speaker.name}` }} />
                                        <Box sx={{ flex: 1 }}>
                                            <Typography variant="h4">{speaker.name}</Typography>
                                            <Typography color="text.secondary">
                                                {[speaker.role, speaker.company].filter(Boolean).join(' · ')}
                                            </Typography>
                                        </Box>
                                        <Stack direction="row" alignItems="center">
                                            <Chip
                                                size="small"
                                                color={speaker.is_published ? 'primary' : 'default'}
                                                label={speaker.is_published ? 'Live' : 'Draft'}
                                            />
                                            <IconButton onClick={() => openEditSpeaker(speaker)}><EditIcon /></IconButton>
                                            <IconButton onClick={() => removeSpeaker(speaker)}><DeleteIcon /></IconButton>
                                        </Stack>
                                    </Stack>
                                </CardContent>
                            </Card>
                        ))}
                    </Stack>
                </Box>
            )}

            {tab === 2 && (
                <Box>
                    <Stack direction="row" spacing={1} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
                        <Button variant="contained" startIcon={<AddIcon />} onClick={() => openSponsor(null)}>
                            Add sponsor
                        </Button>
                        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setImportEntity('sponsors')}>
                            Import CSV
                        </Button>
                        {sponsors.length > 0 && <SelectAllCheckbox selection={sponsorSel} />}
                    </Stack>
                    <BulkToolbar eventId={id} entity="sponsors" label="sponsors"
                                 selection={sponsorSel} onDone={load} />
                    {sponsors.length === 0 && (
                        <Alert severity="info">
                            No sponsors yet. Tier decides placement — headline sponsors appear first in the
                            app and rotate most often on the venue display.
                        </Alert>
                    )}
                    <Stack spacing={1.5}>
                        {sponsors.map((sponsor) => (
                            <Card key={sponsor.id}>
                                <CardContent>
                                    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                                        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                                            <Checkbox size="small" sx={{ ml: -1 }}
                                                      checked={sponsorSel.isSelected(sponsor.id)}
                                                      onChange={() => sponsorSel.toggle(sponsor.id)}
                                                      inputProps={{ 'aria-label': `Select ${sponsor.name}` }} />
                                            {sponsor.logo_url && (
                                                <Box component="img" src={sponsor.logo_url} alt="" sx={{ maxHeight: 36, maxWidth: 110, objectFit: 'contain' }} />
                                            )}
                                            <Box sx={{ minWidth: 0 }}>
                                                <Typography variant="h4">{sponsor.name}</Typography>
                                                <Chip size="small" label={sponsor.tier} sx={{ mt: 0.5 }} />
                                            </Box>
                                        </Stack>
                                        <Stack direction="row" alignItems="center">
                                            <Chip
                                                size="small"
                                                color={sponsor.is_published ? 'primary' : 'default'}
                                                label={sponsor.is_published ? 'Shown' : 'Hidden'}
                                            />
                                            <IconButton onClick={() => openSponsor(sponsor)}><EditIcon /></IconButton>
                                            <IconButton onClick={() => removeSponsor(sponsor)}><DeleteIcon /></IconButton>
                                        </Stack>
                                    </Stack>
                                </CardContent>
                            </Card>
                        ))}
                    </Stack>
                </Box>
            )}

            {tab === 3 && (
                <Box>
                    <Stack direction="row" spacing={1} sx={{ mb: 3 }} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Button variant="contained" startIcon={<AddIcon />} onClick={() => openNote(null)}>
                            Post announcement
                        </Button>
                        {announcements.length > 0 && <SelectAllCheckbox selection={noteSel} />}
                    </Stack>
                    <BulkToolbar eventId={id} entity="announcements" label="announcements"
                                 selection={noteSel} onDone={load} />
                    {announcements.length === 0 && (
                        <Alert severity="info">
                            Nothing posted. Announcements appear on the app live panel and the venue
                            display within about a minute — room changes, delays, “lunch is served”.
                        </Alert>
                    )}
                    <Stack spacing={1.5}>
                        {announcements.map((note) => (
                            <Card key={note.id}>
                                <CardContent>
                                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                                        <Checkbox size="small" sx={{ mt: -1, ml: -1 }}
                                                  checked={noteSel.isSelected(note.id)}
                                                  onChange={() => noteSel.toggle(note.id)}
                                                  inputProps={{ 'aria-label': `Select ${note.title}` }} />
                                        <Box sx={{ minWidth: 0, flex: 1 }}>
                                            <Typography variant="h4">{note.title}</Typography>
                                            {note.body && <Typography color="text.secondary">{note.body}</Typography>}
                                            <Typography variant="caption" color="text.secondary">
                                                {new Date(note.created_at).toLocaleString()}
                                            </Typography>
                                        </Box>
                                        <Stack direction="row" alignItems="center">
                                            {note.is_pinned && <Chip size="small" color="secondary" label="Pinned" />}
                                            {note.scheduled_for && <Chip size="small" variant="outlined" label="Scheduled" />}
                                            {note.audience && note.audience.type && note.audience.type !== 'all' && <Chip size="small" color="warning" variant="outlined" label={note.audience.type === 'vip' ? 'VIP only' : note.audience.type === 'checked_in' ? 'Checked-in only' : 'Targeted'} />}
                                            <Chip
                                                size="small"
                                                sx={{ ml: 0.5 }}
                                                color={note.is_published ? 'primary' : 'default'}
                                                label={note.is_published ? 'Live' : 'Hidden'}
                                            />
                                            <IconButton onClick={() => openNote(note)}><EditIcon /></IconButton>
                                            <IconButton onClick={() => removeNote(note)}><DeleteIcon /></IconButton>
                                        </Stack>
                                    </Stack>
                                </CardContent>
                            </Card>
                        ))}
                    </Stack>
                </Box>
            )}

            {/* ---- sponsor dialog ---- */}
            <Dialog open={sponsorDialog} onClose={() => setSponsorDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editingSponsorId ? 'Edit sponsor' : 'Add sponsor'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Name" fullWidth required value={sponsorDraft.name}
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, name: e.target.value })}
                        />
                        <TextField
                            select label="Tier" fullWidth value={sponsorDraft.tier}
                            helperText="Headline sponsors appear first and rotate most often on the venue display."
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, tier: e.target.value })}
                        >
                            {SPONSOR_TIERS.map((tier) => <MenuItem key={tier} value={tier}>{tier}</MenuItem>)}
                        </TextField>
                        <TextField
                            label="Logo URL" fullWidth value={sponsorDraft.logo_url}
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, logo_url: e.target.value })}
                        />
                        <TextField
                            label="Website" fullWidth value={sponsorDraft.website}
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, website: e.target.value })}
                        />
                        <TextField
                            label="Blurb" fullWidth multiline rows={2} value={sponsorDraft.blurb}
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, blurb: e.target.value })}
                        />
                        <TextField
                            label="Display order within tier" type="number" fullWidth value={sponsorDraft.sort_order}
                            helperText="Tier decides the group; this orders sponsors inside it."
                            onChange={(e) => setSponsorDraft({ ...sponsorDraft, sort_order: Number(e.target.value) })}
                        />
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={sponsorDraft.is_published}
                                    onChange={(e) => setSponsorDraft({ ...sponsorDraft, is_published: e.target.checked })}
                                />
                            )}
                            label="Show in the app and on the display"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSponsorDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveSponsor} disabled={!sponsorDraft.name.trim()}>Save</Button>
                </DialogActions>
            </Dialog>

            {/* ---- announcement dialog ---- */}
            <Dialog open={noteDialog} onClose={() => setNoteDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editingNoteId ? 'Edit announcement' : 'Post announcement'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Title" fullWidth required value={noteDraft.title}
                            onChange={(e) => setNoteDraft({ ...noteDraft, title: e.target.value })}
                        />
                        <TextField
                            label="Message" fullWidth multiline rows={3} value={noteDraft.body}
                            onChange={(e) => setNoteDraft({ ...noteDraft, body: e.target.value })}
                        />
                        <TextField
                            label="Schedule for (optional)"
                            type="datetime-local"
                            fullWidth
                            value={noteDraft.scheduled_for}
                            onChange={(e) => setNoteDraft({ ...noteDraft, scheduled_for: e.target.value })}
                            InputLabelProps={{ shrink: true }}
                            helperText="Leave empty to post now. If set, it appears in the app at this time."
                        />
                        <FormControl fullWidth>
                            <InputLabel id="aud-label">Who sees this</InputLabel>
                            <Select
                                labelId="aud-label"
                                label="Who sees this"
                                value={noteDraft.audience_type}
                                onChange={(e) => setNoteDraft({ ...noteDraft, audience_type: e.target.value })}
                            >
                                <MenuItem value="all">Everyone</MenuItem>
                                <MenuItem value="vip">VIP ticket holders only</MenuItem>
                                <MenuItem value="checked_in">Checked-in attendees only</MenuItem>
                            </Select>
                        </FormControl>
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={noteDraft.is_pinned}
                                    onChange={(e) => setNoteDraft({ ...noteDraft, is_pinned: e.target.checked })}
                                />
                            )}
                            label="Pin to the top"
                        />
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={noteDraft.is_published}
                                    onChange={(e) => setNoteDraft({ ...noteDraft, is_published: e.target.checked })}
                                />
                            )}
                            label="Show now"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setNoteDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveNote} disabled={!noteDraft.title.trim()}>Save</Button>
                </DialogActions>
            </Dialog>

            <ImportCsvDialog
                open={Boolean(importEntity)}
                entity={importEntity || 'speakers'}
                eventId={id}
                onClose={() => { setImportEntity(null); load(); }}
            />

            {/* ---- session dialog ---- */}
            <Dialog open={sessionDialog} onClose={() => setSessionDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editingSessionId ? 'Edit session' : 'Add session'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Title" fullWidth required value={sessionDraft.title}
                            onChange={(e) => setSessionDraft({ ...sessionDraft, title: e.target.value })}
                        />
                        <TextField
                            label="Description" fullWidth multiline rows={3} value={sessionDraft.description}
                            onChange={(e) => setSessionDraft({ ...sessionDraft, description: e.target.value })}
                        />
                        <Stack direction="row" spacing={2}>
                            <TextField
                                select label="Type" fullWidth value={sessionDraft.session_type}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, session_type: e.target.value })}
                            >
                                {SESSION_TYPES.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                            </TextField>
                            <TextField
                                label="Track" fullWidth value={sessionDraft.track}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, track: e.target.value })}
                            />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField
                                label="Starts" type="datetime-local" fullWidth InputLabelProps={{ shrink: true }}
                                value={sessionDraft.start_time}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, start_time: e.target.value })}
                            />
                            <TextField
                                label="Ends" type="datetime-local" fullWidth InputLabelProps={{ shrink: true }}
                                value={sessionDraft.end_time}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, end_time: e.target.value })}
                            />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField
                                label="Room" fullWidth value={sessionDraft.room}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, room: e.target.value })}
                            />
                            <TextField
                                label="Capacity" type="number" fullWidth value={sessionDraft.capacity}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, capacity: e.target.value })}
                            />
                            <TextField
                                label="Order" type="number" fullWidth value={sessionDraft.sort_order}
                                helperText="Breaks ties when two sessions start together."
                                onChange={(e) => setSessionDraft({ ...sessionDraft, sort_order: Number(e.target.value) })}
                            />
                        </Stack>
                        {/* Registration is per session, never inferred from the type name.
                            Capacity above only takes effect when this is on. */}
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(sessionDraft.requires_registration)}
                                        onChange={(e) => setSessionDraft({ ...sessionDraft, requires_registration: e.target.checked })}
                                    />
                                )}
                                label="Attendees must register (uses Capacity; overflow joins a waitlist)"
                            />
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(sessionDraft.needs_workshop_pass)}
                                        onChange={(e) => setSessionDraft({ ...sessionDraft, needs_workshop_pass: e.target.checked })}
                                    />
                                )}
                                label="Only ticket types with workshop access may register"
                            />
                        </Stack>
                        <FormControl fullWidth>
                            <InputLabel id="speakers-label">Speakers</InputLabel>
                            <Select
                                labelId="speakers-label" multiple value={sessionDraft.speaker_ids}
                                onChange={(e) => setSessionDraft({ ...sessionDraft, speaker_ids: e.target.value })}
                                input={<OutlinedInput label="Speakers" />}
                                renderValue={(selected) => speakers
                                    .filter((s) => selected.includes(s.id))
                                    .map((s) => s.name)
                                    .join(', ')}
                            >
                                {speakers.map((speaker) => (
                                    <MenuItem key={speaker.id} value={speaker.id}>{speaker.name}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={sessionDraft.is_published}
                                    onChange={(e) => setSessionDraft({ ...sessionDraft, is_published: e.target.checked })}
                                />
                            )}
                            label="Publish to the app"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSessionDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveSession} disabled={!sessionDraft.title.trim()}>Save</Button>
                </DialogActions>
            </Dialog>

            {/* ---- speaker dialog ---- */}
            <Dialog open={speakerDialog} onClose={() => setSpeakerDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editingSpeakerId ? 'Edit speaker' : 'Add speaker'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Name" fullWidth required value={speakerDraft.name}
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, name: e.target.value })}
                        />
                        <TextField
                            label="Role" fullWidth value={speakerDraft.role}
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, role: e.target.value })}
                        />
                        <TextField
                            label="Company" fullWidth value={speakerDraft.company}
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, company: e.target.value })}
                        />
                        <TextField
                            label="Bio" fullWidth multiline rows={3} value={speakerDraft.bio}
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, bio: e.target.value })}
                        />
                        <TextField
                            label="Photo URL" fullWidth value={speakerDraft.photo_url}
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, photo_url: e.target.value })}
                        />
                        <TextField
                            label="Display order" type="number" fullWidth value={speakerDraft.sort_order}
                            helperText="Lower numbers appear first."
                            onChange={(e) => setSpeakerDraft({ ...speakerDraft, sort_order: Number(e.target.value) })}
                        />
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={speakerDraft.is_published}
                                    onChange={(e) => setSpeakerDraft({ ...speakerDraft, is_published: e.target.checked })}
                                />
                            )}
                            label="Publish to the app"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSpeakerDialog(false)}>Cancel</Button>
                    <Button variant="contained" onClick={saveSpeaker} disabled={!speakerDraft.name.trim()}>Save</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default Agenda;
