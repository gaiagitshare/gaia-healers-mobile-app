import React, { useState } from 'react';
import {
    Box, Button, Stack, Typography, Drawer, IconButton, Divider, useMediaQuery, useTheme,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/**
 * Event navigation — fifteen destinations, all of them on screen.
 *
 * This was one scrollable row of tabs. Fifteen labels do not fit a laptop, so
 * MUI clipped them behind Next/Previous arrows and the sections that fell off
 * the end were Speakers, Exhibitors, Live and Check-In — which is to say the
 * ones somebody running a door needs most. A control you have to page through
 * to discover is not navigation.
 *
 * So: four labelled groups instead of fifteen equal links. Grouping is what
 * buys the space — the eye lands on "People" and finds Check-In inside it,
 * rather than scanning fifteen similar words. Nothing is smaller than it was;
 * the row is denser because it is organised, not because it is shrunk.
 *
 * Narrow screens get a different answer rather than a squeezed version of this
 * one: the current section stays visible as a button, and the same groups open
 * in a drawer. Hiding things behind a labelled "Sections" control is honest in
 * a way that a horizontally scrolling strip is not — you can see there is more.
 */
export const NAV_GROUPS = [
    // The event and what is on at it.
    { label: 'Event', keys: ['overview', 'schedule', 'speakers', 'sponsors', 'exhibitors'] },
    // Who is coming, who is through the door, and what they are saying.
    { label: 'People', keys: ['attendees', 'checkin', 'community'] },
    // Everything we push out to attendees, live or written ahead.
    { label: 'Comms', keys: ['live', 'updates', 'notify', 'info', 'resources'] },
    // Wiring. Rarely touched during an event, and it should not sit next to the
    // controls that are.
    { label: 'Setup', keys: ['setup', 'mappings'] },
];

function NavButton({ label, active, onClick, full }) {
    return (
        <Button
            size="small"
            disableElevation
            onClick={onClick}
            variant={active ? 'contained' : 'text'}
            color={active ? 'primary' : 'inherit'}
            sx={{
                px: 1.1, py: 0.4, minWidth: 0, borderRadius: 1.5,
                fontSize: 13, fontWeight: active ? 700 : 500, lineHeight: 1.5,
                textTransform: 'none', whiteSpace: 'nowrap',
                justifyContent: full ? 'flex-start' : 'center',
                width: full ? '100%' : 'auto',
                color: active ? undefined : 'text.secondary',
                '&:hover': { bgcolor: active ? undefined : 'action.hover', color: active ? undefined : 'text.primary' },
            }}
        >
            {label}
        </Button>
    );
}

function GroupLabel({ children }) {
    return (
        <Typography
            variant="caption"
            sx={{ display: 'block', mb: 0.25, color: 'text.disabled',
                  textTransform: 'uppercase', letterSpacing: '.09em', fontSize: 10, fontWeight: 700 }}
        >
            {children}
        </Typography>
    );
}

export default function EventNav({ sections, active, onSelect }) {
    const theme = useTheme();
    const wide = useMediaQuery(theme.breakpoints.up('md'));
    const [open, setOpen] = useState(false);
    const labelOf = (key) => (sections.find(([k]) => k === key) || [key, key])[1];
    const activeLabel = labelOf(active);

    if (wide) {
        // Two rows, always — not a single row that happens to wrap. All four
        // groups need ~1220px and a laptop gives the panel about 1140, so a
        // flowing row orphans Setup on a line of its own and reads as a
        // mistake. Pairing the groups two-up is the same height, balanced, and
        // stable: the operator learns where Check-In lives and it stays there.
        const rows = [NAV_GROUPS.slice(0, 2), NAV_GROUPS.slice(2)];
        return (
            <Box sx={{ mb: 3, pb: 1.5, borderBottom: 1, borderColor: 'divider' }}>
                {rows.map((row, r) => (
                    <Box key={r} sx={{ display: 'flex', alignItems: 'flex-start',
                                       flexWrap: 'wrap', rowGap: 1.5, mt: r ? 1.5 : 0 }}>
                        {row.map((group, i) => (
                            <Box key={group.label} sx={{ display: 'flex', alignItems: 'flex-start' }}>
                                {i > 0 && (
                                    <Divider orientation="vertical" flexItem
                                             sx={{ mx: { md: 1.75, lg: 2.5 }, my: 0.5, borderColor: 'divider' }} />
                                )}
                                <Box>
                                    <GroupLabel>{group.label}</GroupLabel>
                                    <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap>
                                        {group.keys.map((key) => (
                                            <NavButton key={key} label={labelOf(key)}
                                                       active={active === key}
                                                       onClick={() => onSelect(key)} />
                                        ))}
                                    </Stack>
                                </Box>
                            </Box>
                        ))}
                    </Box>
                ))}
            </Box>
        );
    }

    // Narrow: the section you are in, and a way to see every other one. No
    // sideways scrolling, because a strip that scrolls off-screen does not tell
    // you it has more in it.
    return (
        <>
            <Button
                fullWidth
                onClick={() => setOpen(true)}
                endIcon={<ExpandMoreIcon />}
                startIcon={<MenuIcon />}
                sx={{
                    mb: 2, justifyContent: 'space-between', textTransform: 'none',
                    borderRadius: 1.5, border: 1, borderColor: 'divider',
                    px: 1.5, py: 1, color: 'text.primary', fontWeight: 700,
                }}
            >
                <Box sx={{ flex: 1, textAlign: 'left', ml: 0.5 }}>{activeLabel}</Box>
            </Button>

            <Drawer anchor="bottom" open={open} onClose={() => setOpen(false)}
                    PaperProps={{ sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '85vh' } }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, pt: 1.5 }}>
                    <Typography variant="subtitle1" fontWeight={700}>Sections</Typography>
                    <IconButton size="small" onClick={() => setOpen(false)} aria-label="Close sections">
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </Stack>
                <Box sx={{ px: 2, pb: 3, pt: 1 }}>
                    {NAV_GROUPS.map((group) => (
                        <Box key={group.label} sx={{ mb: 2 }}>
                            <GroupLabel>{group.label}</GroupLabel>
                            <Stack spacing={0.25}>
                                {group.keys.map((key) => (
                                    <NavButton key={key} label={labelOf(key)} full
                                               active={active === key}
                                               onClick={() => { onSelect(key); setOpen(false); }} />
                                ))}
                            </Stack>
                        </Box>
                    ))}
                </Box>
            </Drawer>
        </>
    );
}
