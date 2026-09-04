import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box, Card, CardContent, Typography, TextField, Button, Stack,
    Chip, Divider, Alert, IconButton, Tooltip,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
    getEventPosts, moderatePost, announceToEvent,
    suspendMember, unsuspendMember, getCommunityBans,
} from '../utils/api';

// Community moderation. Post-moderation: posts are already live; here an
// organiser removes what shouldn't be up, pins what should stay on top,
// suspends a repeat offender, and posts announcements. Reported posts float
// to the top so nothing waits unseen.
function CommunityAdmin() {
    const { id } = useParams();
    const [posts, setPosts] = useState([]);
    const [bans, setBans] = useState([]);
    const [announce, setAnnounce] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        getEventPosts(id).then((r) => setPosts(r.data?.posts || [])).catch(() => setPosts([]));
        getCommunityBans(id).then((r) => setBans(r.data?.bans || [])).catch(() => setBans([]));
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const act = async (postId, action) => {
        await moderatePost(postId, action).catch(() => {});
        load();
    };
    const doAnnounce = async () => {
        if (!announce.trim()) return;
        setError(null); setBusy(true);
        try {
            await announceToEvent(id, announce.trim());
            setAnnounce('');
            load();
        } catch (e) {
            setError(e.response?.data?.detail || 'Could not post the announcement.');
        } finally { setBusy(false); }
    };
    const doSuspend = async (p) => {
        if (!p.author_key) return;
        if (!window.confirm(`Suspend ${p.author_name} from posting in this event? Their existing posts will be hidden.`)) return;
        await suspendMember(id, p.author_key, p.author_name).catch(() => {});
        load();
    };
    const doUnsuspend = async (b) => {
        await unsuspendMember(id, b.member_key).catch(() => {});
        load();
    };

    const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
    const reported = posts.filter((p) => (p.report_count || 0) > 0 && !p.is_announcement);

    const PostRow = ({ p }) => (
        <Box>
            <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ py: 1.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2">{p.author_name || 'Member'}</Typography>
                        {p.is_announcement && <Chip size="small" color="primary" label="Announcement" />}
                        {p.is_pinned && !p.is_announcement && <Chip size="small" variant="outlined" label="Pinned" />}
                        {p.is_hidden && <Chip size="small" color="error" label="Hidden" />}
                        {p.parent_id ? <Chip size="small" variant="outlined" label="Reply" /> : null}
                        {(p.report_count || 0) > 0 && <Chip size="small" color="warning" label={`${p.report_count} report${p.report_count === 1 ? '' : 's'}`} />}
                        <Typography variant="caption" color="text.secondary">{when(p.created_at)}</Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.body}</Typography>
                    {p.image_url && (
                        <Box component="img" src={p.image_url} alt="" sx={{ mt: 1, maxWidth: 220, borderRadius: 1, display: 'block' }} />
                    )}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {p.like_count || 0} like{(p.like_count || 0) === 1 ? '' : 's'}
                        {p.author_key && !p.is_announcement ? ` · id ${p.author_key.slice(0, 10)}…` : ''}
                    </Typography>
                    <Stack direction="row" spacing={0.5} sx={{ mt: 1 }} flexWrap="wrap">
                        <Button size="small" onClick={() => act(p.id, p.is_pinned ? 'unpin' : 'pin')}>
                            {p.is_pinned ? 'Unpin' : 'Pin'}
                        </Button>
                        <Button size="small" onClick={() => act(p.id, p.is_hidden ? 'unhide' : 'hide')}>
                            {p.is_hidden ? 'Unhide' : 'Hide'}
                        </Button>
                        {(p.report_count || 0) > 0 && (
                            <Button size="small" onClick={() => act(p.id, 'clear_reports')}>Clear reports</Button>
                        )}
                        {p.author_key && !p.is_announcement && (
                            <Button size="small" color="warning" onClick={() => doSuspend(p)}>Suspend author</Button>
                        )}
                    </Stack>
                </Box>
                <Tooltip title="Delete permanently">
                    <IconButton size="small" color="error" aria-label="Delete post"
                        onClick={() => { if (window.confirm('Delete this post permanently?')) act(p.id, 'delete'); }}>
                        <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
            </Stack>
            <Divider />
        </Box>
    );

    return (
        <Box sx={{ maxWidth: 760 }}>
            <Typography variant="h4" gutterBottom>Community</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                The public feed attendees see in the app. Posts appear immediately; remove, pin or
                hide them here, suspend a member from posting, and post pinned announcements.
            </Typography>

            <Card sx={{ mb: 3 }}>
                <CardContent>
                    <Typography variant="subtitle2" gutterBottom>Post an announcement</Typography>
                    <Typography variant="caption" color="text.secondary">
                        Pinned to the top of the feed for everyone — and sent as a push notification.
                    </Typography>
                    <TextField
                        value={announce}
                        onChange={(e) => setAnnounce(e.target.value)}
                        fullWidth multiline minRows={2}
                        placeholder="e.g. Doors open at 8am — grab your badge at registration."
                        sx={{ mt: 1.5 }}
                    />
                    {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
                    <Box sx={{ mt: 1.5 }}>
                        <Button variant="contained" onClick={doAnnounce} disabled={busy || !announce.trim()}>
                            {busy ? 'Posting…' : 'Post announcement'}
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {reported.length > 0 && (
                <Card sx={{ mb: 3, borderColor: 'warning.main', borderWidth: 1, borderStyle: 'solid' }}>
                    <CardContent>
                        <Typography variant="subtitle2" color="warning.main" gutterBottom>
                            Reported · {reported.length}
                        </Typography>
                        {reported.map((p) => <PostRow key={`r-${p.id}`} p={p} />)}
                    </CardContent>
                </Card>
            )}

            {bans.length > 0 && (
                <Card sx={{ mb: 3 }}>
                    <CardContent>
                        <Typography variant="subtitle2" gutterBottom>Suspended · {bans.length}</Typography>
                        {bans.map((b) => (
                            <Stack key={b.id} direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
                                <Typography variant="body2" sx={{ flex: 1 }}>{b.author_name || b.member_key}</Typography>
                                <Button size="small" onClick={() => doUnsuspend(b)}>Unsuspend</Button>
                            </Stack>
                        ))}
                    </CardContent>
                </Card>
            )}

            <Typography variant="overline" color="text.secondary">All posts · {posts.length}</Typography>
            {posts.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    No posts yet.
                </Typography>
            ) : (
                <Card variant="outlined">
                    <CardContent sx={{ py: 0.5 }}>
                        {posts.map((p) => <PostRow key={p.id} p={p} />)}
                    </CardContent>
                </Card>
            )}
        </Box>
    );
}

export default CommunityAdmin;
