import React, { useEffect, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Card,
    CardActionArea,
    CardContent,
    Chip,
    Grid,
    LinearProgress,
    List,
    ListItem,
    ListItemText,
    Stack,
    Typography,
} from '@mui/material';
import {
    Badge as BadgeIcon,
    Business as ExhibitorIcon,
    CheckCircle as CheckInIcon,
    Event as EventIcon,
    People as PeopleIcon,
    Sync as SyncIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { autoSyncEvents, getDashboardStats } from '../utils/api';

function StatCard({ title, value, detail, icon, color, onClick }) {
    return (
        <Card>
            <CardActionArea onClick={onClick} disabled={!onClick}>
                <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                    <Box>
                        <Typography color="textSecondary" variant="body2">
                            {title}
                        </Typography>
                        <Typography variant="h4" sx={{ fontWeight: 700, mt: 0.5 }}>
                            {value}
                        </Typography>
                        {detail && (
                            <Typography variant="caption" color="textSecondary">
                                {detail}
                            </Typography>
                        )}
                    </Box>
                    <Box sx={{ color }}>{icon}</Box>
                </Box>
                </CardContent>
            </CardActionArea>
        </Card>
    );
}

function Dashboard() {
    const navigate = useNavigate();
    const [stats, setStats] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [notice, setNotice] = useState(null);

    useEffect(() => {
        loadStats();
    }, []);

    const loadStats = async () => {
        try {
            const response = await getDashboardStats();
            setStats(response.data);
        } catch (error) {
            console.error('Failed to load stats:', error);
        }
    };

    const handleSync = async () => {
        setSyncing(true);
        setNotice(null);
        try {
            const response = await autoSyncEvents();
            const synced = response.data.synced?.length || 0;
            const failed = response.data.errors?.length || 0;
            setNotice({
                severity: failed ? 'warning' : 'success',
                message: `Synced ${synced} event source${synced === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`,
            });
            await loadStats();
        } catch (error) {
            setNotice({
                severity: 'error',
                message: error.response?.data?.detail || 'Could not sync Gaia pages.',
            });
        } finally {
            setSyncing(false);
        }
    };

    const checkInRate = stats?.check_in_rate || 0;
    const paidRate = stats?.total_attendees ? Math.round((stats.paid_members / stats.total_attendees) * 100) : 0;
    const primaryEvent = stats?.events?.[0];
    const goToPrimaryAttendees = () => {
        if (primaryEvent) {
            navigate(`/events/${primaryEvent.id}/attendees`);
        } else {
            navigate('/events');
        }
    };
    const goToPrimaryEvent = () => {
        if (primaryEvent) {
            navigate(`/events/${primaryEvent.id}`);
        } else {
            navigate('/events');
        }
    };

    return (
        <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3} gap={2} flexWrap="wrap">
                <Box>
                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                        Event Operations
                    </Typography>
                    <Typography color="textSecondary">
                        Gaia pages auto-sync every {stats?.auto_sync_interval_hours || 6} hours.
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    startIcon={<SyncIcon />}
                    onClick={handleSync}
                    disabled={syncing}
                >
                    {syncing ? 'Syncing...' : 'Sync Gaia Pages'}
                </Button>
            </Box>

            {notice && <Alert severity={notice.severity} sx={{ mb: 3 }}>{notice.message}</Alert>}

            <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Active Events"
                        value={stats?.active_events || 0}
                        detail={`${stats?.total_events || 0} total events`}
                        icon={<EventIcon fontSize="large" />}
                        color="#2d5a3d"
                        onClick={() => navigate('/events')}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Attendees"
                        value={stats?.total_attendees || 0}
                        detail={`${stats?.paid_members || 0} paid members`}
                        icon={<PeopleIcon fontSize="large" />}
                        color="#4a7c59"
                        onClick={goToPrimaryAttendees}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Check-In Rate"
                        value={`${checkInRate}%`}
                        detail={`${stats?.total_checked_in || 0} checked in`}
                        icon={<CheckInIcon fontSize="large" />}
                        color="#c9a227"
                        onClick={() => navigate('/checkin')}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Lead Retrieval"
                        value={stats?.total_leads || 0}
                        detail={`${stats?.total_exhibitors || 0} exhibitors`}
                        icon={<ExhibitorIcon fontSize="large" />}
                        color="#8a6f1d"
                        onClick={goToPrimaryEvent}
                    />
                </Grid>
            </Grid>

            <Grid container spacing={2} mt={0}>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Upcoming"
                        value={stats?.upcoming_events || 0}
                        detail={stats?.next_event ? `${stats.next_event.days_until} days until next` : 'No upcoming events'}
                        icon={<EventIcon fontSize="large" />}
                        color="#2d5a3d"
                        onClick={() => navigate('/events')}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Live Now"
                        value={stats?.live_events || 0}
                        detail="Events currently in progress"
                        icon={<CheckInIcon fontSize="large" />}
                        color="#c9a227"
                        onClick={() => navigate('/events')}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Past Events"
                        value={stats?.past_events || 0}
                        detail="Based on event end dates"
                        icon={<EventIcon fontSize="large" />}
                        color="#5a6b5a"
                        onClick={() => navigate('/events')}
                    />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatCard
                        title="Website Sources"
                        value={stats?.source_count || 0}
                        detail="Synced from Gaia/GHL pages"
                        icon={<SyncIcon fontSize="large" />}
                        color="#4a7c59"
                        onClick={handleSync}
                    />
                </Grid>
            </Grid>

            <Grid container spacing={2} mt={0}>
                <Grid item xs={12} md={7}>
                    <Card>
                        <CardContent>
                            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                                <Typography variant="h6">Event Readiness</Typography>
                                <Chip label={`${stats?.source_count || 0} synced source`} size="small" />
                            </Box>
                            <Stack spacing={2}>
                                {(stats?.events || []).map((event) => (
                                    <Box
                                        key={event.id}
                                        onClick={() => navigate(`/events/${event.id}`)}
                                        sx={{
                                            cursor: 'pointer',
                                            borderRadius: 1,
                                            p: 1,
                                            mx: -1,
                                            '&:hover': { bgcolor: 'rgba(45, 90, 61, 0.06)' },
                                        }}
                                    >
                                        <Box display="flex" justifyContent="space-between" gap={2}>
                                            <Box>
                                                <Typography sx={{ fontWeight: 700 }}>{event.name}</Typography>
                                                <Typography variant="body2" color="textSecondary">
                                                    {event.location} · {new Date(event.start_date).toLocaleDateString()}
                                                </Typography>
                                            </Box>
                                            <Chip
                                                label={event.status === 'live' ? 'Live' : event.status === 'past' ? 'Past' : 'Upcoming'}
                                                color={event.status === 'live' ? 'warning' : event.status === 'past' ? 'default' : 'success'}
                                                size="small"
                                            />
                                        </Box>
                                        <Grid container spacing={1} sx={{ mt: 1 }}>
                                            <Grid item xs={6} sm={3}><Typography variant="caption">{event.attendee_count} attendees</Typography></Grid>
                                            <Grid item xs={6} sm={3}><Typography variant="caption">{event.checked_in_count} checked in</Typography></Grid>
                                            <Grid item xs={6} sm={3}><Typography variant="caption">{event.exhibitor_count} exhibitors</Typography></Grid>
                                            <Grid item xs={6} sm={3}><Typography variant="caption">{event.lead_count} leads</Typography></Grid>
                                        </Grid>
                                        {event.days_until !== null && (
                                            <Typography variant="caption" color="textSecondary">
                                                {event.status === 'upcoming'
                                                    ? `${event.days_until} days until event`
                                                    : event.status === 'past'
                                                        ? `${Math.abs(event.days_until)} days since event start`
                                                        : 'Event is currently live'}
                                            </Typography>
                                        )}
                                        <LinearProgress
                                            variant="determinate"
                                            value={Math.min(event.check_in_rate, 100)}
                                            sx={{ mt: 1, height: 8, borderRadius: 1 }}
                                        />
                                    </Box>
                                ))}
                                {!stats?.events?.length && (
                                    <Typography color="textSecondary">No events yet. Sync Gaia pages or create an event.</Typography>
                                )}
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                <Grid item xs={12} md={5}>
                    <Card>
                        <CardContent>
                            <Typography variant="h6" gutterBottom>Attendance Mix</Typography>
                            <Box mb={2}>
                                <Box display="flex" justifyContent="space-between">
                                    <Typography variant="body2">Paid members</Typography>
                                    <Typography variant="body2">{paidRate}%</Typography>
                                </Box>
                                <LinearProgress variant="determinate" value={paidRate} sx={{ height: 8, borderRadius: 1 }} />
                            </Box>
                            <Box display="flex" alignItems="center" gap={1} mb={2}>
                                <BadgeIcon color="secondary" />
                                <Typography variant="body2">
                                    Badges are generated per attendee from the attendee table.
                                </Typography>
                            </Box>
                            <Typography variant="h6" gutterBottom>Recent Registrations</Typography>
                            <List dense>
                                {(stats?.recent_attendees || []).map((attendee) => (
                                    <ListItem key={attendee.id} disablePadding>
                                        <ListItemText
                                            primary={attendee.name || attendee.email}
                                            secondary={`${attendee.pass_type || 'No access type'} · ${attendee.paid_member ? 'Paid member' : 'Direct/public'}`}
                                        />
                                    </ListItem>
                                ))}
                                {!stats?.recent_attendees?.length && (
                                    <Typography color="textSecondary">No attendee registrations yet.</Typography>
                                )}
                            </List>
                        </CardContent>
                    </Card>
                </Grid>
            </Grid>
        </Box>
    );
}

export default Dashboard;
