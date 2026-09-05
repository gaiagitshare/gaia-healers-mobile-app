import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack, Chip,
    Switch, FormControlLabel, Alert, CircularProgress, Divider,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { getEvent, updateEvent, getAnnouncements } from '../utils/api';

/**
 * Live — what attendees are being shown right now.
 *
 * One question runs this screen: what are we broadcasting? The switch that puts
 * the app into live mode, the banner line, the venue display, and a read-only
 * view of the announcements riding along with them.
 *
 * These controls used to live inside <Agenda>, which meant they rendered on
 * Schedule, Speakers, Sponsors and Updates as well — the same on-air switch on
 * five screens, none of which were about being on air. Worse, `live` had no tab
 * of its own in that component, so it fell through to index 0 and the Live tab
 * showed the schedule editor: "Add session", "Import CSV", "No sessions yet".
 *
 * Nothing here writes an announcement. The list below is a mirror of what the
 * live payload carries, and editing it belongs under Updates — one editor, not
 * two.
 */
export default function LiveAdmin() {
    const { id } = useParams();
    const navigate = useNavigate();
    const [event, setEvent] = useState(null);
    const [notes, setNotes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [e, a] = await Promise.all([getEvent(id), getAnnouncements(id)]);
            setEvent(e.data);
            setNotes(a.data || []);
        } catch (err) {
            setError('Could not load the live controls.');
        } finally { setLoading(false); }
    }, [id]);

    useEffect(() => { load(); }, [load]);

    const setLive = async (enabled) => {
        try {
            const res = await updateEvent(id, { live_enabled: enabled });
            setEvent(res.data);
            setSaved(enabled ? 'Live page is on.' : 'Live page is off.');
        } catch (err) {
            setError('Could not change the live page.');
        }
    };

    const saveLiveMessage = async (message) => {
        if ((event?.live_message || '') === message) return;
        try {
            const res = await updateEvent(id, { live_message: message });
            setEvent(res.data);
            setSaved(message ? 'Banner saved.' : 'Banner cleared.');
        } catch (err) {
            setError('Could not save the live message.');
        }
    };

    if (loading && !event) return <CircularProgress size={26} />;

    // Exactly what /public/events/{id}/live carries: published only, pinned
    // first, five at most. Showing all of them here would be a different list
    // from the one attendees see, which is worse than showing none.
    const onAir = notes
        .filter((n) => n.is_published)
        .sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0))
        .slice(0, 5);
    const live = Boolean(event?.live_enabled);

    return (
        <Box>
            <Stack direction="row" alignItems="baseline" gap={1.5} flexWrap="wrap" sx={{ mb: 0.5 }}>
                <Typography variant="h5">Live</Typography>
                <Typography variant="body2" color="text.secondary">
                    What attendees are being shown right now.
                </Typography>
            </Stack>

            {error && <Alert severity="error" sx={{ my: 2 }} onClose={() => setError('')}>{error}</Alert>}
            {saved && <Alert severity="success" sx={{ my: 2 }} onClose={() => setSaved('')}>{saved}</Alert>}

            <Card sx={{ mt: 2, mb: 3, border: (t) => `1px solid ${live ? t.palette.primary.main : 'transparent'}` }}>
                <CardContent>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}
                           justifyContent="space-between" alignItems={{ sm: 'center' }}>
                        <Box>
                            <Typography variant="h6">Live page</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {live
                                    ? 'On — attendees see “happening now”, counts and sponsors in the app.'
                                    : 'Off — the app shows the normal event page. Turn this on when doors open.'}
                            </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                            <FormControlLabel
                                control={<Switch checked={live} onChange={(e) => setLive(e.target.checked)} />}
                                label={live ? 'Live' : 'Off'}
                            />
                            <Button variant="outlined" startIcon={<OpenInNewIcon />}
                                href={`/event/display.html?event=${id}`}
                                target="_blank" rel="noopener noreferrer">
                                Open venue display
                            </Button>
                        </Stack>
                    </Stack>

                    <TextField
                        fullWidth
                        size="small"
                        sx={{ mt: 2 }}
                        label="Banner message (optional)"
                        placeholder="e.g. Lunch is served in the Exhibit Hall"
                        defaultValue={event?.live_message || ''}
                        onBlur={(e) => saveLiveMessage(e.target.value)}
                        helperText="Saved when you click away. Shows on the app live panel and the venue display."
                    />
                </CardContent>
            </Card>

            <Divider textAlign="left" sx={{ mb: 2 }}>
                <Typography variant="caption" color="text.secondary">On air now</Typography>
            </Divider>

            {!live && (
                <Alert severity="info" sx={{ mb: 2 }}>
                    The live page is off, so attendees are seeing the normal event page. These
                    announcements will go out on the live panel as soon as you switch it on.
                </Alert>
            )}

            {onAir.length === 0 ? (
                <Alert severity="info" icon={false}>
                    No published announcements. The live panel and the venue display carry up to five
                    of them — room changes, delays, “lunch is served”.{' '}
                    <Button size="small" onClick={() => navigate(`/events/${id}/updates`)}>
                        Write one under Updates
                    </Button>
                </Alert>
            ) : (
                <>
                    <Stack spacing={1.25}>
                        {onAir.map((n) => (
                            <Card key={n.id} variant="outlined">
                                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                                    <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
                                        <Typography variant="subtitle2">{n.title || 'Untitled'}</Typography>
                                        {n.is_pinned && <Chip size="small" color="primary" label="Pinned" sx={{ height: 18, fontSize: 10 }} />}
                                        {n.audience_type && n.audience_type !== 'all' && (
                                            <Chip size="small" variant="outlined" label={n.audience_type} sx={{ height: 18, fontSize: 10 }} />
                                        )}
                                    </Stack>
                                    <Typography variant="body2" color="text.secondary">{n.body}</Typography>
                                </CardContent>
                            </Card>
                        ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                        Read-only — this is the same five the live payload carries, pinned first.
                        Write and edit them under{' '}
                        <Button size="small" sx={{ p: 0, minWidth: 0, verticalAlign: 'baseline' }}
                            onClick={() => navigate(`/events/${id}/updates`)}>Updates</Button>.
                    </Typography>
                </>
            )}
        </Box>
    );
}
