import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert,
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Container,
    Grid,
    MenuItem,
    Paper,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import {
    EventAvailable as EventAvailableIcon,
    LocationOn as LocationIcon,
    QrCode2 as QrCodeIcon,
} from '@mui/icons-material';
import { QRCodeSVG } from 'qrcode.react';
import { getPublicEvent, publicRegister } from '../utils/api';

const initialForm = {
    first_name: '',
    last_name: '',
    email: '',
    company: '',
    job_title: '',
    phone: '',
    pass_type: 'General Admission',
    interests: '',
};

function PublicRegistration() {
    const { eventId } = useParams();
    const [event, setEvent] = useState(null);
    const [form, setForm] = useState(initialForm);
    const [attendee, setAttendee] = useState(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        loadEvent();
    }, [eventId]);

    const loadEvent = async () => {
        setLoading(true);
        setError('');
        try {
            const response = await getPublicEvent(eventId);
            setEvent(response.data);
        } catch (err) {
            setError(err.response?.data?.detail || 'Registration is not available for this event.');
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (field) => (e) => {
        setForm({ ...form, [field]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        setError('');

        try {
            const { pass_type, interests, ...attendeeFields } = form;
            const response = await publicRegister({
                ...attendeeFields,
                event_id: parseInt(eventId, 10),
                custom_data: {
                    pass_type,
                    interests,
                    source: 'public_registration',
                    paid_member: false,
                },
            });
            setAttendee(response.data);
            setForm(initialForm);
        } catch (err) {
            setError(err.response?.data?.detail || 'Registration failed. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    const formatDate = (value) => new Date(value).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

    const accessOptions = event?.custom_fields?.find((field) => field.name === 'pass_type')?.options || [
        'VIP Pass',
        'Three Day Event Pass',
        'Workshop Access',
        'General Admission + Conference',
        'General Admission',
        'Guest/Partner',
    ];

    if (loading) {
        return (
            <Box minHeight="100vh" display="flex" alignItems="center" justifyContent="center">
                <CircularProgress />
            </Box>
        );
    }

    return (
        <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f0', py: { xs: 2, md: 6 } }}>
            <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3 } }}>
                <Grid container spacing={3} alignItems="stretch">
                    <Grid item xs={12} md={5}>
                        <Paper
                            elevation={0}
                            sx={{
                                height: '100%',
                                p: { xs: 2.5, md: 4 },
                                bgcolor: 'primary.main',
                                color: 'white',
                                borderRadius: 2,
                            }}
                        >
                            <Stack spacing={3}>
                                <Box>
                                    <Chip
                                        label="Free event registration"
                                        sx={{ bgcolor: 'rgba(255,255,255,0.16)', color: 'white', mb: 2 }}
                                    />
                                    <Typography
                                        variant="h3"
                                        component="h1"
                                        sx={{ fontWeight: 700, fontSize: { xs: '1.65rem', sm: '2.35rem', md: '3rem' } }}
                                    >
                                        {event?.name || 'Event Registration'}
                                    </Typography>
                                </Box>

                                {event?.description && (
                                    <Typography
                                        variant="body1"
                                        sx={{
                                            opacity: 0.9,
                                            fontSize: { xs: '0.95rem', sm: '1rem' },
                                            display: '-webkit-box',
                                            WebkitLineClamp: { xs: 8, sm: 'unset' },
                                            WebkitBoxOrient: 'vertical',
                                            overflow: 'hidden',
                                        }}
                                    >
                                        {event.description}
                                    </Typography>
                                )}

                                <Stack spacing={1.5}>
                                    <Box display="flex" gap={1.5}>
                                        <EventAvailableIcon />
                                        <Typography>
                                            {formatDate(event.start_date)} - {formatDate(event.end_date)}
                                        </Typography>
                                    </Box>
                                    {event?.location && (
                                        <Box display="flex" gap={1.5}>
                                            <LocationIcon />
                                            <Typography>{event.location}</Typography>
                                        </Box>
                                    )}
                                </Stack>

                                <Typography variant="body2" sx={{ opacity: 0.78 }}>
                                    Register here to receive your personal QR code for check-in and badge printing.
                                </Typography>
                            </Stack>
                        </Paper>
                    </Grid>

                    <Grid item xs={12} md={7}>
                        <Card sx={{ height: '100%', borderRadius: 2 }}>
                            <CardContent sx={{ p: { xs: 2.5, md: 4 } }}>
                                {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}

                                {attendee ? (
                                    <Box textAlign="center">
                                        <QrCodeIcon color="primary" sx={{ fontSize: 44, mb: 1 }} />
                                        <Typography variant="h4" gutterBottom>
                                            You are registered
                                        </Typography>
                                        <Typography color="text.secondary" sx={{ mb: 3 }}>
                                            Save this QR code for check-in. The event team can also print your badge on-site.
                                        </Typography>
                                        <Box sx={{ display: 'inline-flex', p: 2, bgcolor: 'white', border: '1px solid #e0e0e0' }}>
                                            <QRCodeSVG value={attendee.qr_code} size={220} />
                                        </Box>
                                        <Typography variant="h6" sx={{ mt: 2 }}>
                                            {attendee.first_name} {attendee.last_name}
                                        </Typography>
                                        <Typography color="text.secondary">{attendee.email}</Typography>
                                        <Typography variant="body2" sx={{ mt: 1 }}>
                                            QR Code: {attendee.qr_code}
                                        </Typography>
                                        <Button
                                            variant="outlined"
                                            sx={{ mt: 3 }}
                                            onClick={() => setAttendee(null)}
                                        >
                                            Register another attendee
                                        </Button>
                                    </Box>
                                ) : (
                                    <Box component="form" onSubmit={handleSubmit}>
                                        <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>
                                            Register attendee
                                        </Typography>
                                        <Grid container spacing={2}>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    required
                                                    label="First name"
                                                    value={form.first_name}
                                                    onChange={handleChange('first_name')}
                                                />
                                            </Grid>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    required
                                                    label="Last name"
                                                    value={form.last_name}
                                                    onChange={handleChange('last_name')}
                                                />
                                            </Grid>
                                            <Grid item xs={12}>
                                                <TextField
                                                    fullWidth
                                                    required
                                                    type="email"
                                                    label="Email"
                                                    value={form.email}
                                                    onChange={handleChange('email')}
                                                />
                                            </Grid>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    label="Company"
                                                    value={form.company}
                                                    onChange={handleChange('company')}
                                                />
                                            </Grid>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    label="Job title"
                                                    value={form.job_title}
                                                    onChange={handleChange('job_title')}
                                                />
                                            </Grid>
                                            <Grid item xs={12}>
                                                <TextField
                                                    fullWidth
                                                    label="Phone"
                                                    value={form.phone}
                                                    onChange={handleChange('phone')}
                                                />
                                            </Grid>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    select
                                                    label="Access type"
                                                    value={form.pass_type}
                                                    onChange={handleChange('pass_type')}
                                                >
                                                    {accessOptions.map((option) => (
                                                        <MenuItem key={option} value={option}>
                                                            {option}
                                                        </MenuItem>
                                                    ))}
                                                </TextField>
                                            </Grid>
                                            <Grid item xs={12} sm={6}>
                                                <TextField
                                                    fullWidth
                                                    label="Interests"
                                                    value={form.interests}
                                                    onChange={handleChange('interests')}
                                                    placeholder="Biofield, longevity, workshops..."
                                                />
                                            </Grid>
                                        </Grid>
                                        <Button
                                            type="submit"
                                            variant="contained"
                                            size="large"
                                            disabled={submitting}
                                            sx={{ mt: 3 }}
                                        >
                                            {submitting ? 'Registering...' : 'Register'}
                                        </Button>
                                    </Box>
                                )}
                            </CardContent>
                        </Card>
                    </Grid>
                </Grid>
            </Container>
        </Box>
    );
}

export default PublicRegistration;
