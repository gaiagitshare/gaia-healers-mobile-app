import React from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';

/**
 * The registration desk's answer for one ticket (18 Nov 2026): READY / VERIFY /
 * MULTIPLE TICKETS / BLOCKED, what kind of entitlement it is, the notes the desk
 * acts on, and every ticket that belongs with this one. Built by the backend
 * (desk_view.py); no money is ever in it.
 */
export const DESK_STATUS = {
    READY: { label: 'READY', mark: '🟢', color: 'success', hint: 'Valid ticket, can check in' },
    VERIFY: { label: 'VERIFY', mark: '🟡', color: 'warning', hint: 'Valid ticket; confirm the details below first' },
    MULTIPLE: { label: 'MULTIPLE TICKETS', mark: '🔵', color: 'info', hint: 'More than one valid ticket for this person' },
    BLOCKED: { label: 'BLOCKED', mark: '🔴', color: 'error', hint: 'Not valid for entry' },
};

export function DeskChips({ desk, size = 'medium' }) {
    if (!desk) return null;
    return (
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
            {(desk.statuses || [desk.status]).map((s) => {
                const v = DESK_STATUS[s] || DESK_STATUS.VERIFY;
                return (
                    <Chip key={s} size={size} color={v.color} title={v.hint}
                        label={`${v.mark} ${v.label}`} sx={{ fontWeight: 800, letterSpacing: '.02em' }} />
                );
            })}
            {desk.checked_in && <Chip size={size} variant="outlined" color="success" label="Already checked in" />}
        </Stack>
    );
}

const ticketState = (t) => {
    if (!t.active) return { text: 'Not valid', color: 'error' };
    if (t.checked_in) return { text: 'Already used today / checked in', color: 'default' };
    return { text: 'Available for check-in', color: 'success' };
};

// Where each ticket's email stands (20 Nov 2026). Never a reason to turn
// anyone away: the badge printed here is their ticket.
const EMAIL_CHIP = {
    sent: { text: 'Emailed', color: 'success' },
    failed: { text: 'Email failed', color: 'warning' },
    held: { text: 'Not emailed (asked)', color: 'warning' },
    not_sent: { text: 'Not emailed yet', color: 'warning' },
};

// Bought / badges / emailed for the whole booking, and the fix right there.
export function BookingCounts({ booking, onNameSeat }) {
    if (!booking) return null;
    const short = booking.missing > 0;
    const unsent = booking.not_emailed > 0;
    return (
        <Box sx={{ mt: 0.75 }}>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                <Chip size="small" variant="outlined" label={`Bought ${booking.bought}`} sx={{ fontWeight: 700 }} />
                <Chip size="small" color={short ? 'warning' : 'success'} variant={short ? 'filled' : 'outlined'}
                    label={`Badges ${booking.issued} of ${booking.bought}`} sx={{ fontWeight: 700 }} />
                {booking.emailable > 0 && (
                    <Chip size="small" color={unsent ? 'warning' : 'success'} variant={unsent ? 'filled' : 'outlined'}
                        label={`Emailed ${booking.emailed} of ${booking.emailable}`} sx={{ fontWeight: 700 }} />
                )}
            </Stack>
            {short && (
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                    <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 700 }}>
                        {booking.missing} paid seat{booking.missing === 1 ? ' has' : 's have'} no badge yet. No charge: name the guest and print.
                    </Typography>
                    {onNameSeat && (
                        <Button size="small" variant="contained" color="warning"
                            onClick={() => onNameSeat(booking)}>
                            Name missing seat
                        </Button>
                    )}
                </Stack>
            )}
            {unsent && !short && (
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>
                    Not emailed is fine: check them in and print the badge here. The badge is their ticket.
                </Typography>
            )}
        </Box>
    );
}

export default function DeskSummary({ desk, compact = false, onOpenTicket, onNameSeat }) {
    if (!desk) return null;
    const others = (desk.tickets || []).length > 1;
    return (
        <Box sx={{ mt: 1 }}>
            <DeskChips desk={desk} size={compact ? 'small' : 'medium'} />
            <Typography variant="body2" sx={{ mt: 0.75 }}>
                <strong>{desk.entitlement}</strong>{desk.valid_days ? ` · ${desk.valid_days}` : ''}
            </Typography>
            <BookingCounts booking={desk.booking} onNameSeat={onNameSeat} />
            {(desk.notes || []).map((n) => (
                <Alert key={n} severity={desk.status === 'BLOCKED' ? 'error' : (desk.status === 'VERIFY' ? 'warning' : 'info')}
                    icon={false} sx={{ mt: 0.75, py: 0.25 }}>
                    {n}
                </Alert>
            ))}
            {others && (
                <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
                        All tickets together ({desk.tickets.length})
                    </Typography>
                    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                        {desk.tickets.map((t) => {
                            const st = ticketState(t);
                            return (
                                <Box key={t.id}
                                    onClick={onOpenTicket && !t.this ? () => onOpenTicket(t) : undefined}
                                    sx={{ p: 0.75, borderRadius: 1, border: '1px solid', borderColor: t.this ? 'primary.main' : 'divider',
                                          cursor: onOpenTicket && !t.this ? 'pointer' : 'default' }}>
                                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                                        <Typography variant="body2" sx={{ fontWeight: 700 }}>#{t.id} {t.holder}</Typography>
                                        <Chip size="small" variant="outlined" label={t.pass || '?'} />
                                        <Chip size="small" color={st.color} variant={st.color === 'default' ? 'outlined' : 'filled'} label={st.text} />
                                        {!t.qr_ok && t.active && <Chip size="small" color="warning" label="QR needs reprint" />}
                                        {t.active && EMAIL_CHIP[t.email] && (
                                            <Chip size="small" variant="outlined" color={EMAIL_CHIP[t.email].color} label={EMAIL_CHIP[t.email].text} />
                                        )}
                                    </Stack>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                        {[t.this ? 'this ticket' : t.relation, t.entitlement, t.valid_days,
                                          t.purchaser ? `bought by ${t.purchaser}` : null,
                                          t.kind === 'guest' ? 'guest ticket' : (t.kind === 'transferred' ? 'transferred ticket' : null),
                                          t.order_ref].filter(Boolean).join(' · ')}
                                    </Typography>
                                </Box>
                            );
                        })}
                    </Stack>
                </Box>
            )}
        </Box>
    );
}
