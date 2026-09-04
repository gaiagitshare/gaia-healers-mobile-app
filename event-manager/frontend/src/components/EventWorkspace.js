import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Typography, Tabs, Tab, Chip, Stack } from '@mui/material';
import { getEvent } from '../utils/api';
import EventDetail from './EventDetail';
import Agenda from './Agenda';
import Attendees from './Attendees';
import CheckIn from './CheckIn';
import EventSetup from './EventSetup';
import Notifications from './Notifications';
import EventInfoAdmin from './EventInfoAdmin';
import EventResources from './EventResources';
import CommunityAdmin from './CommunityAdmin';
import TicketMappings from './TicketMappings';

// One workspace per event. The sections are structural, not configured, so any
// event — the first or the twentieth — gets all of them the moment it exists.
const SECTIONS = [
    ['overview', 'Overview'],
    ['schedule', 'Schedule'],
    ['speakers', 'Speakers'],
    ['exhibitors', 'Exhibitors'],
    ['sponsors', 'Sponsors'],
    ['updates', 'Updates'],
    ['notify', 'Notify'],
    ['info', 'FAQ & Info'],
    ['resources', 'Resources'],
    ['community', 'Community'],
    ['attendees', 'Attendees'],
    ['setup', 'Setup'],
    ['mappings', 'Ticket Mappings'],
    ['live', 'Live'],
    ['checkin', 'Check-In'],
];

function EventWorkspace() {
    const { id, section } = useParams();
    const navigate = useNavigate();
    const [event, setEvent] = useState(null);
    const active = SECTIONS.some(([key]) => key === section) ? section : 'overview';

    useEffect(() => {
        let cancelled = false;
        // Reload whenever the event changes so no previous event's name or state
        // is left on screen while the new one loads.
        setEvent(null);
        getEvent(id)
            .then((response) => { if (!cancelled) setEvent(response.data); })
            .catch(() => { if (!cancelled) setEvent(null); });
        return () => { cancelled = true; };
    }, [id]);

    const panel = () => {
        switch (active) {
            case 'schedule': return <Agenda section="schedule" />;
            case 'speakers': return <Agenda section="speakers" />;
            case 'sponsors': return <Agenda section="sponsors" />;
            case 'updates': return <Agenda section="updates" />;
            case 'live': return <Agenda section="live" />;
            case 'exhibitors': return <EventDetail section="exhibitors" />;
            case 'attendees': return <Attendees timezone={event?.timezone} />;
            case 'notify': return <Notifications />;
            case 'info': return <EventInfoAdmin />;
            case 'resources': return <EventResources />;
            case 'community': return <CommunityAdmin />;
            case 'setup': return <EventSetup />;
            case 'mappings': return <TicketMappings />;
            case 'checkin': return <CheckIn timezone={event?.timezone} />;
            default: return <EventDetail section="overview" />;
        }
    };

    return (
        <Box>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
                <Typography variant="h4" sx={{ fontSize: { xs: '1.4rem', sm: '2rem' } }}>
                    {event ? event.name : 'Loading event…'}
                </Typography>
                {event && (
                    <>
                        <Chip size="small" color={event.is_published ? 'primary' : 'default'}
                              label={event.is_published ? 'Published' : 'Draft'} />
                        {event.live_enabled && <Chip size="small" color="secondary" label="Live" />}
                        {event.timezone && <Chip size="small" variant="outlined" label={event.timezone} />}
                    </>
                )}
            </Stack>

            <Tabs
                value={active}
                onChange={(_, value) => navigate(`/events/${id}/${value}`)}
                variant="scrollable"
                scrollButtons="auto"
                sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
            >
                {SECTIONS.map(([key, label]) => <Tab key={key} value={key} label={label} />)}
            </Tabs>

            {/* Keyed on the event id so switching events remounts the panel and
                cannot leave the previous event's rows on screen. */}
            <Box key={`${id}:${active}`}>{panel()}</Box>
        </Box>
    );
}

export default EventWorkspace;
