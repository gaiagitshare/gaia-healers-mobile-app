import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress, Container, Dialog, DialogActions, DialogContent, DialogTitle,
    Paper, Snackbar, Tab, Tabs, Typography,
} from '@mui/material';
import { getVolunteerPortal, requestVolunteerShift, cancelVolunteerShift } from '../utils/api';
import { byDay, dayLabel, shiftTime } from '../utils/volunteerTime';

/**
 * A volunteer's own page, reached by their private link. No account, no
 * password, no ads. Other volunteers appear by first name and last initial
 * only; nobody's contact details are ever shown here.
 */
const err = (e) => { const d = e?.response?.data?.detail; return typeof d === 'string' ? d : (e?.message || 'Something went wrong'); };
const MY_STATUS = {
    requested: ['Requested: waiting for the team to confirm', 'warning'],
    confirmed: ['Confirmed', 'success'],
    declined: ['Not confirmed: please pick another shift', 'default'],
};

export default function VolunteerPortal() {
    const { token } = useParams();
    const [data, setData] = useState(null);
    const [tab, setTab] = useState('mine');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(0);
    const [ask, setAsk] = useState(null);
    const [showIntro, setShowIntro] = useState(false);

    // A refresh never clears a message: it runs right after a refused join,
    // and wiping the reason there is how a volunteer would see nothing happen.
    const load = useCallback(() => getVolunteerPortal(token).then((r) => { setData(r.data); })
        .catch((e) => setError(err(e))), [token]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
    useEffect(() => { if (data && !data.my_bookings.length) setTab('available'); }, [data && data.my_bookings.length]); // eslint-disable-line

    const mineByShift = useMemo(() => Object.fromEntries((data?.my_bookings || []).map((b) => [b.shift.id, b])), [data]);
    if (!data) {
        return (
            <Container maxWidth="sm" sx={{ py: 4 }}>
                {error ? <Alert severity="error">{error}</Alert> : <Box sx={{ textAlign: 'center' }}><CircularProgress /></Box>}
            </Container>
        );
    }
    const join = (s) => {
        setBusy(s.id);
        requestVolunteerShift(token, s.id)
            .then(() => { setNotice(`Requested: ${s.role}, ${dayLabel(s.day)}, ${shiftTime(s)}. Your place is held while the team confirms.`); return load(); })
            .catch((e) => { setError(err(e)); load(); }).finally(() => setBusy(0));
    };
    const cancel = (b) => {
        setBusy(b.shift.id);
        cancelVolunteerShift(token, b.booking_id)
            .then(() => { setNotice('Cancelled. Please also let Bita know.'); setAsk(null); return load(); })
            .catch((e) => setError(err(e))).finally(() => setBusy(0));
    };
    const active = data.my_bookings.filter((b) => b.status === 'requested' || b.status === 'confirmed');
    const perDay = byDay(active.map((b) => b.shift));
    const expected = data.program.expected_per_day || 0;

    const card = (s, mode) => {
        const mine = mineByShift[s.id];
        const isMine = mine && (mine.status === 'requested' || mine.status === 'confirmed');
        const full = s.open <= 0;
        return (
            <Paper key={`${mode}-${s.id}`} variant="outlined" sx={{ p: 2, mb: 1.5, borderColor: isMine ? 'success.main' : undefined }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{s.role}</Typography>
                <Typography variant="body1">{shiftTime(s)}</Typography>
                {s.location && <Typography variant="body2" color="text.secondary">{s.location}</Typography>}
                {mode !== 'mine' && s.description && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{s.description}</Typography>}
                <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }} color={full ? 'text.secondary' : 'success.main'}>
                    {s.taken} of {s.capacity} booked{full ? ' · Full' : ` · ${s.open} open`}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    Assigned: {s.people.length ? s.people.map((p) => p.name + (p.status === 'requested' ? ' (requested)' : '')).join(', ') : 'nobody yet'}
                </Typography>
                <Box sx={{ mt: 1.5 }}>
                    {mode === 'mine' && mine && <>
                        <Chip size="small" color={MY_STATUS[mine.status]?.[1]} label={MY_STATUS[mine.status]?.[0] || mine.status} sx={{ mr: 1 }} />
                        {isMine && <Button size="small" color="inherit" onClick={() => setAsk(mine)}>Cancel shift</Button>}
                    </>}
                    {mode !== 'mine' && (isMine
                        ? <Chip size="small" color={MY_STATUS[mine.status]?.[1]} label={mine.status === 'confirmed' ? 'You are on this shift' : 'You requested this'} />
                        : <Button variant="contained" size="large" fullWidth disabled={full || busy === s.id} onClick={() => join(s)}>
                            {full ? 'Full' : busy === s.id ? 'Joining…' : 'Join shift'}</Button>)}
                </Box>
            </Paper>
        );
    };

    const days = byDay(data.shifts);
    return (
        <Container maxWidth="md" sx={{ py: 2, px: { xs: 2, sm: 3 } }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>{data.program.title || 'Volunteer schedule'}</Typography>
            <Typography variant="body2" color="text.secondary">{data.event.name} · times are Orlando time</Typography>
            <Typography sx={{ mt: 1 }}>Hi {data.me.first_name}!{data.me.status === 'pending' ? ' The team will confirm you shortly. You can already request shifts.' : ''}</Typography>
            {data.program.intro && <Button size="small" sx={{ px: 0 }} onClick={() => setShowIntro(true)}>Welcome, reminders &amp; dress code</Button>}
            {/* Messages sit at the bottom of the screen, where a phone user who
                just tapped "Join shift" halfway down the list can see them. */}
            <Snackbar open={Boolean(error || notice)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
                      autoHideDuration={error ? 9000 : 6000} onClose={(e, why) => { if (why !== 'clickaway') { setError(''); setNotice(''); } }}>
                <Alert severity={error ? 'error' : 'success'} variant="filled" onClose={() => { setError(''); setNotice(''); }} sx={{ width: '100%' }}>
                    {error || notice}
                </Alert>
            </Snackbar>

            <Box sx={{ position: 'sticky', top: 0, zIndex: 2, bgcolor: 'background.default', mt: 1 }}>
                <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="fullWidth">
                    <Tab value="mine" label={`My Shifts (${active.length})`} />
                    <Tab value="available" label="Available" />
                    <Tab value="all" label="Full Schedule" />
                </Tabs>
            </Box>

            <Box sx={{ mt: 2 }}>
                {tab === 'mine' && (data.my_bookings.length ? <>
                    {expected > 0 && perDay.map((g) => (
                        <Typography key={g.day} variant="body2" color={g.shifts.length >= expected ? 'success.main' : 'warning.main'}>
                            {dayLabel(g.day)}: {g.shifts.length} of {expected} expected shifts
                        </Typography>
                    ))}
                    {byDay(data.my_bookings.map((b) => b.shift)).map((g) => (
                        <Box key={g.day} sx={{ mt: 2 }}>
                            <Typography variant="h6">{dayLabel(g.day)}</Typography>
                            {g.shifts.map((s) => card(s, 'mine'))}
                        </Box>
                    ))}
                </> : <Alert severity="info">You have no shifts yet. Open <b>Available</b> to pick some.</Alert>)}

                {(tab === 'available' || tab === 'all') && days.map((g) => {
                    const list = tab === 'available' ? g.shifts.filter((s) => s.open > 0 || mineByShift[s.id]) : g.shifts;
                    if (!list.length) return null;
                    return (
                        <Box key={g.day} sx={{ mb: 2 }}>
                            <Typography variant="h6" sx={{ position: 'sticky', top: 48, bgcolor: 'background.default', py: 0.5, zIndex: 1 }}>{dayLabel(g.day)}</Typography>
                            {list.map((s) => card(s, tab))}
                        </Box>
                    );
                })}
            </Box>

            <Dialog open={Boolean(ask)} onClose={() => setAsk(null)}>
                <DialogTitle>Cancel this shift?</DialogTitle>
                <DialogContent>{ask && <Typography>{ask.shift.role}, {dayLabel(ask.shift.day)}, {shiftTime(ask.shift)}</Typography>}</DialogContent>
                <DialogActions><Button onClick={() => setAsk(null)}>Keep it</Button>
                    <Button color="error" variant="contained" onClick={() => cancel(ask)}>Cancel shift</Button></DialogActions>
            </Dialog>
            <Dialog open={showIntro} onClose={() => setShowIntro(false)} fullWidth>
                <DialogTitle>{data.program.title}</DialogTitle>
                <DialogContent><Typography sx={{ whiteSpace: 'pre-line' }}>{data.program.intro}</Typography></DialogContent>
                <DialogActions><Button onClick={() => setShowIntro(false)}>Close</Button></DialogActions>
            </Dialog>
        </Container>
    );
}
