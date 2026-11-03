import React from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Box, Chip, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const STATUS = {
    paid: { label: 'Paid', color: 'success' },
    failed: { label: 'Failed attempt', color: 'default' },
    pending: { label: 'Pending', color: 'warning' },
    refunded: { label: 'Refunded', color: 'warning' },
    partially_refunded: { label: 'Partially refunded', color: 'warning' },
};

export default function PaymentHistory({ history }) {
    const items = history?.items || [];
    const counts = history?.counts || {};
    return (
        <Accordion disableGutters elevation={0} sx={{ mt: 1.25, border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack spacing={0.5}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>Payment history ({items.length})</Typography>
                    <Typography variant="caption" color="text.secondary">
                        {counts.paid || 0} paid · {counts.failed || 0} failed attempts · {counts.pending || 0} pending
                    </Typography>
                </Stack>
            </AccordionSummary>
            <AccordionDetails>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Earlier failed attempts do not cancel a later successful purchase. Entry follows this ticket’s current status and access.
                </Typography>
                {items.length === 0 && <Typography variant="body2" color="text.secondary">No linked payment attempts are recorded.</Typography>}
                <Stack spacing={1}>
                    {items.map((item) => {
                        const state = STATUS[item.status] || { label: item.status || 'Unknown', color: 'default' };
                        const date = item.at ? new Date(item.at) : null;
                        const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Time not recorded';
                        const amount = item.amount == null ? 'Amount not recorded' : `${Number(item.amount).toFixed(2)} ${item.currency || ''}`;
                        return <Box key={item.id} sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}>
                            <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center" useFlexGap>
                                <Chip size="small" color={state.color} label={state.label} />
                                <Typography variant="body2">{amount} · {item.provider}</Typography>
                                {item.live_mode === false && <Chip size="small" variant="outlined" label="Test payment" />}
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                {when}{item.transaction_suffix && ` · Transaction …${item.transaction_suffix}`}{item.order_suffix && ` · Order …${item.order_suffix}`}
                                {item.association === 'linked_order' && ' · Same order'}
                            </Typography>
                            {item.amount_refunded > 0 && <Typography variant="caption" color="text.secondary">
                                Refunded: {Number(item.amount_refunded).toFixed(2)} {item.currency}
                            </Typography>}
                        </Box>;
                    })}
                </Stack>
            </AccordionDetails>
        </Accordion>
    );
}
