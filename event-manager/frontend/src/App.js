import React, { useState } from 'react';
import { isPlatformAdmin } from './utils/api';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material';
import CssBaseline from '@mui/material/CssBaseline';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import EntitlementReview from './components/EntitlementReview';
import VendorsRedirect from './components/VendorsRedirect';
import Payments from './components/Payments';
import Events from './components/Events';
import CurrentEvent from './components/CurrentEvent';
import VolunteerPortal from './components/VolunteerPortal';
import VolunteerJoin from './components/VolunteerJoin';
import VolunteerTeam from './components/VolunteerTeam';
import EventDetail from './components/EventDetail';
import Attendees from './components/Attendees';
import CheckIn from './components/CheckIn';
import Agenda from './components/Agenda';
import EventWorkspace from './components/EventWorkspace';
import ExhibitorScan from './components/ExhibitorScan';
import Layout from './components/Layout';
import PublicRegistration from './components/PublicRegistration';

const theme = createTheme({
    palette: {
        mode: 'dark',  // match the Gaia Healers Admin dark theme
        primary: {
            main: '#7cc23f',  // Gaia green
            light: '#a9e05a',
            dark: '#3f5a2a',
            contrastText: '#0d1a06',
        },
        // Ticket add-ons (Attendees, Check-in): the same cyan as the member
        // app's add-on chips, apart from the green "checked in" chip.
        info: {
            main: '#58c7e8',
            contrastText: '#06170d',
        },
        secondary: {
            main: '#e6b95c', // amber - wellness
            light: '#f0d08a',
            dark: '#a08220',
        },
        background: {
            default: '#0a0e0b', // near-black green
            paper: '#121a14',   // surface
        },
        text: {
            primary: '#eef3ea',
            secondary: '#9fb29a',
        },
        divider: '#243026',
    },
    typography: {
        fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
        h1: { fontWeight: 700, fontSize: '2.5rem' },
        h2: { fontWeight: 600, fontSize: '2rem' },
        h3: { fontWeight: 600, fontSize: '1.5rem' },
        h4: { fontWeight: 600, fontSize: '1.25rem' },
        button: { fontWeight: 600, textTransform: 'none' },
    },
    shape: {
        borderRadius: 12,
    },
    components: {
        // On a phone or tablet (a coarse pointer — a thumb) every control gets
        // the platform's minimum tap height; a mouse keeps the dense sizes.
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: 8,
                    boxShadow: 'none',
                    '&:hover': {
                        boxShadow: '0 4px 12px rgba(45, 90, 61, 0.25)',
                    },
                    '@media (pointer: coarse)': { minHeight: 44 },
                },
                containedPrimary: {
                    background: 'linear-gradient(135deg, #2d5a3d 0%, #4a7c59 100%)',
                    // White on the dark green gradient (11 Nov 2026): the theme's
                    // dark contrast text made every main button hard to read.
                    color: '#ffffff',
                    '&.Mui-disabled': { color: 'rgba(255,255,255,0.45)' },
                },
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    borderRadius: 16,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
                },
            },
        },
        MuiIconButton: { styleOverrides: { root: { '@media (pointer: coarse)': { minWidth: 44, minHeight: 44 } } } },
        MuiMenuItem: { styleOverrides: { root: { '@media (pointer: coarse)': { minHeight: 44 } } } },
        MuiListItemButton: { styleOverrides: { root: { '@media (pointer: coarse)': { minHeight: 48 } } } },
        MuiChip: { styleOverrides: { clickable: { '@media (pointer: coarse)': { minHeight: 36 } } } },
        // iPad (11 Nov 2026): checkboxes and tabs were the smallest targets left.
        MuiCheckbox: { styleOverrides: { root: { '@media (pointer: coarse)': { padding: 11 } } } },
        MuiTab: { styleOverrides: { root: { '@media (pointer: coarse)': { minHeight: 48 } } } },
        // Look (11 Nov 2026): one quiet, consistent style for every table, card
        // and notice, so pages read alike and the data stands out from the frame.
        MuiPaper: { styleOverrides: { outlined: { borderColor: '#243026' } } },
        MuiTableCell: {
            styleOverrides: {
                root: { borderColor: '#1e2820' },
                head: {
                    fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                    color: '#9fb29a', backgroundColor: '#152018', whiteSpace: 'nowrap',
                },
            },
        },
        // Headers stay put (12 Nov 2026): every table keeps its column names in
        // view while the rows scroll. A sticky header only sticks inside the box
        // that scrolls, so the box a table sits in alone is held to the screen's
        // height and scrolls itself; with few rows nothing changes. :where()
        // keeps this weaker than any height a screen sets for itself.
        MuiTable: { defaultProps: { stickyHeader: true } },
        MuiCssBaseline: {
            styleOverrides: {
                ':where(div:has(> .MuiTable-root:only-child))': {
                    maxHeight: 'max(320px, calc(100dvh - 150px))',
                    overflow: 'auto',
                },
            },
        },
        MuiTableRow: { styleOverrides: { root: { '&.MuiTableRow-hover:hover': { backgroundColor: 'rgba(124,194,63,0.06)' } } } },
        MuiAlert: { styleOverrides: { root: { borderRadius: 10, alignItems: 'center' } } },
        MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3 } } },
        MuiTooltip: { styleOverrides: { tooltip: { fontSize: 13 } } },
        MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 10 } } },
    },
});

