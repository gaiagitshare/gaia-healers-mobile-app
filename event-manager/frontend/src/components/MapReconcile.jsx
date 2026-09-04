import React, { useEffect, useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
    MenuItem, FormControlLabel, Checkbox, Box, Typography, Alert, Divider,
    CircularProgress,
} from '@mui/material';
import { mapReconcilePreview, mapReconcileApply, getTicketTypes } from '../utils/api';

/**
 * Map an unmapped GHL product to a ticket type, and replay its history.
 *
 * The rule this screen exists to protect: a product becomes event access only
 * when a human maps it, and that human sees the consequences BEFORE approving
 * them. So the flow is always preview -> read -> confirm, never one button that
 * both maps and creates.
 *
 * Matching is on the immutable product id. The name is shown because staff
 * recognise it, and is never what anything is matched on.
 */
export default function MapReconcile({ eventId, open, onClose, productId, productName, onDone }) {
    const [ticketTypes, setTicketTypes] = useState([]);
    const [ticketTypeId, setTicketTypeId] = useState('');
    const [isUpgrade, setIsUpgrade] = useState(false);
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (!open) return;
        setPreview(null); setResult(null); setError(''); setTicketTypeId(''); setIsUpgrade(false);
        getTicketTypes(eventId).then((r) => setTicketTypes(r.data || [])).catch(() => setTicketTypes([]));
    }, [open, eventId]);

    const runPreview = async () => {
        setBusy(true); setError(''); setPreview(null);
        try {
            const r = await mapReconcilePreview(eventId, {
                product_id: productId, ticket_type_id: ticketTypeId || null, is_upgrade: isUpgrade,
            });
            setPreview(r.data.preview);
        } catch (e) {
            setError(e?.response?.data?.detail || 'Could not read this product’s sales from GHL.');
        } finally { setBusy(false); }
    };

    const runApply = async () => {
        setBusy(true); setError('');
        try {
            const r = await mapReconcileApply(eventId, {
                product_id: productId, ticket_type_id: ticketTypeId, is_upgrade: isUpgrade,
            });
            setResult(r.data);
            if (onDone) onDone();
        } catch (e) {
            setError(e?.response?.data?.detail || 'The replay did not complete.');
        } finally { setBusy(false); }
    };

    const Row = ({ label, value, strong }) => (
        <Box display="flex" justifyContent="space-between" gap={2} sx={{ py: 0.4 }}>
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <Typography variant="body2" sx={{ fontWeight: strong ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>
                {value}
            </Typography>
        </Box>
    );

    return (
        <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Map &amp; Reconcile</DialogTitle>
            <DialogContent dividers>
                <Typography variant="body2" sx={{ mb: 0.5 }}>{productName || 'Unnamed product'}</Typography>
                <Typography variant="caption" color="text.secondary"
                    sx={{ fontFamily: 'monospace', display: 'block', mb: 2 }}>
                    {productId}
                </Typography>

                {!result && (
                    <>
                        <TextField select fullWidth size="small" label="Gaia ticket type this product grants"
                            value={ticketTypeId} onChange={(e) => { setTicketTypeId(e.target.value); setPreview(null); }}
                            sx={{ mb: 1.5 }}>
                            {ticketTypes.map((t) => (
                                <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
                            ))}
                        </TextField>

                        <FormControlLabel
                            control={<Checkbox checked={isUpgrade}
                                onChange={(e) => { setIsUpgrade(e.target.checked); setPreview(null); }} />}
                            label="This product is an upgrade, not a ticket"
                        />
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
                            An upgrade changes someone&rsquo;s tier. It adds revenue, and it must never add an
                            attendee or a paid seat.
                        </Typography>

                        <Button variant="outlined" onClick={runPreview}
                            disabled={busy || !ticketTypeId} startIcon={busy && !preview ? <CircularProgress size={14} /> : null}>
                            {busy && !preview ? 'Reading GHL…' : 'Preview impact'}
                        </Button>
                    </>
                )}

                {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

                {preview && !result && (
                    <Box sx={{ mt: 2 }}>
                        <Divider sx={{ mb: 1.5 }} />
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>What this would do</Typography>
                        <Row label="GHL product" value={preview.product_name || '—'} />
                        <Row label="Gaia ticket type" value={preview.ticket_type_name || '—'} />
                        <Row label="Successful historical payments" value={preview.successful_payments} />
                        <Row label="Seats represented" value={preview.total_seats} />
                        <Row label="Unique buyers" value={preview.unique_buyers} />
                        <Row label="Already represented in Gaia" value={preview.already_in_gaia} />
                        <Row label="Expected to create or update" value={preview.expected_to_create_or_update} strong />
                        <Divider sx={{ my: 1 }} />
                        <Row label="Excluded — pending or not paid" value={preview.excluded.not_paid_or_pending} />
                        <Row label="Excluded — refunded or reversed" value={preview.excluded.refunded_or_reversed} />
                        <Alert severity={preview.is_upgrade ? 'info' : 'warning'} sx={{ mt: 1.5 }}>
                            {preview.note}
                        </Alert>
                    </Box>
                )}

                {result && (
                    <Alert severity={result.failed ? 'warning' : 'success'} sx={{ mt: 1 }}>
                        <strong>Done.</strong> Created {result.created}, updated {result.updated},
                        skipped {result.skipped_refunded_or_blocked}, failed {result.failed}.
                        {result.failed > 0 && (
                            <Box sx={{ mt: 1 }}>
                                {result.failures.slice(0, 5).map((f) => (
                                    <Typography key={f.reference} variant="caption" display="block">
                                        {f.reference}: {f.error}
                                    </Typography>
                                ))}
                            </Box>
                        )}
                        <Typography variant="caption" display="block" sx={{ mt: 1 }}>
                            Running this again is safe: everything is keyed on the payment reference, so a
                            second run finds it already there and creates nothing.
                        </Typography>
                    </Alert>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
                {!result && (
                    <Button variant="contained" onClick={runApply} disabled={busy || !preview || !ticketTypeId}
                        startIcon={busy && preview ? <CircularProgress size={14} /> : null}>
                        Map &amp; Reconcile{preview ? ` (${preview.expected_to_create_or_update})` : ''}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
}
