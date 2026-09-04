import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack, MenuItem,
    IconButton, Chip, Divider, Alert, FormControlLabel, Checkbox, Link,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { getTicketMappings, createTicketMapping, deleteTicketMapping, getTicketTypes } from '../utils/api';

// Ticket mappings are the ONE source of truth that makes registration dynamic:
// a GHL product id resolves to an event + pass/tier here, and BOTH the instant
// Smart Webhook and the 60-second reconciler read this table. For upgrades, the
// checkout URL + price id here are what the attendee app shows and links to — so
// a whole new event (base tickets AND upgrades) is wired up here, no code/SSH.
function TicketMappings() {
    const { id } = useParams();
    const [rows, setRows] = useState([]);
    const [types, setTypes] = useState([]);
    const [productId, setProductId] = useState('');
    const [priceId, setPriceId] = useState('');
    const [ticketTypeId, setTicketTypeId] = useState('');
    const [label, setLabel] = useState('');
    const [checkoutUrl, setCheckoutUrl] = useState('');
    const [isUpgrade, setIsUpgrade] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        getTicketMappings(id).then((r) => setRows(r.data || [])).catch(() => setRows([]));
        getTicketTypes(id).then((r) => setTypes(r.data || [])).catch(() => setTypes([]));
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const typeName = (tid) => {
        const t = types.find((x) => x.id === tid);
        return t ? `${t.name}${t.code ? ` (${t.code})` : ''}` : `tier #${tid}`;
    };

    const validUrl = (u) => {
        if (!u) return true;
        try { return new URL(u).protocol === 'https:'; } catch (_) { return false; }
    };

    const reset = () => {
        setProductId(''); setPriceId(''); setTicketTypeId('');
        setLabel(''); setCheckoutUrl(''); setIsUpgrade(false);
    };

    const add = async () => {
        const pid = productId.trim();
        const url = checkoutUrl.trim();
        setError(null);
        if (!pid) { setError('Enter the GHL product ID.'); return; }
        if (!ticketTypeId) { setError('Choose which pass/tier this product grants.'); return; }
        if (rows.some((r) => r.external_product_id === pid)) {
            setError('That GHL product is already mapped for this event. Remove the existing mapping first.');
            return;
        }
        if (url && !validUrl(url)) { setError('The checkout URL must be a full https:// link.'); return; }
        if (isUpgrade && !url) {
            setError('An upgrade needs a checkout URL — that is the link the attendee app opens to pay for it.');
            return;
        }
        setSaving(true);
        try {
            await createTicketMapping(id, {
                external_product_id: pid,
                external_price_id: priceId.trim() || null,
                ticket_type_id: Number(ticketTypeId),
                provider: 'ghl',
                is_upgrade: isUpgrade,
                checkout_url: url || null,
                label: label.trim() || null,
            });
            reset();
            load();
        } catch (e) {
            setError(e.response?.data?.detail || 'Could not save this mapping.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async (mid) => { await deleteTicketMapping(mid).catch(() => {}); load(); };

    return (
        <Box sx={{ maxWidth: 760 }}>
            <Typography variant="h4" gutterBottom>Ticket mappings</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Map a <strong>GHL product</strong> to a <strong>pass/tier</strong> in this event. This is the single
                source of truth the <strong>instant webhook</strong> and the <strong>60-second reconciler</strong> use,
                and — for upgrades — what the attendee app shows and links to. Base tickets need only the product and
                tier; <strong>upgrades</strong> also need a checkout URL. Price is read live from GHL, never typed here.
            </Typography>

            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Stack spacing={2}>
                        <TextField
                            label="GHL product ID"
                            value={productId}
                            onChange={(e) => setProductId(e.target.value)}
                            fullWidth
                            placeholder="e.g. 69b461f512895312b36276de"
                            helperText="The product's id in GoHighLevel (Payments → Products)."
                        />
                        <TextField
                            label="GHL price ID (optional)"
                            value={priceId}
                            onChange={(e) => setPriceId(e.target.value)}
                            fullWidth
                            placeholder="e.g. 69b461f5128953513b627716"
                            helperText="The price id for this product. Used to show the live GHL price in the app."
                        />
                        <TextField
                            select
                            label="Grants pass / tier"
                            value={ticketTypeId}
                            onChange={(e) => setTicketTypeId(e.target.value)}
                            fullWidth
                            helperText={types.length ? 'Which ticket type a buyer of this product receives.' : 'Create ticket types for this event first (Setup).'}
                        >
                            {types.map((t) => (
                                <MenuItem key={t.id} value={t.id}>{t.name}{t.code ? ` (${t.code})` : ''}</MenuItem>
                            ))}
                        </TextField>
                        <FormControlLabel
                            control={<Checkbox checked={isUpgrade} onChange={(e) => setIsUpgrade(e.target.checked)} />}
                            label="This is an upgrade (raises the attendee's pass; shown in-app to eligible attendees)"
                        />
                        <TextField
                            label={isUpgrade ? 'Checkout URL (required for upgrades)' : 'Checkout URL (optional)'}
                            value={checkoutUrl}
                            onChange={(e) => setCheckoutUrl(e.target.value)}
                            fullWidth
                            placeholder="https://…/product/…"
                            error={Boolean(checkoutUrl) && !validUrl(checkoutUrl)}
                            helperText="The GHL checkout the attendee app opens to buy this. Must be a full https:// link."
                        />
                        <TextField
                            label="Label (optional)"
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            fullWidth
                            placeholder="e.g. Upgrade to VIP"
                            helperText="Shown for your reference in this list (and as a fallback name in-app)."
                        />
                        {error && <Alert severity="error">{error}</Alert>}
                        <Button variant="contained" onClick={add} disabled={saving || !productId.trim() || !ticketTypeId}>
                            {saving ? 'Adding…' : 'Add mapping'}
                        </Button>
                    </Stack>
                </CardContent>
            </Card>

            <Typography variant="overline" color="text.secondary">
                Mapped products · {rows.length}
            </Typography>
            {rows.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    No products mapped yet. Until you add one, sales for this event only arrive if mapped elsewhere.
                </Typography>
            ) : (
                <Card variant="outlined">
                    <CardContent sx={{ py: 1 }}>
                        {rows.map((r, i) => (
                            <Box key={r.id}>
                                {i > 0 && <Divider sx={{ my: 1 }} />}
                                <Stack direction="row" alignItems="flex-start" spacing={1}>
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography variant="subtitle2" sx={{ wordBreak: 'break-all' }}>
                                            {r.label || r.external_product_id}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                                            <code>{r.external_product_id}</code> → {typeName(r.ticket_type_id)}
                                        </Typography>
                                        {r.checkout_url && (
                                            <Link href={r.checkout_url} target="_blank" rel="noopener noreferrer"
                                                variant="caption" sx={{ wordBreak: 'break-all' }}>
                                                {r.checkout_url}
                                            </Link>
                                        )}
                                        {r.is_upgrade && !r.checkout_url && (
                                            <Typography variant="caption" color="warning.main">
                                                Upgrade has no checkout URL — it will not appear in the app.
                                            </Typography>
                                        )}
                                    </Box>
                                    {r.is_upgrade && <Chip size="small" variant="outlined" label="Upgrade" />}
                                    <Chip
                                        size="small"
                                        label={r.is_active ? 'Active' : 'Inactive'}
                                        color={r.is_active ? 'success' : 'default'}
                                        variant={r.is_active ? 'filled' : 'outlined'}
                                    />
                                    <IconButton size="small" aria-label={`Delete mapping ${r.external_product_id}`} onClick={() => remove(r.id)}>
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

export default TicketMappings;
