import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
    Box,
    Drawer,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    AppBar,
    Toolbar,
    Typography,
    IconButton,
    Avatar,
    Menu,
    MenuItem,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Button,
    Alert,
    Stack,
    useMediaQuery,
    useTheme,
} from '@mui/material';
import {
    Dashboard as DashboardIcon,
    Event as EventIcon,
    Menu as MenuIcon,
    QrCodeScanner as CheckInIcon,
    Payments as PaymentsIcon,
    Password as PasswordIcon,
    Logout as LogoutIcon,
    FactCheck as ReviewIcon,
} from '@mui/icons-material';
import { changePassword } from '../utils/api';

const drawerWidth = 240;

function Layout({ children, user, onLogout }) {
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useTheme();
    const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
    const [anchorEl, setAnchorEl] = React.useState(null);
    const [pwOpen, setPwOpen] = React.useState(false);
    const [curPw, setCurPw] = React.useState('');
    const [newPw, setNewPw] = React.useState('');
    const [confPw, setConfPw] = React.useState('');
    const [pwErr, setPwErr] = React.useState('');
    const [pwOk, setPwOk] = React.useState(false);
    const [pwBusy, setPwBusy] = React.useState(false);
    const openPw = () => { setPwErr(''); setPwOk(false); setCurPw(''); setNewPw(''); setConfPw(''); setPwOpen(true); setAnchorEl(null); };
    const submitPw = async () => {
        setPwErr('');
        if (newPw.length < 8) { setPwErr('New password must be at least 8 characters.'); return; }
        if (newPw !== confPw) { setPwErr('New passwords do not match.'); return; }
        setPwBusy(true);
        try {
            await changePassword(curPw, newPw);
            setPwOk(true); setCurPw(''); setNewPw(''); setConfPw('');
        } catch (e) {
            setPwErr((e.response && e.response.data && e.response.data.detail) || 'Could not change password.');
        } finally { setPwBusy(false); }
    };
    const [mobileOpen, setMobileOpen] = React.useState(false);

    const menuItems = [
        { text: 'Dashboard', icon: <DashboardIcon />, path: '/dashboard' },
        { text: 'Events', icon: <EventIcon />, path: '/events' },
        { text: 'Check-In', icon: <CheckInIcon />, path: '/checkin' },
        { text: 'Payments', icon: <PaymentsIcon />, path: '/payments' },
        { text: 'Entitlement Review', icon: <ReviewIcon />, path: '/entitlement-review' },
    ];

    const handleProfileClick = (event) => {
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
    };

    const handleNavigate = (path) => {
        navigate(path);
        setMobileOpen(false);
    };

    const drawerContent = (
        <>
            <Toolbar />
            <Box sx={{ overflow: 'auto' }}>
                <List>
                    {menuItems.map((item) => (
                        <ListItem key={item.text} disablePadding>
                            <ListItemButton
                                selected={location.pathname === item.path}
                                onClick={() => handleNavigate(item.path)}
                            >
                                <ListItemIcon>{item.icon}</ListItemIcon>
                                <ListItemText primary={item.text} />
                            </ListItemButton>
                        </ListItem>
                    ))}
                </List>
            </Box>
        </>
    );

    return (
        <Box sx={{ display: 'flex' }}>
            <AppBar
                position="fixed"
                sx={{
                    zIndex: (theme) => theme.zIndex.drawer + 1,
                    width: { md: `calc(100% - ${drawerWidth}px)` },
                    ml: { md: `${drawerWidth}px` },
                }}
            >
                <Toolbar>
                    {!isDesktop && (
                        <IconButton
                            color="inherit"
                            edge="start"
                            onClick={() => setMobileOpen(true)}
                            sx={{ mr: 1 }}
                        >
                            <MenuIcon />
                        </IconButton>
                    )}
                    <Typography
                        variant="h6"
                        noWrap
                        component="div"
                        sx={{ flexGrow: 1, fontSize: { xs: '1rem', sm: '1.25rem' } }}
                    >
                        Gaia Healers Event Manager
                    </Typography>
                    <IconButton onClick={handleProfileClick} color="inherit">
                        <Avatar sx={{ width: 32, height: 32 }}>
                            {user?.user?.full_name?.[0] || 'U'}
                        </Avatar>
                    </IconButton>
                    <Menu
                        anchorEl={anchorEl}
                        open={Boolean(anchorEl)}
                        onClose={handleClose}
                    >
                        <MenuItem onClick={openPw}>
                            <PasswordIcon sx={{ mr: 1 }} /> Change password
                        </MenuItem>
                        <MenuItem onClick={() => { onLogout(); handleClose(); }}>
                            <LogoutIcon sx={{ mr: 1 }} /> Logout
                        </MenuItem>
                    </Menu>
                    <Dialog open={pwOpen} onClose={() => setPwOpen(false)} maxWidth="xs" fullWidth>
                        <DialogTitle>Change password</DialogTitle>
                        <DialogContent>
                            <Stack spacing={2} sx={{ mt: 1 }}>
                                {pwOk && <Alert severity="success">Password changed. Use your new password next time you sign in.</Alert>}
                                {pwErr && <Alert severity="error">{pwErr}</Alert>}
                                <TextField type="password" label="Current password" value={curPw}
                                    onChange={(e) => setCurPw(e.target.value)} fullWidth autoComplete="current-password" />
                                <TextField type="password" label="New password (min 8 characters)" value={newPw}
                                    onChange={(e) => setNewPw(e.target.value)} fullWidth autoComplete="new-password" />
                                <TextField type="password" label="Confirm new password" value={confPw}
                                    onChange={(e) => setConfPw(e.target.value)} fullWidth autoComplete="new-password" />
                            </Stack>
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={() => setPwOpen(false)}>Close</Button>
                            <Button variant="contained" onClick={submitPw}
                                disabled={pwBusy || !curPw || !newPw || !confPw}>
                                {pwBusy ? 'Saving…' : 'Update password'}
                            </Button>
                        </DialogActions>
                    </Dialog>
                </Toolbar>
            </AppBar>
            <Drawer
                variant="temporary"
                open={mobileOpen}
                onClose={() => setMobileOpen(false)}
                ModalProps={{ keepMounted: true }}
                sx={{
                    display: { xs: 'block', md: 'none' },
                    [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: 'border-box' },
                }}
            >
                {drawerContent}
            </Drawer>
            <Drawer
                variant="permanent"
                sx={{
                    display: { xs: 'none', md: 'block' },
                    width: drawerWidth,
                    flexShrink: 0,
                    [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: 'border-box' },
                }}
            >
                {drawerContent}
            </Drawer>
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    width: { xs: '100%', md: `calc(100% - ${drawerWidth}px)` },
                    minWidth: 0,
                    p: { xs: 2, sm: 3 },
                }}
            >
                <Toolbar />
                {children}
            </Box>
        </Box>
    );
}

export default Layout;
