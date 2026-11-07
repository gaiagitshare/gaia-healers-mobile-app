import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Container, Paper, TextField, Typography } from '@mui/material';
import { getVolunteerJoin, applyVolunteer } from '../utils/api';

/**
 * Registration for NEW volunteers. The team opens or closes it, approves each
 * person, and then sends them their personal link: signing up here gives no
 * access to the team portal by itself.
 */
const err = (e) => { const d = e?.response?.data?.detail; return typeof d === 'string' ? d : (e?.message || 'Something went wrong'); };

export default function VolunteerJoin() {
    const { joinToken } = useParams();
    const [info, setInfo] = useState(null);
    const [form, setForm] = useState({});
    const [error, setError] = useState('');
    const [done, setDone] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { getVolunteerJoin(joinToken).then((r) => setInfo(r.data)).catch((e) => setError(err(e))); }, [joinToken]);
    const submit = () => {
        setBusy(true); setError('');
        applyVolunteer(joinToken, form).then((r) => setDone(r.data.message))
            .catch((e) => setError(err(e))).finally(() => setBusy(false));
    };
    const field = (k, label, type = 'text') => (
        <TextField key={k} fullWidth label={label} type={type} sx={{ mb: 1.5 }} value={form[k] || ''}
                   onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
    );
    return (
        <Container maxWidth="sm" sx={{ py: 3, px: 2 }}>
            {!info && !error && <Box sx={{ textAlign: 'center' }}><CircularProgress /></Box>}
            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
            {info && <>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>{info.title || 'Volunteer team'}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{info.event}</Typography>
                {done ? <Alert severity="success">{done}</Alert> : !info.open
                    ? <Alert severity="info">Volunteer registration is closed. Please contact the volunteer team.</Alert> : (
                        <Paper variant="outlined" sx={{ p: 2 }}>
                            <Typography sx={{ mb: 2 }}>Would you like to volunteer? Enter your details. The team reviews each registration and sends you your personal volunteer page.</Typography>
                            {field('first_name', 'First name')}{field('last_name', 'Last name')}
                            {field('email', 'Email', 'email')}{field('phone', 'Mobile phone (for texts from the team)', 'tel')}
                            {field('note', 'Anything we should know? (optional)')}
                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                                Only the volunteer team sees your contact details. Other volunteers see your first name and last initial.
                            </Typography>
                            <Button variant="contained" size="large" fullWidth disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Register as a volunteer'}</Button>
                        </Paper>
                    )}
                {info.intro && !done && <Typography variant="body2" sx={{ whiteSpace: 'pre-line', mt: 3 }} color="text.secondary">{info.intro}</Typography>}
            </>}
        </Container>
    );
}
