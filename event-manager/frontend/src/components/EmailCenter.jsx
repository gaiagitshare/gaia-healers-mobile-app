import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Stack, Tab, Tabs, Typography } from '@mui/material';
import { ecMe, ecProposals } from '../utils/api';
import { errText } from './EmailCenterShared';
import EmailCenterOverview from './EmailCenterOverview';
import EmailCenterTickets from './EmailCenterTickets';
import EmailCenterExhibitors from './EmailCenterExhibitors';
import EmailCenterHistory from './EmailCenterHistory';
import EmailCenterAttention from './EmailCenterAttention';
import EmailCenterApprovals from './EmailCenterApprovals';

/**
 * Email Center — review and send the event's ticket and exhibitor emails.
 *
 * Every control is driven by GET /me: what this person may do, and whether
 * sending is possible at all right now. The server enforces the same rules;
 * hiding a button here only stops people pressing something that will refuse.
 * Contract: docs/EMAIL_CENTER_API.md.
 */
const TABS = [
    ['overview', 'Overview'],
    ['tickets', 'Attendee Tickets'],
    ['exhibitors', 'Exhibitor Emails'],
    ['attention', 'Needs Attention'],
    ['approvals', 'Approvals'],
    ['history', 'Delivery History'],
];

export default function EmailCenter() {
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const [me, setMe] = useState(null);
    const [error, setError] = useState('');
    const [extra, setExtra] = useState({}); // cross-tab hand-off: {filter, openKey, focus, focusId}
    const [waiting, setWaiting] = useState(null); // proposals waiting for approval (tab badge)

    const loadMe = useCallback(() => ecMe(id).then((r) => { setMe(r.data); setError(''); }).catch((e) => setError(errText(e))), [id]);
    useEffect(() => { loadMe(); }, [loadMe]);
    const loadWaiting = useCallback(() => ecProposals(id, 'proposed').then((r) => setWaiting((r.data.items || []).length)).catch(() => {}), [id]);

    const tabs = TABS.filter(([k]) => k !== 'exhibitors' || me?.exhibitors);
    const want = params.get('tab') || 'overview';
    const tab = tabs.some(([k]) => k === want) ? want : 'overview';
    useEffect(() => { if (me?.read) loadWaiting(); }, [tab, me?.read, loadWaiting]); // a proposal made in a Review panel shows on the badge
    const goTab = useCallback((key, more = {}) => {
        setExtra(more);
        setParams((p) => { const n = new URLSearchParams(p); n.set('tab', key); return n; }, { replace: true });
    }, [setParams]);
    const clearOpenKey = useCallback(() => setExtra((x) => ({ ...x, openKey: undefined, focus: undefined })), []);

    if (!me) {
        return error
            ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={loadMe}>Try again</Button>}>{error}</Alert>
            : <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>;
    }
    if (!me.read) return <Alert severity="warning">You do not have access to the Email Center for this event.</Alert>;

    const s = me.sending || {};
    return (
        <Box>
            <Stack sx={{ mb: 1 }}>
                <Typography variant="h5">Email Center</Typography>
                <Typography variant="body2" color="text.secondary">
                    Review each order, approve it, then send its official ticket email — and follow every email until it is delivered.
                    Times are Dubai time (GST).
                </Typography>
            </Stack>

            {s.fake_gateway && (
                <Alert severity="info" variant="filled" sx={{ mb: 1 }}>
                    <b>Test mode — emails go to a simulated mailbox; nothing reaches anyone.</b>
                </Alert>
            )}
            {(!s.enabled || !me.sending_exhibitors?.enabled) && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                    <b>Ticket emails: {s.enabled ? 'ON' : 'OFF'} · Exhibitor emails: {me.sending_exhibitors?.enabled ? 'ON' : 'OFF'}.</b>
                    {' '}Each has its own switch on the Overview. Send buttons for a switched-off kind stay disabled.
                </Alert>
            )}
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}

            <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
                <Tabs value={tab} onChange={(_, v) => goTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile>
                    {tabs.map(([k, l]) => <Tab key={k} value={k} label={k === 'approvals' && waiting ? `${l} (${waiting})` : l} sx={{ textTransform: 'none' }} />)}
                </Tabs>
            </Box>

            {tab === 'overview' && <EmailCenterOverview eventId={id} me={me} reloadMe={loadMe} goTab={goTab} />}
            {tab === 'tickets' && <EmailCenterTickets eventId={id} me={me} initialFilter={extra.filter} openKey={extra.openKey} openFocus={extra.focus} onOpened={clearOpenKey} />}
            {tab === 'exhibitors' && <EmailCenterExhibitors eventId={id} me={me} focusId={extra.focusId} />}
            {tab === 'history' && <EmailCenterHistory eventId={id} me={me} />}
            {tab === 'attention' && <EmailCenterAttention eventId={id} me={me} goTab={goTab} />}
            {tab === 'approvals' && <EmailCenterApprovals eventId={id} me={me} goTab={goTab} onCount={setWaiting} />}
        </Box>
    );
}
