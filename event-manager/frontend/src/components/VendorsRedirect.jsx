import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircularProgress, Box, Typography } from '@mui/material';
import { getEvents } from '../utils/api';

/**
 * `/vendors` used to be its own screen over the same exhibitor rows. It is now
 * the Exhibitors area inside an event, so the old path forwards rather than
 * 404s — somebody has that URL in a bookmark or a message.
 *
 * The old screen opened on the first event, so this does too. If there is no
 * event to open, it goes to the list rather than guessing an id.
 */
export default function VendorsRedirect() {
    const navigate = useNavigate();
    useEffect(() => {
        let alive = true;
        getEvents()
            .then((r) => {
                if (!alive) return;
                const first = (r.data || [])[0];
                navigate(first ? `/events/${first.id}/exhibitors` : '/events', { replace: true });
            })
            .catch(() => { if (alive) navigate('/events', { replace: true }); });
        return () => { alive = false; };
    }, [navigate]);
    return (
        <Box sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={26} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                Vendors now lives under each event as Exhibitors — taking you there.
            </Typography>
        </Box>
    );
}
