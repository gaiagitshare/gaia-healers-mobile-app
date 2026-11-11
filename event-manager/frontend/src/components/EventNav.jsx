import React, { useState } from 'react';
import {
    Box, Button, Stack, Typography, Drawer, IconButton, Menu, MenuItem, ListItemText, useMediaQuery, useTheme,
} from '@mui/material';
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
    { label: 'People', keys: ['attendees', 'checkin', 'volunteers', 'review', 'reconcile', 'delivery', 'community', 'biowell-station', 'biowell'] },
    // Everything we push out to attendees, live or written ahead.
    { label: 'Comms', keys: ['email', 'live', 'updates', 'notify', 'info', 'resources', 'share'] },
    // Wiring. Rarely touched during an event, and it should not sit next to the
    // controls that are.
    { label: 'Setup', keys: ['setup', 'mappings'] },
];

// One line on what each section is for, shown in the menus (11 Nov 2026):
// twenty-odd names are easier to find with a hint of what lives behind them.
export const SECTION_HINT = {
    overview: 'Dates, venue and the event page',
    schedule: 'Sessions and times',
    speakers: 'Speaker profiles',
    sponsors: 'Sponsors and their tiers',
    exhibitors: 'Stands, booths, scanners and setup links',
    attendees: 'Every ticket holder: search, correct, export',
    checkin: 'Scan badges at the door, walk-ins, printing',
    volunteers: 'Shifts, team and invitations',
    review: 'Things waiting on a person',
    reconcile: 'Ticket corrections, with approvals',
    delivery: 'Automatic ticket emails',
    community: 'Member community',
    'biowell-station': 'The Bio-Well station on the floor',
    biowell: 'Bio-Well scans and results',
    email: 'Ticket and exhibitor emails, approvals',
    live: 'Live mode on the day',
    updates: 'Announcements in the app',
    notify: 'Push notifications to phones',
    info: 'FAQ and practical information',
    resources: 'Downloads and links',
    share: 'Share links and QR codes',
    setup: 'Passes and event settings',
    mappings: 'Which GHL product gives which pass',
};
// The pages people open most during an event, one tap away.
const QUICK = ['checkin', 'attendees', 'email'];

