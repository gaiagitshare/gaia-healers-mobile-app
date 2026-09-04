import React, { useEffect, useState } from 'react';
import {
    Box, Typography, Paper, Chip, Stack, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, TextField, MenuItem, CircularProgress, Alert,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { getEntitlementReview } from '../utils/api';

// Operational, PII-free view of how every selling product is classified, and which
// paid products still need a human decision. Reads the platform product registry.
const CLASS_COLOR = {
    EVENT_TICKET: 'success', EVENT_UPGRADE: 'success', EVENT_ADDON: 'success',
    MEMBERSHIP_SUBSCRIPTION: 'primary', COURSE: 'secondary',
    PHYSICAL_PRODUCT: 'default', SPONSOR: 'default', SERVICE: 'default',
    NON_ENTITLEMENT: 'default', REVIEW_REQUIRED: 'warning',
};
const FILTERS = [
    { value: '', label: 'All products' },
    { value: 'REVIEW_REQUIRED', label: 'Review required' },
    { value: 'EVENT', label: 'Event' },
    { value: 'COURSE', label: 'Course' },
    { value: 'MEMBERSHIP_SUBSCRIPTION', label: 'Membership' },
    { value: 'PHYSICAL_PRODUCT', label: 'Physical/hardware' },
    { value: 'SPONSOR', label: 'Sponsor' },
    { value: 'SERVICE', label: 'Service / non-entitlement' },
];

function EntitlementReview() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('REVIEW_REQUIRED');

    useEffect(() => {
        getEntitlementReview()
            .then((r) => setData(r.data))
            .catch(() => setError('Could not load the product registry.'));
    }, []);

    if (error) return <Alert severity="error">{error}</Alert>;
    if (!data) return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;

    const products = (data.products || []).filter((p) => {
        if (!filter) return true;
        if (filter === 'EVENT') return String(p.classification).startsWith('EVENT');
        return p.classification === filter;
    });

    return (
        <Box>
            <Typography variant="h4" gutterBottom>Payments &amp; Entitlement Review</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Every product with completed orders, and how the system routes it. Nothing paid is silently lost —
                anything not explicitly classified is flagged here for a decision. No buyer details are shown.
            </Typography>

            {data.registry_as_of && (
                <Alert severity="info" variant="outlined" sx={{ mb: 2, py: 0.5 }}>
                    The order counts below are a <strong>classification-audit snapshot</strong>{data.registry_as_of.as_of ? <> from <strong>{data.registry_as_of.as_of}</strong></> : null} — not live sales. One conference is sold as several separate ticket products, so no single row equals total attendance. For the real numbers, see <strong>Live event attendance</strong> below.
                </Alert>
            )}

            <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Typography variant="overline" color="text.secondary">Classification of {(data.products || []).length} selling products</Typography>
                <Box sx={{ mt: 0.5 }}>
                    {Object.entries(data.summary || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <Chip key={k} size="small" color={CLASS_COLOR[k] || 'default'}
                            variant={k === 'REVIEW_REQUIRED' ? 'filled' : 'outlined'}
                            label={<span><strong>{v}</strong> {k.replace(/_/g, ' ').toLowerCase()}</span>} sx={{ mr: 0.5, mb: 0.5 }} />
                    ))}
                </Box>
                {data.review_summary && Object.keys(data.review_summary).length > 0 && (
                    <>
                        <Typography variant="overline" color="text.secondary">Review-required breakdown</Typography>
                        <Box>
                            {Object.entries(data.review_summary).map(([k, v]) => (
                                <Chip key={k} size="small" color="warning" variant="outlined"
                                    label={<span><strong>{v}</strong> {k.replace(/_/g, ' ').toLowerCase()}</span>} sx={{ mr: 0.5, mb: 0.5 }} />
                            ))}
                        </Box>
                    </>
                )}
            </Paper>

            {(data.events_live || []).length > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderColor: 'primary.main' }}>
                    <Typography variant="subtitle2" gutterBottom>Live event attendance — the real numbers</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Actual registered people per event, live from the Event Manager (the source of truth for attendance — unlike the per-product ticket counts, which are a snapshot). Click an event to see its attendees.
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {data.events_live.map((e) => (
                            <Paper key={e.event_id} component={RouterLink} to={`/events/${e.event_id}/attendees`}
                                variant="outlined" sx={{ px: 1.5, py: 1, textDecoration: 'none', display: 'block', minWidth: 160, '&:hover': { borderColor: 'primary.main' } }}>
                                <Typography variant="h6" sx={{ fontWeight: 700, color: 'primary.main' }}>{e.attendees}</Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>{e.name}</Typography>
                                <Typography variant="caption" color="text.secondary">{e.checked_in != null ? `${e.checked_in} checked in · ` : ''}view attendees →</Typography>
                            </Paper>
                        ))}
                    </Stack>
                </Paper>
            )}

            <TextField select size="small" label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ mb: 2, minWidth: 220 }}>
                {FILTERS.map((f) => <MenuItem key={f.value} value={f.value}>{f.label}</MenuItem>)}
            </TextField>

            <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 760 }}>
                    <TableHead>
                        <TableRow>
                            <TableCell>Product</TableCell>
                            <TableCell>Classification</TableCell>
                            <TableCell align="right">Orders</TableCell>
                            <TableCell>Intended / current behavior</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {products.map((p) => (
                            <TableRow key={p.product_id} hover>
                                <TableCell>
                                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.name || '(unnamed)'}</Typography>
                                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{p.product_id}</Typography>
                                </TableCell>
                                <TableCell>
                                    <Chip size="small" color={CLASS_COLOR[p.classification] || 'default'}
                                        variant={p.classification === 'REVIEW_REQUIRED' ? 'filled' : 'outlined'}
                                        label={p.classification.replace(/_/g, ' ').toLowerCase()} />
                                    {p.review_bucket && (
                                        <Typography variant="caption" display="block" color="text.secondary">{p.review_bucket.replace(/_/g, ' ').toLowerCase()}</Typography>
                                    )}
                                </TableCell>
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{p.orders || 0}</TableCell>
                                <TableCell><Typography variant="body2" color="text.secondary">{p.note}</Typography></TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            {(data.recent_unclassified_payments || []).length > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                    <Typography variant="subtitle2" gutterBottom>New unclassified paid products (captured live)</Typography>
                    <Stack spacing={0.5}>
                        {data.recent_unclassified_payments.map((r) => (
                            <Typography key={r.product_id} variant="body2">
                                <strong>{r.name || r.product_id}</strong> — {r.count}× · last order {r.last_order || '—'}
                            </Typography>
                        ))}
                    </Stack>
                </Paper>
            )}

            {(data.classification_flags || []).length > 0 && (
                <Paper variant="outlined" sx={{ p: 1.5, mt: 2, borderColor: 'warning.main' }}>
                    <Typography variant="subtitle2" gutterBottom>
                        Please confirm these classifications
                        <Chip size="small" color="warning" label={data.classification_flags.length} sx={{ ml: 1 }} />
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        These paid products are filed under one type, but their name suggests another — for example a
                        certification course filed as a physical product. Nothing has been changed automatically; confirm or
                        correct each so buyers are routed to the right entitlement.
                    </Typography>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Product</TableCell>
                                    <TableCell>Filed as</TableCell>
                                    <TableCell>Name suggests</TableCell>
                                    <TableCell align="right">Orders</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {data.classification_flags.map((f) => (
                                    <TableRow key={f.product_id} hover>
                                        <TableCell>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{f.name}</Typography>
                                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{f.product_id}</Typography>
                                        </TableCell>
                                        <TableCell><Chip size="small" variant="outlined" label={(f.classified_as || '').replace(/_/g, ' ').toLowerCase()} /></TableCell>
                                        <TableCell><Chip size="small" color="warning" label={(f.name_suggests || '').replace(/_/g, ' ').toLowerCase()} /></TableCell>
                                        <TableCell align="right">{f.orders}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            )}

            <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                <Typography variant="subtitle2" gutterBottom>Course access authority</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Authority for creating a course entitlement comes only from GHL, never from our own ledger. The ledger
                    is audited against it: existing owners keep access, but a course present only in history cannot be newly
                    granted until GHL authority confirms it.
                </Typography>
                {data.course_authority && (
                    <Box sx={{ mb: 1 }}>
                        <Chip size="small" color="secondary" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }}
                            label={<span><strong>{data.course_authority.count}</strong> authoritative courses</span>} />
                        <Chip size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }}
                            label={<span>{data.course_authority.visible} visible · {data.course_authority.hidden} hidden</span>} />
                        <Chip size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }}
                            label={<span><strong>{data.course_authority.approved_aliases}</strong> approved aliases</span>} />
                        {data.course_authority.ambiguous_keys > 0 && (
                            <Chip size="small" color="warning" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }}
                                label={<span>{data.course_authority.ambiguous_keys} ambiguous</span>} />
                        )}
                        {data.course_authority.seeded_pending_full_sync && (
                            <Chip size="small" color="info" sx={{ mr: 0.5, mb: 0.5 }} label="seeded — self-heals on next GHL sync" />
                        )}
                    </Box>
                )}
                {data.course_legacy_audit && (
                    <Box sx={{ mb: 0.5 }}>
                        <Typography variant="overline" color="text.secondary">Ledger vs authority</Typography>
                        <Box>
                            <Chip size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} label={<span><strong>{data.course_legacy_audit.distinct_ledger_courses}</strong> distinct in ledger</span>} />
                            <Chip size="small" color="success" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} label={<span><strong>{data.course_legacy_audit.authoritatively_matched}</strong> authoritative</span>} />
                            <Chip size="small" color="warning" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} label={<span><strong>{data.course_legacy_audit.legacy_unverified}</strong> legacy-unverified</span>} />
                        </Box>
                    </Box>
                )}
                {data.course_rejection_reasons && Object.keys(data.course_rejection_reasons).length > 0 && (
                    <Box>
                        <Typography variant="overline" color="text.secondary">Rejection reasons</Typography>
                        <Box>
                            {Object.entries(data.course_rejection_reasons).map(([k, v]) => (
                                <Chip key={k} size="small" color="warning" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} label={<span><strong>{v}</strong> {String(k).replace(/_/g, ' ').toLowerCase()}</span>} />
                            ))}
                        </Box>
                    </Box>
                )}
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.5, mt: 2, borderColor: (data.course_rejections || []).length ? 'warning.main' : undefined }}>
                <Typography variant="subtitle2" gutterBottom>
                    Rejected &amp; unknown course grants
                    {(data.course_rejection_count || 0) > 0 && (
                        <Chip size="small" color="warning" label={data.course_rejection_count} sx={{ ml: 1 }} />
                    )}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    The Course access path only grants courses that exist in the authoritative catalog. A workflow that
                    supplies an unrecognized course id/name is refused here — never turned into access — and any revoke that
                    matches no held course is logged instead of guessing. No buyer details are shown.
                </Typography>
                {(data.course_rejections || []).length === 0 ? (
                    <Alert severity="success" variant="outlined">No rejected course grants — every course grant resolved to a known course.</Alert>
                ) : (
                    <TableContainer sx={{ overflowX: 'auto' }}>
                        <Table size="small" sx={{ minWidth: 680 }}>
                            <TableHead>
                                <TableRow>
                                    <TableCell>When</TableCell>
                                    <TableCell>Action</TableCell>
                                    <TableCell>Requested course</TableCell>
                                    <TableCell>Reason</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {data.course_rejections.map((r, i) => (
                                    <TableRow key={i} hover>
                                        <TableCell sx={{ whiteSpace: 'nowrap' }}><Typography variant="caption">{(r.at || '').replace('T', ' ').slice(0, 19)}</Typography></TableCell>
                                        <TableCell><Chip size="small" variant="outlined" color={r.action === 'revoke' ? 'default' : 'warning'} label={r.action || 'grant'} /></TableCell>
                                        <TableCell>
                                            <Typography variant="body2">{r.name || '(no name)'}</Typography>
                                            {r.id && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{r.id}</Typography>}
                                        </TableCell>
                                        <TableCell><Typography variant="caption" color="text.secondary">{(r.reason || '').replace(/_/g, ' ')}</Typography></TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </Paper>
        </Box>
    );
}

export default EntitlementReview;
