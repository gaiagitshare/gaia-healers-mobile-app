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
    Tooltip,
    useMediaQuery,
    useTheme,
} from '@mui/material';
import {
    Dashboard as DashboardIcon,
    Event as EventIcon,
    ListAlt as ListAltIcon,
    Menu as MenuIcon,
    QrCodeScanner as CheckInIcon,
    Payments as PaymentsIcon,
    Password as PasswordIcon,
    Logout as LogoutIcon,
    FactCheck as ReviewIcon,
} from '@mui/icons-material';
import { changePassword, isPlatformAdmin, getEvents, getMyCapabilities } from '../utils/api';

const drawerWidth = 240;
// iPad and smaller windows (900-1279 px): a slim icon strip instead of the full
// menu, so the page gets the width (11 Nov 2026). Below 900 px the menu opens
// from the top-left button as before.
const railWidth = 72;

// App-wide pages only platform admins can use (the server refuses the rest).
const ADMIN_ONLY_PATHS = ['/dashboard', '/payments', '/entitlement-review'];

function Layout({ children, user, onLogout }) {
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useTheme();
    const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
    const isWide = useMediaQuery('(min-width:1280px)');
    const navWidth = isWide ? drawerWidth : railWidth;
    const [anchorEl, setAnchorEl] = React.useState(null);
    const [pwOpen, setPwOpen] = React.useState(false);
    const [curPw, setCurPw] = React.useState('');
    const [newPw, setNewPw] = React.useState('');
    const [confPw, setConfPw] = React.useState('');
    const [pwErr, setPwErr] = React.useState('');
    const [pwOk, setPwOk] = React.useState(false);
    const [pwBusy, setPwBusy] = React.useState(false);
    // Check-In is shown to non-admins only when they can work a door at one of
    // their events (station-only and email-only roles never see it).
    const [canCheckin, setCanCheckin] = React.useState(isPlatformAdmin());
    React.useEffect(() => {
        if (isPlatformAdmin()) return undefined;
        let live = true;
        getEvents().then((r) => Promise.all((r.data || []).slice(0, 5).map((ev) => getMyCapabilities(ev.id)
            .then((c) => (c.data?.capabilities || []).includes('checkin.perform')).catch(() => false))))
            .then((xs) => { if (live) setCanCheckin(xs.some(Boolean)); })
            .catch(() => { if (live) setCanCheckin(false); });
        return () => { live = false; };
    }, []);
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
        // Events goes straight into the current event; All Events is the list.
        { text: 'Events', icon: <EventIcon />, path: '/events/current' },
        { text: 'All Events', icon: <ListAltIcon />, path: '/events/all' },
        { text: 'Check-In', icon: <CheckInIcon />, path: '/checkin' },
        { text: 'Payments', icon: <PaymentsIcon />, path: '/payments' },
        { text: 'Entitlement Review', icon: <ReviewIcon />, path: '/entitlement-review' },
    ].filter((item) => isPlatformAdmin() || (!ADMIN_ONLY_PATHS.includes(item.path) && (item.path !== '/checkin' || canCheckin)));

    const handleProfileClick = (event) => {
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
    };

    // /events/<id> is "Events" (the event workspace); /events/all is "All Events".
    const isSelected = (path) => {
        const p = location.pathname;
        if (path === '/events/current') return /^\/events\/(current|\d+)(\/|$)/.test(p);
        return p === path || p.startsWith(path + '/');
    };

    const handleNavigate = (path) => {
        navigate(path);
        setMobileOpen(false);
    };

    const railContent = (
        <>
            <Toolbar />
            <List sx={{ px: 0.5 }}>
                {menuItems.map((item) => (
                    <ListItem key={item.text} disablePadding sx={{ display: 'block' }}>
                        <Tooltip title={item.text} placement="right">
                            <ListItemButton selected={isSelected(item.path)} onClick={() => handleNavigate(item.path)}
                                aria-label={item.text}
                                sx={{ minHeight: 52, flexDirection: 'column', justifyContent: 'center', borderRadius: 2, px: 0.5 }}>
                                <ListItemIcon sx={{ minWidth: 0, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
                                <Typography variant="caption" sx={{ fontSize: 10, lineHeight: 1.1, mt: 0.25, textAlign: 'center' }} noWrap>
                                    {item.text.split(' ')[0]}
                                </Typography>
                            </ListItemButton>
                        </Tooltip>
                    </ListItem>
                ))}
            </List>
        </>
    );

    const drawerContent = (
        <>
            <Toolbar />
            <Box sx={{ overflow: 'auto' }}>
                <List>
                    {menuItems.map((item) => (
                        <ListItem key={item.text} disablePadding>
                            <ListItemButton
                                selected={isSelected(item.path)}
                                onClick={() => handleNavigate(item.path)}
                                sx={{ minHeight: 48 }}
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
                    width: { md: `calc(100% - ${navWidth}px)` },
                    ml: { md: `${navWidth}px` },
                }}
            >
                <Toolbar>
                    {!isDesktop && (
                        <IconButton
                            color="inherit"
                            edge="start"
                            aria-label="Open menu"
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
                        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>Gaia Healers </Box>Event Manager
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
                    width: navWidth,
                    flexShrink: 0,
                    [`& .MuiDrawer-paper`]: { width: navWidth, boxSizing: 'border-box', overflowX: 'hidden' },
                }}
            >
                {isWide ? drawerContent : railContent}
            </Drawer>
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    width: { xs: '100%', md: `calc(100% - ${navWidth}px)` },
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
