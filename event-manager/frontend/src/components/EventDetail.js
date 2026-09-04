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
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    List,
    ListItem,
    ListItemText,
    IconButton,
    Alert,
    Switch,
    FormControlLabel,
} from '@mui/material';
import {
    Edit as EditIcon,
    People as PeopleIcon,
    Business as BusinessIcon,
    Add as AddIcon,
    ContentCopy as ContentCopyIcon,
    Sync as SyncIcon,
    Schedule as ScheduleIcon,
    Storefront as StorefrontIcon,
    Delete as DeleteIcon,
    UploadFile as UploadFileIcon,
} from '@mui/icons-material';
import ImportCsvDialog from './ImportCsvDialog';
import BulkToolbar, { useBulkSelection, SelectAllCheckbox } from './BulkToolbar';
import Checkbox from '@mui/material/Checkbox';
import { getEvent, updateEvent, getExhibitors, createExhibitor, updateExhibitor, deleteExhibitor, getExhibitorLeads, grabEvent } from '../utils/api';

function EventDetail({ section }) {
    const { id } = useParams();
    const showOverview = section !== 'exhibitors';
    const showExhibitors = !section || section === 'exhibitors';
    const navigate = useNavigate();
    const [event, setEvent] = useState(null);
    const [exhibitors, setExhibitors] = useState([]);
    const [editMode, setEditMode] = useState(false);
    const [openExhibitorDialog, setOpenExhibitorDialog] = useState(false);
    const [selectedExhibitor, setSelectedExhibitor] = useState(null);
    const [exhibitorLeads, setExhibitorLeads] = useState([]);
    // Prefilled from this event's own import source — never a fixed page.
    const [sourceUrl, setSourceUrl] = useState('');
    const [grabStatus, setGrabStatus] = useState(null);
    const [grabbing, setGrabbing] = useState(false);
    const [newExhibitor, setNewExhibitor] = useState({
        company_name: '',
        booth_number: '',
        contact_email: '',
        contact_phone: '',
        category: '',
        // Listed in the app directory straight away — an operator adding a vendor
        // wants attendees to find it, not to hunt for a second toggle afterwards.
        is_published: true,
    });
    // Directory profile — what attendees and other vendors see in the app.
    const [importOpen, setImportOpen] = useState(false);
    const exhibitorSel = useBulkSelection(exhibitors);
    const [profileExhibitor, setProfileExhibitor] = useState(null);
    const [profileDraft, setProfileDraft] = useState({
        booth_number: '', category: '', website: '', logo_url: '', description: '', sort_order: 0, is_published: false,
    });

    const openProfile = (exhibitor) => {
        setProfileExhibitor(exhibitor);
        setProfileDraft({
            booth_number: exhibitor.booth_number || '',
            category: exhibitor.category || '',
            website: exhibitor.website || '',
            logo_url: exhibitor.logo_url || '',
            description: exhibitor.description || '',
            sort_order: exhibitor.sort_order ?? 0,
            is_published: Boolean(exhibitor.is_published),
        });
    };

    const saveProfile = async () => {
        try {
            await updateExhibitor(profileExhibitor.id, profileDraft);
            setProfileExhibitor(null);
            loadExhibitors();
        } catch (error) {
            console.error('Failed to save exhibitor profile:', error);
        }
    };

    const registrationLink = `${window.location.origin}/event/register/${id}`;

    useEffect(() => {
        loadEvent();
        loadExhibitors();
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

    const loadExhibitors = async () => {
        try {
            const response = await getExhibitors(id);
            setExhibitors(response.data);
        } catch (error) {
            console.error('Failed to load exhibitors:', error);
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

    const handleDeleteExhibitor = async (exhibitor) => {
        if (!window.confirm(`Delete ${exhibitor.company_name}? Their captured leads are deleted too.`)) return;
        try {
            await deleteExhibitor(exhibitor.id);
            loadExhibitors();
        } catch (error) {
            console.error('Failed to delete exhibitor:', error);
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

    const handleCreateExhibitor = async () => {
        try {
            const response = await createExhibitor({
                ...newExhibitor,
                event_id: parseInt(id),
            });
            
            // Show the access token
            alert(`Exhibitor created!\n\nAccess Link:\n${window.location.origin}/event/scan/${response.data.access_token}`);
            
            setOpenExhibitorDialog(false);
            setNewExhibitor({ company_name: '', booth_number: '', contact_email: '', contact_phone: '', category: '', is_published: true });
            loadExhibitors();
        } catch (error) {
            console.error('Failed to create exhibitor:', error);
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

    const viewExhibitorLeads = async (exhibitor) => {
        try {
            const response = await getExhibitorLeads(exhibitor.id);
            setExhibitorLeads(response.data);
            setSelectedExhibitor(exhibitor);
        } catch (error) {
            console.error('Failed to load leads:', error);
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

                    <Box mt={3}>
                        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                            <Typography variant="h6">
                                <BusinessIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
                                Exhibitors
                            </Typography>
                            <Box display="flex" gap={1} flexWrap="wrap">
                                <Button
                                    variant="outlined"
                                    size="small"
                                    startIcon={<AddIcon />}
                                    onClick={() => setOpenExhibitorDialog(true)}
                                >
                                    Add Exhibitor
                                </Button>
                                <Button
                                    variant="outlined"
                                    size="small"
                                    startIcon={<UploadFileIcon />}
                                    onClick={() => setImportOpen(true)}
                                >
                                    Import CSV
                                </Button>
                                {exhibitors.length > 0 && <SelectAllCheckbox selection={exhibitorSel} />}
                            </Box>
                        </Box>

                        <BulkToolbar eventId={id} entity="exhibitors" label="exhibitors"
                                     selection={exhibitorSel} onDone={loadExhibitors} />

                        {exhibitors.map((exhibitor) => (
                            <Card key={exhibitor.id} sx={{ mb: 2 }}>
                                <CardContent>
                                    <Box display="flex" justifyContent="space-between" alignItems="start">
                                        <Box display="flex" alignItems="flex-start" gap={0.5}>
                                            <Checkbox size="small" sx={{ mt: -0.5, ml: -1 }}
                                                      checked={exhibitorSel.isSelected(exhibitor.id)}
                                                      onChange={() => exhibitorSel.toggle(exhibitor.id)}
                                                      inputProps={{ 'aria-label': `Select ${exhibitor.company_name}` }} />
                                        <Box>
                                            <Box display="flex" alignItems="center" gap={1}>
                                                <Typography variant="h6">{exhibitor.company_name}</Typography>
                                                <Chip
                                                    size="small"
                                                    color={exhibitor.is_published ? 'primary' : 'default'}
                                                    label={exhibitor.is_published ? 'In directory' : 'Not listed'}
                                                />
                                                {/* Scanning is sold and granted, never implied by the
                                                    token existing. Off = their scanner link is inert. */}
                                                <Chip
                                                    size="small"
                                                    clickable
                                                    color={exhibitor.can_scan_leads ? 'success' : 'default'}
                                                    label={exhibitor.can_scan_leads ? 'Lead scanning ON' : 'Lead scanning off'}
                                                    onClick={async () => {
                                                        await updateExhibitor(exhibitor.id, { can_scan_leads: !exhibitor.can_scan_leads });
                                                        loadExhibitors();
                                                    }}
                                                />
                                            </Box>
                                            <Typography variant="body2" color="textSecondary">
                                                Booth: {exhibitor.booth_number || 'N/A'}
                                                {exhibitor.category ? ` · ${exhibitor.category}` : ''}
                                            </Typography>
                                            <Typography variant="body2">
                                                {exhibitor.contact_email}
                                            </Typography>
                                            <TextField
                                                fullWidth
                                                size="small"
                                                value={`${window.location.origin}/event/scan/${exhibitor.access_token}`}
                                                InputProps={{ readOnly: true }}
                                                sx={{ mt: 1, maxWidth: 520 }}
                                            />
                                        </Box>
                                        <Box>
                                            <IconButton
                                                size="small"
                                                onClick={() => copyToClipboard(`${window.location.origin}/event/scan/${exhibitor.access_token}`)}
                                            >
                                                <ContentCopyIcon fontSize="small" />
                                            </IconButton>
                                            <Button
                                                size="small"
                                                startIcon={<StorefrontIcon fontSize="small" />}
                                                onClick={() => openProfile(exhibitor)}
                                            >
                                                Profile
                                            </Button>
                                            <Button
                                                size="small"
                                                onClick={() => viewExhibitorLeads(exhibitor)}
                                            >
                                                {exhibitor.lead_count || 0} Leads
                                            </Button>
                                            <Button
                                                size="small"
                                                onClick={async () => {
                                                    await updateExhibitor(exhibitor.id, { is_published: !exhibitor.is_published });
                                                    loadExhibitors();
                                                }}
                                            >
                                                {exhibitor.is_published ? 'Unlist' : 'List'}
                                            </Button>
                                            <IconButton
                                                size="small"
                                                aria-label={`Delete ${exhibitor.company_name}`}
                                                onClick={() => handleDeleteExhibitor(exhibitor)}
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </Box>
                                        </Box>
                                    </Box>
                                </CardContent>
                            </Card>
                        ))}
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
                                <strong>{exhibitors.length}</strong> Exhibitors
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

            {/* Add Exhibitor Dialog */}
            <Dialog open={openExhibitorDialog} onClose={() => setOpenExhibitorDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Add Exhibitor</DialogTitle>
                <DialogContent>
                    <TextField
                        fullWidth
                        label="Company Name"
                        value={newExhibitor.company_name}
                        onChange={(e) => setNewExhibitor({ ...newExhibitor, company_name: e.target.value })}
                        margin="normal"
                        required
                    />
                    <TextField
                        fullWidth
                        label="Booth Number"
                        value={newExhibitor.booth_number}
                        onChange={(e) => setNewExhibitor({ ...newExhibitor, booth_number: e.target.value })}
                        margin="normal"
                    />
                    <TextField
                        fullWidth
                        label="Contact Email"
                        type="email"
                        value={newExhibitor.contact_email}
                        onChange={(e) => setNewExhibitor({ ...newExhibitor, contact_email: e.target.value })}
                        margin="normal"
                        required
                    />
                    <TextField
                        fullWidth
                        label="Contact Phone"
                        value={newExhibitor.contact_phone}
                        onChange={(e) => setNewExhibitor({ ...newExhibitor, contact_phone: e.target.value })}
                        margin="normal"
                    />
                    <TextField
                        fullWidth
                        label="Category"
                        placeholder="e.g. Devices, Education"
                        value={newExhibitor.category}
                        onChange={(e) => setNewExhibitor({ ...newExhibitor, category: e.target.value })}
                        margin="normal"
                    />
                    <FormControlLabel
                        sx={{ mt: 1 }}
                        control={(
                            <Switch
                                checked={newExhibitor.is_published}
                                onChange={(e) => setNewExhibitor({ ...newExhibitor, is_published: e.target.checked })}
                            />
                        )}
                        label="List in the app directory"
                    />
                    <Alert severity="info" sx={{ mt: 1 }}>
                        Listed vendors appear in the app within a minute. Contact email and
                        phone are never shown — only name, booth, category, description,
                        logo and website.
                    </Alert>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenExhibitorDialog(false)}>Cancel</Button>
                    <Button onClick={handleCreateExhibitor} variant="contained">Add</Button>
                </DialogActions>
            </Dialog>

            <ImportCsvDialog
                open={importOpen}
                entity="exhibitors"
                eventId={id}
                onClose={() => { setImportOpen(false); loadExhibitors(); }}
            />

            {/* Exhibitor directory profile — shown to attendees and other vendors.
                Contact email/phone stay internal and are never published. */}
            <Dialog
                open={Boolean(profileExhibitor)}
                onClose={() => setProfileExhibitor(null)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Directory profile — {profileExhibitor?.company_name}</DialogTitle>
                <DialogContent>
                    <Box display="flex" flexDirection="column" gap={2} mt={1}>
                        <Box display="flex" gap={2}>
                            <TextField
                                label="Booth number"
                                fullWidth
                                value={profileDraft.booth_number}
                                onChange={(e) => setProfileDraft({ ...profileDraft, booth_number: e.target.value })}
                            />
                            <TextField
                                label="Category"
                                fullWidth
                                placeholder="e.g. Devices, Education"
                                value={profileDraft.category}
                                onChange={(e) => setProfileDraft({ ...profileDraft, category: e.target.value })}
                            />
                        </Box>
                        <TextField
                            label="Website"
                            fullWidth
                            value={profileDraft.website}
                            onChange={(e) => setProfileDraft({ ...profileDraft, website: e.target.value })}
                        />
                        <TextField
                            label="Logo URL"
                            fullWidth
                            value={profileDraft.logo_url}
                            onChange={(e) => setProfileDraft({ ...profileDraft, logo_url: e.target.value })}
                        />
                        <TextField
                            label="Description"
                            fullWidth
                            multiline
                            rows={4}
                            value={profileDraft.description}
                            onChange={(e) => setProfileDraft({ ...profileDraft, description: e.target.value })}
                        />
                        <TextField
                            label="Display order"
                            type="number"
                            fullWidth
                            value={profileDraft.sort_order ?? 0}
                            onChange={(e) => setProfileDraft({ ...profileDraft, sort_order: Number(e.target.value) })}
                            helperText="Lower numbers appear first in the app directory."
                        />
                        <FormControlLabel
                            control={(
                                <Switch
                                    checked={profileDraft.is_published}
                                    onChange={(e) => setProfileDraft({ ...profileDraft, is_published: e.target.checked })}
                                />
                            )}
                            label="List in the app directory"
                        />
                        <Alert severity="info">
                            Contact email and phone stay with the organisers. Only the fields above
                            are visible to attendees and other exhibitors.
                        </Alert>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setProfileExhibitor(null)}>Cancel</Button>
                    <Button onClick={saveProfile} variant="contained">Save</Button>
                </DialogActions>
            </Dialog>

            {/* Exhibitor Leads Dialog */}
            <Dialog
                open={Boolean(selectedExhibitor)}
                onClose={() => setSelectedExhibitor(null)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>
                    Leads for {selectedExhibitor?.company_name}
                </DialogTitle>
                <DialogContent>
                    <List>
                        {exhibitorLeads.map((lead) => (
                            <ListItem key={lead.id}>
                                <ListItemText
                                    primary={`${lead.attendee?.first_name} ${lead.attendee?.last_name}`}
                                    secondary={
                                        <>
                                            <Typography variant="body2" component="span">
                                                {lead.attendee?.company}
                                            </Typography>
                                            <br />
                                            <Typography variant="caption" color="textSecondary">
                                                Scanned: {new Date(lead.scanned_at).toLocaleString()}
                                            </Typography>
                                        </>
                                    }
                                />
                            </ListItem>
                        ))}
                    </List>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSelectedExhibitor(null)}>Close</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default EventDetail;