function App() {
    const [user, setUser] = useState(() => {
        const token = localStorage.getItem('token');
        if (!token) return null;
        // A token past its expiry is as good as absent — otherwise the app renders
        // a logged-in shell whose every API call 401s and every list shows empty.
        // Treat an expired token as signed-out so the login screen shows instead.
        try {
            const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            if (claims.exp && claims.exp * 1000 <= Date.now()) {
                localStorage.removeItem('token');
                return null;
            }
        } catch (e) {
            localStorage.removeItem('token');
            return null;
        }
        return { token };
    });

    const handleLogin = (data) => {
        localStorage.setItem('token', data.access_token);
        setUser(data);
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        setUser(null);
    };

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <Router basename="/event">
                <Routes>
                    <Route path="/login" element={
                        user ? <Navigate to={isPlatformAdmin() ? '/dashboard' : '/events/current'} /> : <Login onLogin={handleLogin} />
                    } />
                    <Route path="/scan/:token" element={<ExhibitorScan />} />
                    {/* Volunteers: private links, no Event Manager login. */}
                    <Route path="/volunteer/:token" element={<VolunteerPortal />} />
                    <Route path="/volunteer-join/:joinToken" element={<VolunteerJoin />} />
                    <Route path="/volunteer-team/:teamToken" element={<VolunteerTeam />} />
                    <Route path="/register/:eventId" element={<PublicRegistration />} />
                    <Route path="/*" element={
                        user ? (
                            <Layout user={user} onLogout={handleLogout}>
                                <Routes>
                                    <Route path="/dashboard" element={isPlatformAdmin() ? <Dashboard /> : <Navigate to="/events/current" replace />} />
                                    {/* Events opens the current event; the full list (archived
                                        included) is All Events. Old /events links keep working. */}
                                    <Route path="/events" element={<Navigate to="/events/current" replace />} />
                                    <Route path="/events/current" element={<CurrentEvent />} />
                                    <Route path="/events/all" element={<Events />} />
                                    <Route path="/events/:id" element={<EventWorkspace />} />
                                    <Route path="/events/:id/:section" element={<EventWorkspace />} />
                                    
                                    
                                    <Route path="/checkin" element={<CheckIn />} />
                                    {/* Retired: Vendors merged into each event's Exhibitors area. */}
                                    <Route path="/vendors" element={<VendorsRedirect />} />
                                    <Route path="/payments" element={<Payments />} />
                                    <Route path="/entitlement-review" element={<EntitlementReview />} />
                                    <Route path="/" element={<Navigate to={isPlatformAdmin() ? '/dashboard' : '/events/current'} />} />
                                </Routes>
                            </Layout>
                        ) : (
                            <Navigate to="/login" />
                        )
                    } />
                </Routes>
            </Router>
        </ThemeProvider>
    );
}

export default App;
