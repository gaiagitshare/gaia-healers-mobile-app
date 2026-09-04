import React, { useState } from 'react';
import {
    Container,
    Paper,
    TextField,
    Button,
    Typography,
    Box,
    Alert,
    Tabs,
    Tab,
    Grid,
    Card,
    CardContent,
    useTheme,
} from '@mui/material';
import {
    Event as EventIcon,
    QrCode as QrCodeIcon,
    People as PeopleIcon,
    Business as BusinessIcon,
} from '@mui/icons-material';
import { login, register } from '../utils/api';

function Login({ onLogin }) {
    const theme = useTheme();
    const [activeTab, setActiveTab] = useState(0);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [fullName, setFullName] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const features = [
        { icon: <EventIcon />, title: 'Event Management', desc: 'Create and manage multiple events with ease' },
        { icon: <QrCodeIcon />, title: 'QR Check-In', desc: 'Fast attendee verification with QR scanning' },
        { icon: <PeopleIcon />, title: 'Attendee Tracking', desc: 'Real-time check-in and attendance monitoring' },
        { icon: <BusinessIcon />, title: 'Lead Retrieval', desc: 'Exhibitors capture leads with QR scanning' },
    ];

    const handleLogin = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        
        try {
            const formData = new FormData();
            formData.append('username', email);
            formData.append('password', password);
            
            const response = await login(email, password);
            onLogin(response.data);
        } catch (err) {
            setError(err.response?.data?.detail || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    const handleRegister = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        
        try {
            await register({ email, password, full_name: fullName });
            // Auto login after register
            const response = await login(email, password);
            onLogin(response.data);
        } catch (err) {
            setError(err.response?.data?.detail || 'Registration failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box sx={{ minHeight: '100vh', display: 'flex' }}>
            {/* Left Side - Hero Section */}
            <Box
                sx={{
                    flex: 1,
                    background: 'linear-gradient(135deg, #2d5a3d 0%, #4a7c59 50%, #c9a227 100%)',
                    display: { xs: 'none', md: 'flex' },
                    flexDirection: 'column',
                    justifyContent: 'center',
                    p: 8,
                    color: 'white',
                }}
            >
                <Typography variant="h2" sx={{ fontWeight: 700, mb: 2 }}>
                    Gaia Healers
                </Typography>
                <Typography variant="h5" sx={{ mb: 4, opacity: 0.9 }}>
                    Elevate Conference Management - Check-in, Badging & Lead Retrieval
                </Typography>
                
                <Grid container spacing={3} sx={{ mt: 4 }}>
                    {features.map((feature, idx) => (
                        <Grid item xs={12} key={idx}>
                            <Card sx={{ bgcolor: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.3)' }}>
                                <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                    <Box sx={{ color: 'white' }}>{feature.icon}</Box>
                                    <Box>
                                        <Typography variant="h6" sx={{ color: 'white', fontWeight: 600 }}>
                                            {feature.title}
                                        </Typography>
                                        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.8)' }}>
                                            {feature.desc}
                                        </Typography>
                                    </Box>
                                </CardContent>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            </Box>

            {/* Right Side - Auth Form */}
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    p: { xs: 3, md: 8 },
                    bgcolor: 'background.default',
                }}
            >
                <Container maxWidth="sm">
                    <Paper elevation={0} sx={{ p: 4, bgcolor: 'transparent' }}>
                        <Typography variant="h4" sx={{ fontWeight: 700, mb: 1, textAlign: 'center' }}>
                            Welcome Back
                        </Typography>
                        <Typography variant="body1" color="text.secondary" sx={{ mb: 4, textAlign: 'center' }}>
                            Sign in to manage your events
                        </Typography>

                        {error && <Alert severity="error" sx={{ mb: 3, borderRadius: 2 }}>{error}</Alert>}

                        {activeTab === 0 ? (
                            <Box component="form" onSubmit={handleLogin}>
                                <TextField
                                    fullWidth
                                    label="Email Address"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    margin="normal"
                                    required
                                    sx={{ mb: 2 }}
                                />
                                <TextField
                                    fullWidth
                                    label="Password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    margin="normal"
                                    required
                                    sx={{ mb: 3 }}
                                />
                                <Button
                                    fullWidth
                                    variant="contained"
                                    size="large"
                                    type="submit"
                                    disabled={loading}
                                    sx={{ 
                                        py: 1.5,
                                        fontSize: '1.1rem',
                                    }}
                                >
                                    {loading ? 'Signing in...' : 'Sign In'}
                                </Button>
                            </Box>
                        ) : (
                            <Box component="form" onSubmit={handleRegister}>
                                <TextField
                                    fullWidth
                                    label="Full Name"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    margin="normal"
                                    required
                                    sx={{ mb: 2 }}
                                />
                                <TextField
                                    fullWidth
                                    label="Email Address"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    margin="normal"
                                    required
                                    sx={{ mb: 2 }}
                                />
                                <TextField
                                    fullWidth
                                    label="Password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    margin="normal"
                                    required
                                    sx={{ mb: 3 }}
                                />
                                <Button
                                    fullWidth
                                    variant="contained"
                                    size="large"
                                    type="submit"
                                    disabled={loading}
                                    sx={{ 
                                        py: 1.5,
                                        fontSize: '1.1rem',
                                    }}
                                >
                                    {loading ? 'Creating Account...' : 'Create Account'}
                                </Button>
                            </Box>
                        )}

                        <Typography variant="caption" color="text.secondary" sx={{ mt: 4, display: 'block', textAlign: 'center' }}>
                            By continuing, you agree to our Terms of Service and Privacy Policy.
                        </Typography>
                    </Paper>
                </Container>
            </Box>
        </Box>
    );
}

export default Login;
