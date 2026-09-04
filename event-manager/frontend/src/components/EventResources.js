import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack,
    IconButton, Chip, Divider, Alert, Link,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { getEventResources, createEventResource, deleteEventResource, updateEventResource } from '../utils/api';

// Downloadable files / links the organiser publishes for an event — programme
// PDF, venue map, exhibitor kit, hotel link. Attendees see these under the
// app's Info tab. Structural: every event gets it, no code for a new one.
function EventResources() {
    const { id } = useParams();
    const [items, setItems] = useState([]);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [url, setUrl] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        getEventResources(id).then((r) => setItems(r.data || [])).catch(() => setItems([]));
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!title.trim() || !url.trim()) return;
        setError(null);
        setSaving(true);
        try {
            await createEventResource(id, { title: title.trim(), description: description.trim(), url: url.trim() });
            setTitle('');
            setDescription('');
            setUrl('');
            load();
        } catch (e) {
            setError(e.response?.data?.detail || 'Could not save this resource.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async (rid) => { await deleteEventResource(rid).catch(() => {}); load(); };
    const togglePublish = async (r) => { await updateEventResource(r.id, { is_published: !r.is_published }).catch(() => {}); load(); };

    return (
        <Box sx={{ maxWidth: 720 }}>
            <Typography variant="h4" gutterBottom>Resources</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Files and links attendees can open — programme PDF, venue map, hotel booking,
                exhibitor kit. These appear under the <strong>Info</strong> tab in the app.
            </Typography>

            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Stack spacing={2}>
                        <TextField
                            label="Title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            fullWidth
                            placeholder="e.g. Programme (PDF)"
                        />
                        <TextField
                            label="Link / file URL"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            fullWidth
                            placeholder="https://…"
                            helperText="Paste a public link to the file or page."
                        />
                        <TextField
                            label="Short description (optional)"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            fullWidth
                        />
                        {error && <Alert severity="error">{error}</Alert>}
                        <Button variant="contained" onClick={add} disabled={saving || !title.trim() || !url.trim()}>
                            {saving ? 'Adding…' : 'Add resource'}
                        </Button>
                    </Stack>
                </CardContent>
            </Card>

            <Typography variant="overline" color="text.secondary">
                Published · {items.length}
            </Typography>
            {items.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Nothing added yet.
                </Typography>
            ) : (
                <Card variant="outlined">
                    <CardContent sx={{ py: 1 }}>
                        {items.map((r, i) => (
                            <Box key={r.id}>
                                {i > 0 && <Divider sx={{ my: 1 }} />}
                                <Stack direction="row" alignItems="flex-start" spacing={1}>
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography variant="subtitle2">{r.title}</Typography>
                                        {r.description && (
                                            <Typography variant="body2" color="text.secondary">
                                                {r.description}
                                            </Typography>
                                        )}
                                        {r.url && (
                                            <Link href={r.url} target="_blank" rel="noopener" variant="body2"
                                                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                                                {r.url} <OpenInNewIcon sx={{ fontSize: 14 }} />
                                            </Link>
                                        )}
                                    </Box>
                                    <Chip
                                        size="small"
                                        label={r.is_published ? 'Live' : 'Hidden'}
                                        color={r.is_published ? 'success' : 'default'}
                                        variant={r.is_published ? 'filled' : 'outlined'}
                                        onClick={() => togglePublish(r)}
                                        sx={{ cursor: 'pointer' }}
                                    />
                                    <IconButton size="small" aria-label={`Delete ${r.title}`} onClick={() => remove(r.id)}>
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                </Stack>
                            </Box>
                        ))}
                    </CardContent>
                </Card>
            )}
        </Box>
    );
}

export default EventResources;
