import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Alert, Box, Button, Card, CardContent, Chip, CircularProgress, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { ecAttention, ecAttentionMark } from '../utils/api';
import { errText, gst, SeverityChip } from './EmailCenterShared';

const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']];

function Item({ eventId, item, me, onOpen, onSaved }) {
    const navigate = useNavigate();
    const [form, setForm] = useState({ status: item.status || 'open', assigned_to: item.assigned_to || '', note: item.note || '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { setForm({ status: item.status || 'open', assigned_to: item.assigned_to || '', note: item.note || '' }); }, [item]);
    const dirty = form.status !== (item.status || 'open') || form.assigned_to !== (item.assigned_to || '') || form.note !== (item.note || '');
    const save = () => {
        setBusy(true);
        ecAttentionMark(eventId, item.key, form).then(onSaved).catch((e) => setError(errText(e))).finally(() => setBusy(false));
    };
    const link = item.link || {};
    return (
        <Card variant="outlined" sx={{ opacity: item.status === 'resolved' ? 0.7 : 1 }}>
            <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 0.5 }}>
                    <SeverityChip s={item.severity} />
                    <Chip size="small" variant="outlined" label={(STATUS.find(([k]) => k === item.status) || [null, item.status])[1]} />
                    {item.related && <Typography variant="body2" color="text.secondary">{item.related}</Typography>}
                </Stack>
                <Typography variant="body1" fontWeight={600}>{item.problem}</Typography>
                {item.recommended_action && <Typography variant="body2" sx={{ mt: 0.5 }}><b>What to do:</b> {item.recommended_action}</Typography>}
                {item.updated_by && <Typography variant="caption" color="text.secondary">Updated by {item.updated_by} · {gst(item.updated_at)}</Typography>}
                {error && <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError('')}>{error}</Alert>}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }} alignItems={{ sm: 'center' }}>
                    {me?.review ? <>
                        <TextField select size="small" label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} sx={{ minWidth: 140 }}>
                            {STATUS.map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
                        </TextField>
                        <TextField size="small" label="Assigned to" value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} sx={{ minWidth: 160 }} />
                        <TextField size="small" label="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} sx={{ flex: 1 }} />
                        <Button variant="contained" size="small" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
                    </> : (
                        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                            {item.assigned_to ? `Assigned to ${item.assigned_to}. ` : ''}{item.note || ''}
                        </Typography>
                    )}
                    {link.booking && <Button size="small" variant="outlined" onClick={() => onOpen('tickets', { openKey: link.booking })}>Open</Button>}
                    {!link.booking && link.exhibitor && me?.exhibitors && <Button size="small" variant="outlined" onClick={() => onOpen('exhibitors', { focusId: link.exhibitor })}>Open</Button>}
                    {link.reconcile_issue && me?.reconcile && (
                        <Button size="small" onClick={() => navigate(`/events/${eventId}/reconcile`)}>Open in Ticket Reconciliation</Button>)}
                </Stack>
            </CardContent>
        </Card>
    );
}

export default function EmailCenterAttention({ eventId, me, goTab }) {
    const [items, setItems] = useState(null);
    const [error, setError] = useState('');
    const [showResolved, setShowResolved] = useState(false);
    const load = useCallback(() => ecAttention(eventId).then((r) => { setItems(r.data.items || []); setError(''); }).catch((e) => setError(errText(e))), [eventId]);
    useEffect(() => { load(); }, [load]);

    if (!items) return error ? <Alert severity="error">{error}</Alert> : <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>;
    const sorted = [...items].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || ((a.status === 'resolved') - (b.status === 'resolved')));
    const shown = sorted.filter((i) => showResolved || i.status !== 'resolved');
    const counts = items.reduce((acc, i) => { if (i.status !== 'resolved') acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {});
    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
                {Object.keys(ORDER).map((s) => counts[s] ? <Chip key={s} size="small" label={`${s[0].toUpperCase() + s.slice(1)}: ${counts[s]}`} color={{ critical: 'error', high: 'warning', medium: 'info', low: 'default' }[s]} /> : null)}
                <Button size="small" onClick={() => setShowResolved((v) => !v)}>{showResolved ? 'Hide resolved' : 'Show resolved'}</Button>
                <Typography variant="caption" color="text.secondary">Items disappear by themselves once the underlying problem is fixed.</Typography>
            </Stack>
            <Stack spacing={1}>
                {shown.map((i) => <Item key={i.key} eventId={eventId} item={i} me={me} onOpen={goTab} onSaved={load} />)}
                {!shown.length && <Alert severity="success">Nothing needs attention right now.</Alert>}
            </Stack>
        </Box>
    );
}
