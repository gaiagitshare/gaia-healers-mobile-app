import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material';
import CssBaseline from '@mui/material/CssBaseline';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import EntitlementReview from './components/EntitlementReview';
import VendorsRedirect from './components/VendorsRedirect';
import Payments from './components/Payments';
import Events from './components/Events';
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
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: 8,
                    boxShadow: 'none',
                    '&:hover': {
                        boxShadow: '0 4px 12px rgba(45, 90, 61, 0.25)',
                    },
                },
                containedPrimary: {
                    background: 'linear-gradient(135deg, #2d5a3d 0%, #4a7c59 100%)',
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
                        user ? <Navigate to="/dashboard" /> : <Login onLogin={handleLogin} />
                    } />
                    <Route path="/scan/:token" element={<ExhibitorScan />} />
                    <Route path="/register/:eventId" element={<PublicRegistration />} />
                    <Route path="/*" element={
                        user ? (
                            <Layout user={user} onLogout={handleLogout}>
                                <Routes>
                                    <Route path="/dashboard" element={<Dashboard />} />
                                    <Route path="/events" element={<Events />} />
                                    <Route path="/events/:id" element={<EventWorkspace />} />
                                    <Route path="/events/:id/:section" element={<EventWorkspace />} />
                                    
                                    
                                    <Route path="/checkin" element={<CheckIn />} />
                                    {/* Retired: Vendors merged into each event's Exhibitors area. */}
                                    <Route path="/vendors" element={<VendorsRedirect />} />
                                    <Route path="/payments" element={<Payments />} />
                                    <Route path="/entitlement-review" element={<EntitlementReview />} />
                                    <Route path="/" element={<Navigate to="/dashboard" />} />
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
