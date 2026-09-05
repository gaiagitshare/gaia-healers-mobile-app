import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box,
    Typography,
    Card,
    CardContent,
    Button,
    Grid,
    Chip,
    TextField,
    Alert,
    Switch,
    FormControlLabel,
} from '@mui/material';
import {
    Edit as EditIcon,
    People as PeopleIcon,
    ContentCopy as ContentCopyIcon,
    Sync as SyncIcon,
    Schedule as ScheduleIcon,
} from '@mui/icons-material';
import Exhibitors from './Exhibitors';
import { getEvent, updateEvent, grabEvent } from '../utils/api';

function EventDetail() {
    const { id } = useParams();
    // NOTE: `section` is accepted so the workspace can route Overview and
    // Exhibitors here, but this component renders the same content either way.
    // Two flags used to be computed for it and never applied; they were dead
    // before this change and removing them alters nothing on screen. Making the
    // Exhibitors tab show only exhibitors would mean restructuring the grid, so
    // it is left alone rather than smuggled into a merge.
    const navigate = useNavigate();
    const [event, setEvent] = useState(null);
    // Only the count, for Event Stats. The exhibitor list itself lives in
    // <Exhibitors>, which owns loading and refreshing it.
    const [exhibitorCount, setExhibitorCount] = useState(0);
    const [editMode, setEditMode] = useState(false);
    // Prefilled from this event's own import source — never a fixed page.
    const [sourceUrl, setSourceUrl] = useState('');
    const [grabStatus, setGrabStatus] = useState(null);
    const [grabbing, setGrabbing] = useState(false);
    // Directory profile — what attendees and other vendors see in the app.



    const registrationLink = `${window.location.origin}/event/register/${id}`;

    useEffect(() => {
        loadEvent();
    }, [id]);

    const loadEvent = async () => {
        try {
            const response = await getEvent(id);
            setEvent(response.data);
            setSourceUrl((current) => current || response.data.source_url || '');
        } catch (error) {
            console.error('Failed to load event:', error);
        }
    };

    // Publishing is the switch that puts an event in front of members, so it is
    // a first-class control rather than something buried in the edit form.
    const setEventFlag = async (field, value) => {
        try {
            const response = await updateEvent(id, { [field]: value });
            setEvent(response.data);
        } catch (error) {
            console.error(`Failed to set ${field}:`, error);
        }
    };

    const handleUpdate = async () => {
        try {
            // The event object came from GET, so it carries locked_fields. Sending
            // it back reads to the backend as "the admin is explicitly resetting
            // the locks", which wipes them and lets the next source sync overwrite
            // whatever was just typed here. This form has no lock control, so it
            // must not claim to set them: leave the key out and let the backend
            // auto-lock the fields that were actually edited.
            const { locked_fields, ...changes } = event;
            await updateEvent(id, changes);
            setEditMode(false);
            loadEvent();
        } catch (error) {
            console.error('Failed to update event:', error);
        }
    };

    const handleGrabEvent = async () => {
        setGrabbing(true);
        setGrabStatus(null);
        try {
            const response = await grabEvent({ event_id: parseInt(id), url: sourceUrl });
            setEvent(response.data);
            setGrabStatus({ severity: 'success', message: 'Event details refreshed from the live page.' });
        } catch (error) {
            setGrabStatus({
                severity: 'error',
                message: error.response?.data?.detail || 'Could not grab the event page.',
            });
        } finally {
            setGrabbing(false);
        }
    };

    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleString();
    };

    const copyToClipboard = (value) => {
        navigator.clipboard?.writeText(value);
    };

    if (!event) {
        return <Typography>Loading...</Typography>;
    }

    return (
        <Box>
            <Box
                display="flex"
                justifyContent="space-between"
                alignItems={{ xs: 'stretch', sm: 'center' }}
                flexDirection={{ xs: 'column', sm: 'row' }}
                gap={1}
                mb={3}
            >
                <Typography variant="h4" sx={{ fontSize: { xs: '1.55rem', sm: '2.125rem' } }}>
                    {event.name}
                </Typography>
                <Box display="flex" gap={1} flexDirection={{ xs: 'column', sm: 'row' }}>
                    <Button
                        variant="outlined"
                        startIcon={<EditIcon />}
                        onClick={() => setEditMode(!editMode)}
                    >
                        {editMode ? 'Cancel' : 'Edit'}
                    </Button>
                    <Button
                        variant="outlined"
                        startIcon={<ScheduleIcon />}
                        onClick={() => navigate(`/events/${id}/agenda`)}
                    >
                        Agenda &amp; Speakers
                    </Button>
                    <Button
                        variant="contained"
                        startIcon={<PeopleIcon />}
                        onClick={() => navigate(`/events/${id}/attendees`)}
                    >
                        Manage Attendees
                    </Button>
                </Box>
            </Box>

            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2} alignItems={{ sm: 'center' }}>
                        <Box>
                            <Typography variant="h6">Visibility</Typography>
                            <Typography variant="body2" color="textSecondary">
                                {event.is_published
                                    ? 'Published — members see this event in the Gaia app.'
                                    : 'Draft — hidden from the Gaia app until you publish it.'}
                            </Typography>
                        </Box>
                        <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(event.is_published)}
                                        onChange={(e) => setEventFlag('is_published', e.target.checked)}
                                    />
                                )}
                                label={event.is_published ? 'Published' : 'Draft'}
                            />
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(event.is_active)}
                                        onChange={(e) => setEventFlag('is_active', e.target.checked)}
                                    />
                                )}
                                label={event.is_active ? 'Active' : 'Archived'}
                            />
                            {/* Attendance figures are commercially sensitive: private by
                                default, shown publicly only when this is deliberately on. */}
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(event.public_counters)}
                                        onChange={(e) => setEventFlag('public_counters', e.target.checked)}
                                    />
                                )}
                                label="Public attendance counters"
                            />
                            {/* The attendee directory. Off means no directory, no
                                connections, nothing — regardless of individual opt-ins. */}
                            <FormControlLabel
                                control={(
                                    <Switch
                                        checked={Boolean(event.networking_enabled)}
                                        onChange={(e) => setEventFlag('networking_enabled', e.target.checked)}
                                    />
                                )}
                                label="Attendee networking"
                            />
                        </Box>
                    </Box>
                    <Alert severity="info" sx={{ mt: 2 }}>
                        Unpublishing removes the event from the app within a minute. Archiving also
                        stops check-in and lead scanning.
                    </Alert>
                </CardContent>
            </Card>

            <Grid container spacing={3}>
                <Grid item xs={12} md={8}>
                    <Card>
                        <CardContent>
                            {grabStatus && (
                                <Alert severity={grabStatus.severity} sx={{ mb: 2 }}>
                                    {grabStatus.message}
                                </Alert>
                            )}
                            {editMode ? (
                                <>
                                    <TextField
                                        fullWidth
                                        label="Event Name"
                                        value={event.name}
                                        onChange={(e) => setEvent({ ...event, name: e.target.value })}
                                        margin="normal"
                                    />
                                    <TextField
                                        fullWidth
                                        label="Description"
                                        value={event.description || ''}
                                        onChange={(e) => setEvent({ ...event, description: e.target.value })}
                                        margin="normal"
                                        multiline
                                        rows={3}
                                    />
                                    <TextField
                                        fullWidth
                                        label="Location"
                                        value={event.location || ''}
                                        onChange={(e) => setEvent({ ...event, location: e.target.value })}
                                        margin="normal"
                                    />
                                    <Box display="flex" gap={2} flexDirection={{ xs: 'column', sm: 'row' }}>
                                        <TextField
                                            fullWidth
                                            label="Starts"
                                            type="datetime-local"
                                            InputLabelProps={{ shrink: true }}
                                            value={(event.start_date || '').slice(0, 16)}
                                            onChange={(e) => setEvent({ ...event, start_date: e.target.value ? `${e.target.value}:00` : null })}
                                            margin="normal"
                                        />
                                        <TextField
                                            fullWidth
                                            label="Ends"
                                            type="datetime-local"
                                            InputLabelProps={{ shrink: true }}
                                            value={(event.end_date || '').slice(0, 16)}
                                            onChange={(e) => setEvent({ ...event, end_date: e.target.value ? `${e.target.value}:00` : null })}
                                            margin="normal"
                                        />
                                    </Box>
                                    <TextField
                                        fullWidth
                                        label="Timezone (IANA)"
                                        placeholder="e.g. America/New_York"
                                        value={event.timezone || ''}
                                        onChange={(e) => setEvent({ ...event, timezone: e.target.value })}
                                        margin="normal"
                                        helperText="All session times are local to this zone. The app counts down against it."
                                    />
                                    <TextField
                                        fullWidth
                                        label="Hero image URL"
                                        value={event.hero_image_url || ''}
                                        onChange={(e) => setEvent({ ...event, hero_image_url: e.target.value })}
                                        margin="normal"
                                        helperText="Shown at the top of this event in the Gaia app."
                                    />
                                    <TextField
                                        fullWidth
                                        label="Venue map image URL"
                                        value={event.map_image_url || ''}
                                        onChange={(e) => setEvent({ ...event, map_image_url: e.target.value })}
                                        margin="normal"
                                        helperText="The floor plan the app's Map tab pins sit on. Leave empty to hide the Map tab."
                                    />
                                    <Box mt={3} p={2} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                                        <Typography variant="h4" gutterBottom>Registration</Typography>
                                        <TextField
                                            fullWidth
                                            label="Registration / ticket URL"
                                            placeholder="https://…"
                                            value={event.registration_url || ''}
                                            onChange={(e) => setEvent({ ...event, registration_url: e.target.value })}
                                            margin="normal"
                                            helperText="Where the app's button sends someone to buy or register. This is NOT the import source below."
                                        />
                                        <TextField
                                            fullWidth
                                            label="Button label"
                                            placeholder="Buy Ticket"
                                            value={event.registration_label || ''}
                                            onChange={(e) => setEvent({ ...event, registration_label: e.target.value })}
                                            margin="normal"
                                            helperText='e.g. "Buy Ticket", "Register", "Request invite". Defaults to Buy ticket.'
                                        />
                                        <TextField
                                            fullWidth
                                            label="Import source URL (sync only)"
                                            value={event.source_url || ''}
                                            onChange={(e) => setEvent({ ...event, source_url: e.target.value })}
                                            margin="normal"
                                            helperText="The page this event's details are imported from. Never used as the buy link."
                                        />
                                    </Box>
                                    <Box mt={2}>
                                        <Button variant="contained" onClick={handleUpdate}>
                                            Save Changes
                                        </Button>
                                    </Box>
                                </>
                            ) : (
                                <>
                                    <Typography variant="body1" paragraph>
                                        {event.description || 'No description'}
                                    </Typography>
                                    <Typography variant="body2" color="textSecondary">
                                        <strong>Location:</strong> {event.location || 'Not specified'}
                                    </Typography>
                                    <Typography variant="body2" color="textSecondary">
                                        <strong>Start:</strong> {formatDate(event.start_date)}
                                    </Typography>
                                    <Typography variant="body2" color="textSecondary">
                                        <strong>End:</strong> {formatDate(event.end_date)}
                                    </Typography>
                                    <Box mt={2}>
                                        <Chip
                                            label={event.is_active ? 'Active' : 'Inactive'}
                                            color={event.is_active ? 'success' : 'default'}
                                        />
                                    </Box>
                                    <Box display="flex" gap={1} mt={3} flexDirection={{ xs: 'column', sm: 'row' }}>
                                        <TextField
                                            fullWidth
                                            size="small"
                                            label="Live event page"
                                            value={sourceUrl}
                                            onChange={(e) => setSourceUrl(e.target.value)}
                                        />
                                        <Button
                                            variant="outlined"
                                            startIcon={<SyncIcon />}
                                            onClick={handleGrabEvent}
                                            disabled={grabbing}
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            {grabbing ? 'Grabbing...' : 'Grab Live Page'}
                                        </Button>
                                    </Box>
                                </>
                            )}
                        </CardContent>
                    </Card>

                    {/* One place for exhibitors: the roster, the commercial board,
                        the permissions and the setup links. This used to be split
                        across here and a separate Vendors screen over the same rows. */}
                    <Box mt={3}>
                        <Exhibitors eventId={id} onCountChange={setExhibitorCount} />
                    </Box>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Card>
                        <CardContent>
                            <Typography variant="h6" gutterBottom>
                                Event Stats
                            </Typography>
                            <Typography variant="body1">
                                <strong>{event.attendee_count}</strong> Registered
                            </Typography>
                            <Typography variant="body1">
                                <strong>{event.checked_in_count}</strong> Checked In
                            </Typography>
                            <Typography variant="body1">
                                <strong>{exhibitorCount}</strong> Exhibitors
                            </Typography>
                        </CardContent>
                    </Card>

                    <Card sx={{ mt: 2 }}>
                        <CardContent>
                            <Typography variant="h6" gutterBottom>
                                Public Registration Link
                            </Typography>
                            <Typography variant="body2" color="textSecondary" paragraph>
                                Share this link for attendees to self-register:
                            </Typography>
                            <TextField
                                fullWidth
                                value={registrationLink}
                                InputProps={{ readOnly: true }}
                                size="small"
                            />
                            <Button
                                variant="outlined"
                                size="small"
                                startIcon={<ContentCopyIcon />}
                                onClick={() => copyToClipboard(registrationLink)}
                                sx={{ mt: 1 }}
                            >
                                Copy Link
                            </Button>
                        </CardContent>
                    </Card>
                </Grid>
            </Grid>

        </Box>
    );
}

export default EventDetail;
