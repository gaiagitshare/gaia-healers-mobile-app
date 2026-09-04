import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box,
    Typography,
    Button,
    Card,
    CardContent,
    Grid,
    IconButton,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Chip,
} from '@mui/material';
import {
    Add as AddIcon,
    Edit as EditIcon,
    Delete as DeleteIcon,
    Visibility as ViewIcon,
    ContentCopy as DuplicateIcon,
} from '@mui/icons-material';
import { getEvents, createEvent, deleteEvent, duplicateEvent } from '../utils/api';

function Events() {
    const navigate = useNavigate();
    const [events, setEvents] = useState([]);
    const [openDialog, setOpenDialog] = useState(false);
    const [newEvent, setNewEvent] = useState({
        name: '',
        description: '',
        location: '',
        start_date: '',
        end_date: '',
    });

    useEffect(() => {
        loadEvents();
    }, []);

    const loadEvents = async () => {
        try {
            const response = await getEvents();
            setEvents(response.data);
        } catch (error) {
            console.error('Failed to load events:', error);
        }
    };

    // Event times are venue-local and are stored naive, paired with the event's
    // own timezone. Running them through Date().toISOString() would shift them by
    // whatever offset the operator's browser happens to be on, so an event typed
    // as 09:00 in Reykjavik would land as 05:00. The datetime-local value is
    // already the venue-local wall clock — send it as typed.
    const handleCreate = async () => {
        try {
            const asVenueLocal = (value) => (value ? `${value.slice(0, 16)}:00` : null);
            await createEvent({
                ...newEvent,
                start_date: asVenueLocal(newEvent.start_date),
                end_date: asVenueLocal(newEvent.end_date),
            });
            setOpenDialog(false);
            setNewEvent({ name: '', description: '', location: '', start_date: '', end_date: '' });
            loadEvents();
        } catch (error) {
            console.error('Failed to create event:', error);
        }
    };

    const handleDuplicate = async (eventId) => {
        try {
            const res = await duplicateEvent(eventId);
            await loadEvents();
            if (res?.data?.id) navigate(`/events/${res.data.id}`);
        } catch (e) {
            // Non-fatal: the list simply does not change.
        }
    };

    const handleDelete = async (id) => {
        if (window.confirm('Are you sure you want to delete this event?')) {
            try {
                await deleteEvent(id);
                loadEvents();
            } catch (error) {
                console.error('Failed to delete event:', error);
            }
        }
    };

    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleDateString();
    };

    return (
        <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                <Typography variant="h4">Events</Typography>
                <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => setOpenDialog(true)}
                >
                    Create Event
                </Button>
            </Box>

            {(() => {
                // A past event is a historical record: it stays visible and
                // clickable, it just cannot be mutated. Archived (read-only) or
                // already finished counts as past; everything else is current.
                const now = new Date();
                const isPast = (e) => Boolean(e.is_archived) || (e.end_date && new Date(e.end_date) < now);
                const current = events.filter((e) => !isPast(e));
                const past = events.filter(isPast);

                const renderEventCard = (event) => {
                    const archived = Boolean(event.is_archived);
                    const wasPast = isPast(event);
                    return (
                        <Grid item xs={12} md={6} lg={4} key={event.id}>
                            <Card sx={archived ? { borderLeft: '3px solid', borderColor: 'warning.main' } : undefined}>
                                <CardContent>
                                    <Box display="flex" justifyContent="space-between" alignItems="start">
                                        <Typography variant="h6" gutterBottom>
                                            {event.name}
                                        </Typography>
                                        <Chip
                                            size="small"
                                            label={archived ? 'Past - Archived' : (wasPast ? 'Past' : (event.is_active ? 'Active' : 'Inactive'))}
                                            color={archived ? 'warning' : (event.is_active && !wasPast ? 'success' : 'default')}
                                        />
                                    </Box>
                                    <Typography color="textSecondary" gutterBottom>
                                        {formatDate(event.start_date)} - {formatDate(event.end_date)}
                                    </Typography>
                                    <Typography variant="body2" gutterBottom>
                                        {event.location}
                                    </Typography>
                                    <Box mt={2} display="flex" gap={2}>
                                        <Typography variant="body2">
                                            <strong>{event.attendee_count}</strong> Attendees
                                        </Typography>
                                        <Typography variant="body2">
                                            <strong>{event.checked_in_count}</strong> Checked In
                                        </Typography>
                                    </Box>
                                    {archived && (
                                        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>
                                            Read-only historical record. Attendees and purchase history stay viewable; no
                                            check-in, import, reconciler or webhook write can alter this event.
                                        </Typography>
                                    )}
                                    <Box mt={2} display="flex" justifyContent="flex-end" gap={1}>
                                        <IconButton size="small" title="View event" onClick={() => navigate(`/events/${event.id}`)}>
                                            <ViewIcon />
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            title={archived ? 'View historical attendees (read-only)' : 'Manage attendees'}
                                            onClick={() => navigate(`/events/${event.id}/attendees`)}
                                        >
                                            <EditIcon />
                                        </IconButton>
                                        <IconButton size="small" title="Duplicate as a new draft" onClick={() => handleDuplicate(event.id)}>
                                            <DuplicateIcon />
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            color="error"
                                            disabled={archived}
                                            title={archived ? 'Archived events cannot be deleted' : 'Delete event'}
                                            onClick={() => { if (!archived) handleDelete(event.id); }}
                                        >
                                            <DeleteIcon />
                                        </IconButton>
                                    </Box>
                                </CardContent>
                            </Card>
                        </Grid>
                    );
                };

                return (
                    <Box>
                        <Typography variant="subtitle2" sx={{ mt: 1, mb: 1, opacity: 0.7, letterSpacing: '.08em' }}>
                            UPCOMING / CURRENT
                        </Typography>
                        <Grid container spacing={3}>
                            {current.length > 0 ? current.map(renderEventCard) : (
                                <Grid item xs={12}>
                                    <Typography variant="body2" color="textSecondary">No current events.</Typography>
                                </Grid>
                            )}
                        </Grid>
                        {past.length > 0 && (
                            <Box>
                                <Typography variant="subtitle2" sx={{ mt: 4, mb: 1, opacity: 0.7, letterSpacing: '.08em' }}>
                                    PAST EVENTS
                                </Typography>
                                <Grid container spacing={3}>
                                    {past.map(renderEventCard)}
                                </Grid>
                            </Box>
                        )}
                    </Box>
                );
            })()}

            <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Create New Event</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth
                        label="Event Name"
                        value={newEvent.name}
                        onChange={(e) => setNewEvent({ ...newEvent, name: e.target.value })}
                        margin="normal"
                        required
                    />
                    <TextField
                        fullWidth
                        label="Description"
                        value={newEvent.description}
                        onChange={(e) => setNewEvent({ ...newEvent, description: e.target.value })}
                        margin="normal"
                        multiline
                        rows={2}
                    />
                    <TextField
                        fullWidth
                        label="Location"
                        value={newEvent.location}
                        onChange={(e) => setNewEvent({ ...newEvent, location: e.target.value })}
                        margin="normal"
                    />
                    <TextField
                        fullWidth
                        label="Start Date"
                        type="datetime-local"
                        value={newEvent.start_date}
                        onChange={(e) => setNewEvent({ ...newEvent, start_date: e.target.value })}
                        margin="normal"
                        InputLabelProps={{ shrink: true }}
                        required
                    />
                    <TextField
                        fullWidth
                        label="End Date"
                        type="datetime-local"
                        value={newEvent.end_date}
                        onChange={(e) => setNewEvent({ ...newEvent, end_date: e.target.value })}
                        margin="normal"
                        InputLabelProps={{ shrink: true }}
                        required
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
                    <Button onClick={handleCreate} variant="contained">Create</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default Events;
