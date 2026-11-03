import React, { useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Alert, Typography,
} from '@mui/material';
import { partnerGuestCreate } from '../utils/api';

// "Add Collaborating Guest": a visitor holding a Health & Healing Expo ticket.
// Staff look at their ticket; we issue our own complimentary badge for the
// exhibition halls only. The pass is chosen by the server, never here.
const BLANK = { first_name: '', last_name: '', email: '', phone: '', partner_confirmation: '' };

export default function PartnerGuestDialog({ open, eventId, onClose, onCreated }) {
    const [form, setForm] = useState(BLANK);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [matches, setMatches] = useState(null);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
    const close = () => { setForm(BLANK); setError(''); setMatches(null); onClose(); };

    const submit = async (confirmNew = false) => {
        setBusy(true); setError('');
        try {
            const r = await partnerGuestCreate(eventId, {
                first_name: form.first_name.trim(), last_name: form.last_name.trim(),
                email: form.email.trim(), phone: form.phone.trim() || undefined,
                partner_event: 'Health & Healing Expo',
                partner_confirmation: form.partner_confirmation.trim() || undefined,
                confirm_new: confirmNew,
            });
            const d = r.data || {};
            if (d.reason === 'possible_duplicate') { setMatches(d.matches || []); return; }
            const a = d.attendee;
            setForm(BLANK); setMatches(null);
            onCreated(a, { already: !!d.already_registered });
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not register the guest. Try again.');
        } finally { setBusy(false); }
    };

    const ready = form.first_name.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim());
    return (
        <Dialog open={open} onClose={busy ? undefined : close} fullWidth maxWidth="xs">
            <DialogTitle>Add Collaborating Guest</DialogTitle>
            <DialogContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Health &amp; Healing Expo ticket holder. Check their ticket, then enter their details.
                    They get a free Gaia badge for the <strong>exhibition halls only</strong> (no conference
                    sessions or workshops).
                </Typography>
                <Stack spacing={1.5}>
                    <TextField label="First name" value={form.first_name} onChange={set('first_name')} autoFocus required size="small" />
                    <TextField label="Last name" value={form.last_name} onChange={set('last_name')} size="small" />
                    <TextField label="Email" type="email" value={form.email} onChange={set('email')} required size="small" inputProps={{ autoCapitalize: 'none' }} />
                    <TextField label="Phone (optional)" type="tel" value={form.phone} onChange={set('phone')} size="small" />
                    <TextField label="Their ticket / confirmation no. (optional)" value={form.partner_confirmation} onChange={set('partner_confirmation')} size="small" />
                    {error && <Alert severity="error">{error}</Alert>}
                    {matches && (
                        <Alert severity="warning">
                            {matches.length ? 'Someone similar is already registered: ' + matches.map((m) => m.name || m.email || '').filter(Boolean).slice(0, 3).join(', ') + '. ' : ''}
                            Search for them first. Only continue if this is a different person.
                        </Alert>
                    )}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={close} disabled={busy}>Cancel</Button>
                {matches
                    ? <Button variant="contained" onClick={() => submit(true)} disabled={busy}>Different person, register</Button>
                    : <Button variant="contained" onClick={() => submit(false)} disabled={busy || !ready}>Create badge and check in</Button>}
            </DialogActions>
        </Dialog>
    );
}
