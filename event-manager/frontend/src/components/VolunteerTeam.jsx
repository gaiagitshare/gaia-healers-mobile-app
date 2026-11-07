import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Container, Paper, Tab, Tabs, Typography } from '@mui/material';
import { getVolunteerTeam } from '../utils/api';
import { byDay, dayLabel, shiftTime } from '../utils/volunteerTime';
import { rememberedVolunteerToken } from './VolunteerPortal';

/**
 * The shared team link: the whole schedule and the team's announcements, for
 * the volunteer group chat. Read-only -- requesting or cancelling a shift
 * happens on each volunteer's own page, reached by their personal invitation
 * link (remembered on this device once opened).
 */
const err = (e) => { const d = e?.response?.data?.detail; return typeof d === 'string' ? d : (e?.message || 'Something went wrong'); };

export default function VolunteerTeam() {
    const { teamToken } = useParams();
    const navigate = useNavigate();
    const [info, setInfo] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('schedule');
    const mine = rememberedVolunteerToken();
    useEffect(() => { getVolunteerTeam(teamToken).then((r) => setInfo(r.data)).catch((e) => setError(err(e))); }, [teamToken]);
    if (!info) return <Container maxWidth="sm" sx={{ py: 4 }}>{error ? <Alert severity="error">{error}</Alert> : <Box sx={{ textAlign: 'center' }}><CircularProgress /></Box>}</Container>;
    return (
        <Container maxWidth="md" sx={{ py: 2, px: { xs: 2, sm: 3 } }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>{info.title || 'Volunteer team'}</Typography>
            <Typography variant="body2" color="text.secondary">{info.event} · times are Orlando time</Typography>
            <Paper variant="outlined" sx={{ p: 1.5, my: 1.5 }}>
                {mine
                    ? <Button variant="contained" fullWidth size="large" onClick={() => navigate(`/volunteer/${mine}`)}>Open my volunteer page</Button>
                    : <Typography variant="body2">To request or cancel shifts, open the <b>personal link</b> from your invitation email. This page shows the team schedule only.</Typography>}
            </Paper>
            <Box sx={{ position: 'sticky', top: 0, zIndex: 2, bgcolor: 'background.default' }}>
                <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="fullWidth">
                    <Tab value="schedule" label="Team schedule" />
                    <Tab value="news" label={`Announcements${info.announcements.length ? ` (${info.announcements.length})` : ''}`} />
                </Tabs>
            </Box>
            {tab === 'schedule' && byDay(info.shifts).map((g) => (
                <Box key={g.day} sx={{ mt: 2 }}>
                    <Typography variant="h6">{dayLabel(g.day)}</Typography>
                    {g.shifts.map((s) => (
                        <Paper key={s.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                            <Typography sx={{ fontWeight: 700 }}>{s.role}</Typography>
                            <Typography variant="body2">{shiftTime(s)}{s.location ? ` · ${s.location}` : ''}</Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }} color={s.open ? 'success.main' : 'text.secondary'}>
                                {s.taken} of {s.capacity} booked{s.open ? ` · ${s.open} open` : ' · Full'}</Typography>
                            <Typography variant="body2" color="text.secondary">
                                Assigned: {s.people.length ? s.people.map((p) => p.name + (p.status === 'requested' ? ' (requested)' : '')).join(', ') : 'nobody yet'}</Typography>
                        </Paper>
                    ))}
                </Box>
            ))}
            {tab === 'news' && <Box sx={{ mt: 2 }}>
                {!info.announcements.length && <Alert severity="info">No announcements yet.</Alert>}
                {info.announcements.map((a) => (
                    <Paper key={a.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
                        <Typography sx={{ fontWeight: 700 }}>{a.pinned ? '📌 ' : ''}{a.title}</Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>{a.body}</Typography>
                    </Paper>
                ))}
                {info.intro && <Typography variant="body2" sx={{ whiteSpace: 'pre-line', mt: 2 }} color="text.secondary">{info.intro}</Typography>}
            </Box>}
        </Container>
    );
}
