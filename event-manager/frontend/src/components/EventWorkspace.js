import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Typography, Chip, Stack } from '@mui/material';
import { getEvent, getMyCapabilities } from '../utils/api';
import EventNav from './EventNav';
import EventDetail from './EventDetail';
import LiveAdmin from './LiveAdmin';
import Agenda from './Agenda';
import Attendees from './Attendees';
import CheckIn from './CheckIn';
import EventSetup from './EventSetup';
import Notifications from './Notifications';
import EventInfoAdmin from './EventInfoAdmin';
import EventResources from './EventResources';
import CommunityAdmin from './CommunityAdmin';
import TicketMappings from './TicketMappings';
import ReviewQueue from './ReviewQueue';
import TicketDelivery from './TicketDelivery';
import Reconciliation from './Reconciliation';
import Volunteers from './Volunteers';
import ShareQr from './ShareQr';
import EmailCenter from './EmailCenter';
import BiowellStation from './BiowellStation';
import BiowellDashboard from './BiowellDashboard';

// One workspace per event. The sections are structural, not configured, so any
// event — the first or the twentieth — gets all of them the moment it exists.
const SECTIONS = [
    ['overview', 'Overview'],
    ['schedule', 'Schedule'],
    ['speakers', 'Speakers'],
    ['exhibitors', 'Exhibitors'],
    ['sponsors', 'Sponsors'],
    // Labels, not keys. 'Updates' and 'Notify' read as near-synonyms to
    // anyone who has not used both; the paths stay put so existing links do.
    ['updates', 'Announcements'],
    ['notify', 'Push Notifications'],
    ['info', 'FAQ & Info'],
    ['resources', 'Resources'],
    ['share', 'Share & QR codes'],
    ['community', 'Community'],
    ['attendees', 'Attendees'],
    ['setup', 'Setup'],
    ['mappings', 'Ticket Mappings'],
    ['review', 'Review Queue'],
    ['delivery', 'Ticket Emails'],
    ['email', 'Email Center'],
    ['reconcile', 'Ticket Reconciliation'],
    ['volunteers', 'Volunteers'],
    ['live', 'Live'],
    ['checkin', 'Check-In'],
    ['biowell-station', 'Bio-Well Station'],
    ['biowell', 'Bio-Well'],
];

function EventWorkspace() {
    const { id, section } = useParams();
    const navigate = useNavigate();
    const [event, setEvent] = useState(null);
    const [caps, setCaps] = useState(undefined); // undefined = loading, null = unavailable
    // A Ticket Email Manager holds ticket_email.* but not attendee.read: their
    // workspace is the Email Center alone. If capabilities cannot be loaded,
    // everyone keeps the full workspace (the server still enforces access).
    // A Bio-Well station user (biowell.station without attendee.read) likewise
    // gets the station screen alone; someone holding both restricted roles
    // gets both sections.
    const has = (cap) => Boolean(caps && caps.includes(cap));
    const restricted = Boolean(caps && !has('attendee.read') && (has('ticket_email.read') || has('biowell.station')));
    // Bio-Well sections are shown by capability. If capabilities could not be
    // loaded everyone keeps the full workspace (the server still enforces access).
    const allowed = (key) => {
        if (key === 'biowell-station') return caps == null || has('biowell.station');
        if (key === 'biowell') return caps == null || has('biowell.read');
        if (restricted) return key === 'email' && has('ticket_email.read');
        return true;
    };
    const sections = SECTIONS.filter(([key]) => allowed(key));
    const fallback = restricted ? (sections[0]?.[0] || 'overview') : 'overview';
    const active = sections.some(([key]) => key === section) ? section : fallback;

    useEffect(() => {
        let cancelled = false;
        setCaps(undefined);
        getMyCapabilities(id)
            .then((r) => { if (!cancelled) setCaps(Array.isArray(r.data?.capabilities) ? r.data.capabilities : null); })
            .catch(() => { if (!cancelled) setCaps(null); });
        return () => { cancelled = true; };
    }, [id]);

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
            case 'live': return <LiveAdmin />;
            case 'exhibitors': return <EventDetail section="exhibitors" />;
            case 'attendees': return <Attendees timezone={event?.timezone} />;
            case 'notify': return <Notifications />;
            case 'info': return <EventInfoAdmin />;
            case 'resources': return <EventResources />;
            case 'community': return <CommunityAdmin />;
            case 'setup': return <EventSetup />;
            case 'mappings': return <TicketMappings />;
            case 'review': return <ReviewQueue />;
            case 'delivery': return <TicketDelivery />;
            case 'reconcile': return <Reconciliation />;
            case 'share': return <ShareQr />;
            case 'volunteers': return <Volunteers />;
            case 'checkin': return <CheckIn timezone={event?.timezone} />;
            case 'email': return <EmailCenter />;
            case 'biowell-station': return <BiowellStation />;
            case 'biowell': return <BiowellDashboard />;
            default: return <EventDetail section="overview" />;
        }
    };

    return (
        <Box>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
                <Typography variant="h4" sx={{ fontSize: { xs: '1.3rem', sm: '1.6rem' }, fontWeight: 700 }}>
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

            <EventNav
                sections={sections}
                active={active}
                onSelect={(key) => navigate(`/events/${id}/${key}`)}
            />

            {/* Keyed on the event id so switching events remounts the panel and
                cannot leave the previous event's rows on screen. */}
            <Box key={`${id}:${active}`}>{caps === undefined ? null : panel()}</Box>
        </Box>
    );
}

export default EventWorkspace;
