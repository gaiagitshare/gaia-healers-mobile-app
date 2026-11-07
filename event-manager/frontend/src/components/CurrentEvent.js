import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { getEvents } from '../utils/api';
import { pickCurrentEvent } from '../utils/currentEvent';

/**
 * /events/current: open the event running now (or the nearest upcoming one)
 * exactly as its eye icon does. `replace` keeps this hop out of the history,
 * so Back from the event goes to wherever the admin came from, not here.
 * With no such event, the full list opens instead.
 */
export default function CurrentEvent() {
    const navigate = useNavigate();
    const [done, setDone] = useState(false);
    useEffect(() => {
        let cancelled = false;
        getEvents()
            .then((r) => {
                if (cancelled) return;
                const ev = pickCurrentEvent(r.data);
                navigate(ev ? `/events/${ev.id}` : '/events/all', { replace: true });
            })
            .catch(() => { if (!cancelled) navigate('/events/all', { replace: true }); })
            .finally(() => { if (!cancelled) setDone(true); });
        return () => { cancelled = true; };
    }, [navigate]);
    return done ? null : <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress size={28} /></Box>;
}
