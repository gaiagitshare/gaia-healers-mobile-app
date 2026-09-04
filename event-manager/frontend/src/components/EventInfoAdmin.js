import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack,
    FormControl, InputLabel, Select, MenuItem, IconButton, Chip, Divider, Alert,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { getEventInfo, createEventInfo, deleteEventInfo, updateEventInfo } from '../utils/api';

// FAQ / Help / Info cards for one event. Attendees see these under the app's
// "Info" tab. Every event gets this, so the section is structural, not per-event.
const SECTIONS = [
    { value: 'faq', label: 'FAQ (parking, Wi-Fi, what to bring…)' },
    { value: 'help', label: 'Help / Support (need help?, lost & found…)' },
    { value: 'info', label: 'Good to know (general info)' },
];
const SECTION_LABEL = { faq: 'FAQ', help: 'Help / Support', info: 'Good to know' };

function EventInfoAdmin() {
    const { id } = useParams();
    const [cards, setCards] = useState([]);
    const [section, setSection] = useState('faq');
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        getEventInfo(id).then((r) => setCards(r.data || [])).catch(() => setCards([]));
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!title.trim()) return;
        setError(null);
        setSaving(true);
        try {
            await createEventInfo(id, { section, title: title.trim(), body: body.trim() });
            setTitle('');
            setBody('');
            load();
        } catch (e) {
            setError(e.response?.data?.detail || 'Could not save this card.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async (cardId) => {
        await deleteEventInfo(cardId).catch(() => {});
        load();
    };

    const togglePublish = async (card) => {
        await updateEventInfo(card.id, { is_published: !card.is_published }).catch(() => {});
        load();
    };

    const grouped = SECTIONS.map((s) => ({
        ...s,
        items: cards.filter((c) => (c.section || 'faq') === s.value),
    }));

    return (
        <Box sx={{ maxWidth: 720 }}>
            <Typography variant="h4" gutterBottom>FAQ &amp; Info</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Answers attendees can find themselves — parking, Wi-Fi, what to bring, how to get
                help. These appear under the <strong>Info</strong> tab in the app.
            </Typography>

            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Stack spacing={2}>
                        <FormControl fullWidth>
                            <InputLabel id="sec-label">Section</InputLabel>
                            <Select
                                labelId="sec-label"
                                label="Section"
                                value={section}
                                onChange={(e) => setSection(e.target.value)}
                            >
                                {SECTIONS.map((s) => (
                                    <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            label="Title / question"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            fullWidth
                            placeholder="e.g. Parking & Directions"
                        />
                        <TextField
                            label="Answer / details"
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            fullWidth
                            multiline
                            minRows={2}
                        />
                        {error && <Alert severity="error">{error}</Alert>}
                        <Button variant="contained" onClick={add} disabled={saving || !title.trim()}>
                            {saving ? 'Adding…' : 'Add card'}
                        </Button>
                    </Stack>
                </CardContent>
            </Card>

            {grouped.map((g) => (
                <Box key={g.value} sx={{ mb: 3 }}>
                    <Typography variant="overline" color="text.secondary">
                        {SECTION_LABEL[g.value]} · {g.items.length}
                    </Typography>
                    {g.items.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            Nothing here yet.
                        </Typography>
                    ) : (
                        <Card variant="outlined">
                            <CardContent sx={{ py: 1 }}>
                                {g.items.map((c, i) => (
                                    <Box key={c.id}>
                                        {i > 0 && <Divider sx={{ my: 1 }} />}
                                        <Stack direction="row" alignItems="flex-start" spacing={1}>
                                            <Box sx={{ flex: 1 }}>
                                                <Typography variant="subtitle2">{c.title}</Typography>
                                                <Typography variant="body2" color="text.secondary">
                                                    {c.body}
                                                </Typography>
                                            </Box>
                                            <Chip
                                                size="small"
                                                label={c.is_published ? 'Live' : 'Hidden'}
                                                color={c.is_published ? 'success' : 'default'}
                                                variant={c.is_published ? 'filled' : 'outlined'}
                                                onClick={() => togglePublish(c)}
                                                sx={{ cursor: 'pointer' }}
                                            />
                                            <IconButton
                                                size="small"
                                                aria-label={`Delete ${c.title}`}
                                                onClick={() => remove(c.id)}
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </Stack>
                                    </Box>
                                ))}
                            </CardContent>
                        </Card>
                    )}
                </Box>
            ))}
        </Box>
    );
}

export default EventInfoAdmin;
