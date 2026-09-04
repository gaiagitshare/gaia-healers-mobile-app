import React, { useState } from 'react';
import {
    Alert, AlertTitle, Box, Button, Chip, Dialog, DialogActions, DialogContent,
    DialogTitle, Divider, LinearProgress, Stack, Table, TableBody, TableCell,
    TableHead, TableRow, Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import { importCsv } from '../utils/api';

// The columns each entity accepts, and which one identifies a row. The required
// column is the natural key the backend matches on, which is what makes a
// re-import update rather than duplicate.
export const IMPORT_SCHEMA = {
    speakers: {
        label: 'Speakers',
        required: ['name'],
        optional: ['role', 'company', 'bio', 'photo_url'],
        example: [
            ['name', 'role', 'company', 'bio', 'photo_url'],
            ['Ada Lovelace', 'Analytical Engines', 'Example Institute', 'Short biography here.', 'https://example.org/ada.jpg'],
        ],
    },
    sessions: {
        label: 'Sessions',
        required: ['title'],
        optional: ['description', 'session_type', 'track', 'room', 'start_time', 'end_time'],
        example: [
            ['title', 'session_type', 'track', 'room', 'start_time', 'end_time', 'description'],
            ['Opening Keynote', 'Keynote', 'Main Stage', 'Grand Ballroom', '2028-06-01T09:00:00', '2028-06-01T10:30:00', 'Welcome and opening.'],
        ],
        note: 'Times are venue-local, in the event’s own timezone, formatted YYYY-MM-DDTHH:MM:SS.',
    },
    exhibitors: {
        label: 'Exhibitors',
        required: ['company_name'],
        optional: ['booth_number', 'contact_email', 'contact_phone', 'category', 'website', 'logo_url', 'description'],
        example: [
            ['company_name', 'booth_number', 'category', 'website', 'contact_email', 'description'],
            ['Example Devices', 'A12', 'Devices', 'https://example.org', 'hello@example.org', 'What they show at the booth.'],
        ],
    },
    sponsors: {
        label: 'Sponsors',
        required: ['name'],
        optional: ['tier', 'logo_url', 'website', 'blurb'],
        example: [
            ['name', 'tier', 'website', 'logo_url', 'blurb'],
            ['Example Partner', 'gold', 'https://example.org', 'https://example.org/logo.png', 'One line about them.'],
        ],
        note: 'Tier is free text; headline, gold, silver and partner are the ones the app orders by.',
    },
};

const toCsv = (rows) => rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');

function NameList({ items }) {
    if (!items || !items.length) return <Typography color="text.secondary">None</Typography>;
    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
            {items.map((name) => <Chip key={name} size="small" label={name} />)}
        </Box>
    );
}

/**
 * Generic CSV import for one entity of one event.
 *
 * Nothing is written until the operator confirms: the file is sent once as a
 * dry run, the result of that exact file is shown, and only then is it sent
 * again to commit. The event id comes from the caller, so the dialog can never
 * write into an event other than the one on screen.
 */
