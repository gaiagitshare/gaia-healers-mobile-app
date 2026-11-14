import React, { useCallback, useEffect, useState } from 'react';
import {
    Paper, Typography, Stack, Chip, Button, TextField, MenuItem, Alert, Collapse,
} from '@mui/material';
import { getLeadsPayments, assignLeadsPayment } from '../utils/api';

// Payments for the scanned-leads product (GHL checkout, $199 for ELEVATE 2026).
// A clear payment opens its stand by itself; this panel is for the rest: a
// buyer email that matches no stand (or two), and refunds of an open stand.
const STATE = {
    unlocked: { label: 'Unlocked', color: 'success' },
    stand_already_open: { label: 'Stand already open', color: 'default' },
    unmatched: { label: 'No stand with this email', color: 'warning' },
    ambiguous: { label: 'Two stands share this email', color: 'warning' },
    refunded_still_open: { label: 'Refunded, still unlocked', color: 'error' },
    refunded: { label: 'Refunded', color: 'default' },
    not_paid: { label: 'Not paid', color: 'default' },
    test_mode: { label: 'Test payment', color: 'default' },
};

export default function LeadsPayments({ eventId, stands, onChanged }) {
    const [data, setData] = useState(null);
    const [open, setOpen] = useState(false);
    const [pick, setPick] = useState({});
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(() => {
        getLeadsPayments(eventId).then((r) => setData(r.data)).catch(() => setData(null));
    }, [eventId]);
    useEffect(() => { load(); }, [load]);

    if (!data || (!data.configured && !(data.payments || []).length)) return null;
    const rows = data.payments || [];
    const unlockedCount = rows.filter((r) => r.exhibitor).length;
    const lockable = (stands || []).filter((s) => s.can_scan_leads && !s.full_list_access)
        .sort((a, b) => (a.company_name || '').localeCompare(b.company_name || ''));

    const assign = (r) => {
        setBusy(r.id); setError('');
        assignLeadsPayment(eventId, r.id, pick[r.id])
            .then(() => { load(); onChanged && onChanged(); })
            .catch((e) => setError(e?.response?.data?.detail || 'Could not assign this payment.'))
            .finally(() => setBusy(null));
    };

    return (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                <Typography variant="subtitle2">Leads payments</Typography>
                <Typography variant="body2" color="text.secondary">
                    {data.price ? `$${data.price} each · ` : ''}{rows.length} paid online · {unlockedCount} opened a stand
                </Typography>
                {data.attention > 0 && <Chip size="small" color="warning" label={`${data.attention} need you`} />}
                <Button size="small" sx={{ ml: 'auto' }} onClick={() => setOpen(!open)}>
                    {open ? 'Hide' : 'Show'}
                </Button>
            </Stack>
            {!data.checkout_url && (
                <Typography variant="caption" color="text.secondary">
                    No checkout link set yet, so stands are told to ask at the registration desk.
                </Typography>
            )}
            <Collapse in={open || data.attention > 0}>
                {error && <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError('')}>{error}</Alert>}
                {rows.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No payments yet.</Typography>
                )}
                {rows.map((r) => {
                    const st = STATE[r.state] || { label: r.state, color: 'default' };
                    return (
                        <Stack key={r.id} direction="row" alignItems="center" gap={1} flexWrap="wrap"
                            sx={{ py: 1, borderTop: '1px solid', borderColor: 'divider', mt: 1 }}>
                            <Typography variant="body2" sx={{ minWidth: 200 }}>
                                <b>{r.buyer_name || 'Unknown buyer'}</b> · {r.buyer_email || 'no email'}
                                <Typography component="span" variant="caption" color="text.secondary" display="block">
                                    {r.amount != null ? `$${r.amount}` : ''} · {(r.occurred_at || '').slice(0, 16).replace('T', ' ')}
                                </Typography>
                            </Typography>
                            <Chip size="small" color={st.color} label={st.label} />
                            {r.exhibitor && (
                                <Typography variant="body2">
                                    → {r.exhibitor.company_name}{r.exhibitor.booth_number ? ` (booth ${r.exhibitor.booth_number})` : ''}
                                </Typography>
                            )}
                            {(r.state === 'unmatched' || r.state === 'ambiguous') && (
                                <Stack direction="row" gap={1} sx={{ ml: { sm: 'auto' } }}>
                                    <TextField select size="small" label="Which stand?" sx={{ minWidth: 220 }}
                                        value={pick[r.id] || ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                                        {lockable.map((s) => (
                                            <MenuItem key={s.id} value={s.id}>
                                                {s.company_name}{s.booth_number ? ` · ${s.booth_number}` : ''}{s.leads_unlocked ? ' (open)' : ''}
                                            </MenuItem>
                                        ))}
                                    </TextField>
                                    <Button size="small" variant="contained" disabled={!pick[r.id] || busy === r.id}
                                        onClick={() => assign(r)}>Unlock</Button>
                                </Stack>
                            )}
                            {r.state === 'refunded_still_open' && (
                                <Typography variant="caption" color="error" sx={{ ml: { sm: 'auto' } }}>
                                    Refunded in GHL. Lock the stand with its "Leads unlocked" chip if that is right.
                                </Typography>
                            )}
                        </Stack>
                    );
                })}
            </Collapse>
        </Paper>
    );
}