function NavButton({ label, active, onClick, full, tall }) {
    return (
        <Button
            size="small"
            disableElevation
            onClick={onClick}
            variant={active ? 'contained' : 'text'}
            color={active ? 'primary' : 'inherit'}
            sx={{
                px: 1.1, py: 0.4, minWidth: 0, borderRadius: 1.5,
                minHeight: tall ? 44 : undefined,           // a thumb, not a mouse pointer
                fontSize: tall ? 15 : 13, fontWeight: active ? 700 : 500, lineHeight: 1.5,
                textTransform: 'none', whiteSpace: 'nowrap',
                justifyContent: full ? 'flex-start' : 'center',
                width: full ? '100%' : 'auto',
                color: active ? '#0d1a06' : 'text.secondary',
                ...(active ? { background: '#7cc23f' } : {}),
                '&:hover': active ? { background: '#a9e05a' } : { bgcolor: 'action.hover', color: 'text.primary' },
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
    const [menu, setMenu] = useState(null);
    const labelOf = (key) => (sections.find(([k]) => k === key) || [key, key])[1];
    const activeLabel = labelOf(active);
    // Only the sections this person was given: a role restricted to one
    // section (e.g. Ticket Email Manager) sees one group with one button.
    const groups = NAV_GROUPS
        .map((g) => ({ ...g, keys: g.keys.filter((k) => sections.some(([s]) => s === k)) }))
        .filter((g) => g.keys.length);

    if (wide) {
        // One compact bar that stays at the top while the page scrolls
        // (11 Nov 2026). The two rows of every link took a third of an iPad
        // screen before any content; now each group opens a menu that says
        // what is behind each name, and the busiest pages are one tap away.
        const groupOf = (key) => groups.find((g) => g.keys.includes(key));
        const current = groupOf(active);
        const quick = QUICK.filter((k) => sections.some(([s]) => s === k));
        return (
            <Box sx={{
                position: 'sticky', top: { xs: 56, sm: 64 }, zIndex: 3, mb: 3, mx: { xs: -2, sm: -3 }, px: { xs: 2, sm: 3 }, py: 1,
                bgcolor: 'background.default', borderBottom: 1, borderColor: 'divider',
            }}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    {groups.map((g) => {
                        const on = current && current.label === g.label;
                        return (
                            <Button key={g.label} size="small" disableElevation endIcon={<ExpandMoreIcon />}
                                    variant={on ? 'contained' : 'outlined'} color={on ? 'primary' : 'inherit'}
                                    onClick={(e) => setMenu({ anchor: e.currentTarget, group: g })}
                                    sx={{ borderRadius: 2, fontWeight: on ? 700 : 600, borderColor: on ? undefined : 'divider',
                                          color: on ? '#0d1a06' : 'text.primary', whiteSpace: 'nowrap',
                                          // solid Gaia green with dark text: the theme's dark gradient
                                          // made the current section hard to read
                                          ...(on ? { background: '#7cc23f', '&:hover': { background: '#a9e05a' } } : {}) }}>
                                {g.label}{on ? ` · ${labelOf(active)}` : ''}
                            </Button>
                        );
                    })}
                    {quick.length > 0 && <Box sx={{ flex: 1 }} />}
                    {quick.map((k) => (
                        <NavButton key={k} label={labelOf(k)} active={active === k} onClick={() => onSelect(k)} />
                    ))}
                </Stack>
                <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}
                      PaperProps={{ sx: { minWidth: 280, maxWidth: 360 } }}>
                    {(menu?.group.keys || []).map((key) => (
                        <MenuItem key={key} selected={active === key} onClick={() => { setMenu(null); onSelect(key); }}>
                            <ListItemText primary={labelOf(key)} secondary={SECTION_HINT[key]}
                                          primaryTypographyProps={{ fontWeight: active === key ? 700 : 500 }}
                                          secondaryTypographyProps={{ sx: { whiteSpace: 'normal' } }} />
                        </MenuItem>
                    ))}
                </Menu>
            </Box>
        );
    }

    // Narrow: the section you are in, and a way to see every other one. No
    // sideways scrolling, because a strip that scrolls off-screen does not tell
    // you it has more in it.
    //
    // It reads as a PICKER, not a menu: the app bar one row above already has
    // the hamburger that opens the app's own navigation, and a second ≡ under
    // it made two different menus look like the same one. So: a small
    // "Section" caption, the current section's name, a chevron — the shape of
    // a select, which is what it is. The sheet says where it goes.
    return (
        <>
            <Button
                fullWidth
                onClick={() => setOpen(true)}
                endIcon={<ExpandMoreIcon />}
                aria-label={`Section: ${activeLabel}. Change section`}
                sx={{
                    mb: 2, justifyContent: 'space-between', textTransform: 'none',
                    borderRadius: 1.5, border: 1, borderColor: 'primary.dark', bgcolor: 'action.hover',
                    px: 1.5, py: 0.75, color: 'text.primary', minHeight: 48,
                }}
            >
                <Box sx={{ flex: 1, textAlign: 'left' }}>
                    <Typography component="span" sx={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '.09em',
                                                       textTransform: 'uppercase', color: 'text.secondary', lineHeight: 1.2 }}>
                        Section
                    </Typography>
                    <Typography component="span" sx={{ display: 'block', fontWeight: 700, fontSize: 15, lineHeight: 1.3 }}>
                        {activeLabel}
                    </Typography>
                </Box>
            </Button>

            <Drawer anchor="bottom" open={open} onClose={() => setOpen(false)}
                    PaperProps={{ sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '85vh' } }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, pt: 1.5 }}>
                    <Typography variant="subtitle1" fontWeight={700}>Go to section</Typography>
                    <IconButton onClick={() => setOpen(false)} aria-label="Close">
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </Stack>
                <Box sx={{ px: 2, pb: 'max(24px, env(safe-area-inset-bottom))', pt: 1 }}>
                    {groups.map((group) => (
                        <Box key={group.label} sx={{ mb: 1.5 }}>
                            <GroupLabel>{group.label}</GroupLabel>
                            <Stack spacing={0.25}>
                                {group.keys.map((key) => (
                                    <NavButton key={key} full tall
                                               label={(
                                                   <Box component="span" sx={{ display: 'block', textAlign: 'left', py: 0.25 }}>
                                                       <Box component="span" sx={{ display: 'block' }}>{labelOf(key)}</Box>
                                                       {SECTION_HINT[key] && (
                                                           <Box component="span" sx={{ display: 'block', fontSize: 12, fontWeight: 400, opacity: 0.75, whiteSpace: 'normal' }}>
                                                               {SECTION_HINT[key]}
                                                           </Box>
                                                       )}
                                                   </Box>
                                               )}
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
