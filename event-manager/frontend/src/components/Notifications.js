import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack,
    FormControl, InputLabel, Select, MenuItem, Alert, Checkbox,
    FormControlLabel, Divider, Chip,
} from '@mui/material';
import { sendNotification, getTicketTypes, getSessions } from '../utils/api';

// Send a web-push notification to attendees who opted in from their ticket.
// Audience targeting mirrors the backend: everyone, one ticket type, people
// already checked in, or people who saved a given session. Every send is
// scoped to this event, so the same panel works for any event, now or later.
function Notifications() {
    const { id } = useParams();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [url, setUrl] = useState('');
    const [audienceType, setAudienceType] = useState('all');
    const [ticketTypeId, setTicketTypeId] = useState('');
    const [sessionId, setSessionId] = useState('');
    const [alsoAnnounce, setAlsoAnnounce] = useState(true);
    const [ticketTypes, setTicketTypes] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        getTicketTypes(id)
            .then((r) => { if (!cancelled) setTicketTypes(r.data || []); })
            .catch(() => { if (!cancelled) setTicketTypes([]); });
        getSessions(id)
            .then((r) => { if (!cancelled) setSessions(r.data || []); })
            .catch(() => { if (!cancelled) setSessions([]); });
        return () => { cancelled = true; };
    }, [id]);

    const canSend = title.trim() && body.trim() && !sending
        && !(audienceType === 'ticket_type' && !ticketTypeId)
        && !(audienceType === 'session' && !sessionId);

    const handleSend = async () => {
        setError(null);
        setResult(null);
        setSending(true);
        const audience = { type: audienceType };
        if (audienceType === 'ticket_type') audience.ticket_type_id = Number(ticketTypeId);
        if (audienceType === 'session') audience.session_id = Number(sessionId);
        try {
            const r = await sendNotification(id, {
                title: title.trim(),
                body: body.trim(),
                url: url.trim() || null,
                audience,
                also_announce: alsoAnnounce,
            });
            setResult(r.data);
            setTitle('');
            setBody('');
            setUrl('');
        } catch (e) {
            setError(e.response?.data?.detail || 'Could not send the notification.');
        } finally {
            setSending(false);
        }
    };

    return (
        <Box sx={{ maxWidth: 640 }}>
            <Typography variant="h4" gutterBottom>Push Notifications</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Send a push notification to attendees who turned on alerts for this event
                from their ticket. It also appears under Announcements unless you turn that off.
            </Typography>

            <Card>
                <CardContent>
                    <Stack spacing={2}>
                        <TextField
                            label="Title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            fullWidth
                            inputProps={{ maxLength: 80 }}
                            helperText={`${title.length}/80`}
                        />
                        <TextField
                            label="Message"
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            fullWidth
                            multiline
                            minRows={2}
                            inputProps={{ maxLength: 300 }}
                            helperText={`${body.length}/300`}
                        />
                        <TextField
                            label="Link (optional)"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            fullWidth
                            placeholder="Opens in the app when tapped — defaults to this event"
                        />

                        <Divider />

                        <FormControl fullWidth>
                            <InputLabel id="audience-label">Audience</InputLabel>
                            <Select
                                labelId="audience-label"
                                label="Audience"
                                value={audienceType}
                                onChange={(e) => setAudienceType(e.target.value)}
                            >
                                <MenuItem value="all">Everyone with alerts on</MenuItem>
                                <MenuItem value="checked_in">Checked-in attendees</MenuItem>
                                <MenuItem value="ticket_type">By ticket type</MenuItem>
                                <MenuItem value="session">Saved a session</MenuItem>
                            </Select>
                        </FormControl>

                        {audienceType === 'ticket_type' && (
                            <FormControl fullWidth>
                                <InputLabel id="tt-label">Ticket type</InputLabel>
                                <Select
                                    labelId="tt-label"
                                    label="Ticket type"
                                    value={ticketTypeId}
                                    onChange={(e) => setTicketTypeId(e.target.value)}
                                >
                                    {ticketTypes.map((t) => (
                                        <MenuItem key={t.id} value={t.id}>
                                            {t.name || t.code}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                        )}

                        {audienceType === 'session' && (
                            <FormControl fullWidth>
                                <InputLabel id="sess-label">Session</InputLabel>
                                <Select
                                    labelId="sess-label"
                                    label="Session"
                                    value={sessionId}
                                    onChange={(e) => setSessionId(e.target.value)}
                                >
                                    {sessions.map((s) => (
                                        <MenuItem key={s.id} value={s.id}>
                                            {s.title}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                        )}

                        <FormControlLabel
                            control={(
                                <Checkbox
                                    checked={alsoAnnounce}
                                    onChange={(e) => setAlsoAnnounce(e.target.checked)}
                                />
                            )}
                            label="Also post to Announcements (visible in the app without a push)"
                        />

                        {error && <Alert severity="error">{error}</Alert>}
                        {result && (
                            <Alert severity="success">
                                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                    <span>Sent.</span>
                                    <Chip size="small" label={`Targeted ${result.targeted}`} />
                                    <Chip size="small" color="success" label={`Delivered ${result.sent}`} />
                                    {result.failed > 0 && (
                                        <Chip size="small" color="warning" label={`Failed ${result.failed}`} />
                                    )}
                                </Stack>
                                {result.targeted === 0 && (
                                    <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                                        No one has alerts on for this audience yet. It was still
                                        posted to Announcements.
                                    </Typography>
                                )}
                            </Alert>
                        )}

                        <Button
                            variant="contained"
                            size="large"
                            disabled={!canSend}
                            onClick={handleSend}
                        >
                            {sending ? 'Sending…' : 'Send notification'}
                        </Button>
                    </Stack>
                </CardContent>
            </Card>
        </Box>
    );
}

export default Notifications;