function ImportCsvDialog({ open, onClose, eventId, entity }) {
    const schema = IMPORT_SCHEMA[entity];
    const [file, setFile] = useState(null);
    const [preview, setPreview] = useState(null);
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const reset = () => {
        setFile(null); setPreview(null); setResult(null); setBusy(false); setError('');
    };

    const close = () => { reset(); onClose(); };

    const chooseFile = (event) => {
        const chosen = event.target.files?.[0] || null;
        setFile(chosen); setPreview(null); setResult(null); setError('');
    };

    const runPreview = async () => {
        if (!file) return;
        setBusy(true); setError('');
        try {
            const response = await importCsv(eventId, entity, file, true);
            setPreview(response.data);
        } catch (err) {
            setError(err?.response?.data?.detail || 'Could not read that file.');
        } finally {
            setBusy(false);
        }
    };

    const commit = async () => {
        setBusy(true); setError('');
        try {
            const response = await importCsv(eventId, entity, file, false);
            setResult(response.data);
        } catch (err) {
            setError(err?.response?.data?.detail || 'The import failed.');
        } finally {
            setBusy(false);
        }
    };

    const downloadTemplate = () => {
        const blob = new Blob([toCsv(schema.example)], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${entity}-template.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    if (!schema) return null;

    return (
        <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth>
            <DialogTitle>Import {schema.label} from CSV</DialogTitle>
            <DialogContent dividers>
                {busy && <LinearProgress sx={{ mb: 2 }} />}
                {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

                {/* ---------- step 1: what the file should contain ---------- */}
                {!result && (
                    <Box sx={{ mb: 3 }}>
                        <Typography variant="subtitle2" gutterBottom>Accepted columns</Typography>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                            {schema.required.map((column) => (
                                <Chip key={column} size="small" color="primary" label={`${column} · required`} />
                            ))}
                            {schema.optional.map((column) => (
                                <Chip key={column} size="small" variant="outlined" label={column} />
                            ))}
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                            Column order does not matter and unknown columns are ignored.
                            Rows are matched on <strong>{schema.required[0]}</strong> within this event, so
                            importing a corrected file updates the same records instead of duplicating them.
                            {schema.note ? ` ${schema.note}` : ''}
                        </Typography>
                        <Button size="small" startIcon={<DownloadIcon />} onClick={downloadTemplate} sx={{ mt: 1 }}>
                            Download example template
                        </Button>
                    </Box>
                )}

                {/* ---------- step 2: choose a file ---------- */}
                {!result && (
                    <>
                        <Divider sx={{ mb: 2 }} />
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                            <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                                Choose CSV
                                <input type="file" accept=".csv,text/csv" hidden onChange={chooseFile} />
                            </Button>
                            <Typography variant="body2" color="text.secondary">
                                {file ? file.name : 'No file chosen'}
                            </Typography>
                            {file && !preview && (
                                <Button variant="contained" onClick={runPreview} disabled={busy}>
                                    Preview changes
                                </Button>
                            )}
                        </Stack>
                    </>
                )}

                {/* ---------- step 3: dry-run preview ---------- */}
                {preview && !result && (
                    <Box sx={{ mt: 3 }}>
                        <Alert severity="info" sx={{ mb: 2 }}>
                            <AlertTitle>Nothing has been saved yet</AlertTitle>
                            This is what importing <strong>{file?.name}</strong> would do. Review it, then confirm.
                        </Alert>
                        <Table size="small" sx={{ mb: 2 }}>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Rows read</TableCell>
                                    <TableCell>Create</TableCell>
                                    <TableCell>Update</TableCell>
                                    <TableCell>Skip</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                <TableRow>
                                    <TableCell>{preview.totals.rows}</TableCell>
                                    <TableCell>{preview.totals.create}</TableCell>
                                    <TableCell>{preview.totals.update}</TableCell>
                                    <TableCell>{preview.totals.skip}</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>

                        <Typography variant="subtitle2">Would create</Typography>
                        <NameList items={preview.would_create} />
                        <Typography variant="subtitle2" sx={{ mt: 2 }}>Would update</Typography>
                        <NameList items={preview.would_update} />

                        {preview.skipped?.length > 0 && (
                            <Alert severity="warning" sx={{ mt: 2 }}>
                                <AlertTitle>Skipped rows</AlertTitle>
                                {preview.skipped.map((line) => <div key={line}>{line}</div>)}
                            </Alert>
                        )}
                        {preview.warnings?.length > 0 && (
                            <Alert severity="warning" sx={{ mt: 2 }}>
                                <AlertTitle>Warnings — these rows import, but are incomplete</AlertTitle>
                                {preview.warnings.map((line) => <div key={line}>{line}</div>)}
                            </Alert>
                        )}
                        <Alert severity="info" sx={{ mt: 2 }}>
                            Imported records arrive as drafts. Nothing appears in the Gaia app until you publish it.
                        </Alert>
                    </Box>
                )}

                {/* ---------- step 4: result ---------- */}
                {result && (
                    <Box>
                        <Alert severity="success" sx={{ mb: 2 }}>
                            <AlertTitle>Import complete</AlertTitle>
                            {result.totals.create} created, {result.totals.update} updated,
                            {' '}{result.totals.skip} skipped — all as drafts.
                        </Alert>
                        <Typography variant="subtitle2">Created</Typography>
                        <NameList items={result.created} />
                        <Typography variant="subtitle2" sx={{ mt: 2 }}>Updated</Typography>
                        <NameList items={result.updated} />
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {!result && <Button onClick={close} disabled={busy}>Cancel</Button>}
                {preview && !result && (
                    <Button variant="contained" onClick={commit} disabled={busy}>
                        Confirm import ({preview.totals.create + preview.totals.update} records)
                    </Button>
                )}
                {result && <Button variant="contained" onClick={close}>Done</Button>}
            </DialogActions>
        </Dialog>
    );
}

export default ImportCsvDialog;
