import React, { useCallback, useEffect, useState } from 'react';
import {
    Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardContent, CircularProgress, Dialog, DialogActions,
    DialogContent, DialogTitle, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography, useMediaQuery,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ecProposalDecide, ecProposals, ecProposalWithdraw } from '../utils/api';
import { errText, gst, is409 } from './EmailCenterShared';
import { ChangeLine, EvidenceTables, ProposalChip, rootCauseLabel, stepText, ValidationResult, valueText } from './EmailCenterProblems';

/**
 * Approvals — corrections proposed from the Review panel. Everyone with read
 * sees them; only a platform admin who did not propose one may decide it
 * (the server enforces both). Contract: docs/EMAIL_CENTER_API.md, "Approval queue".
 */
const STATES = [
    ['proposed', 'Waiting'],
    ['all', 'All'],
    ['applied,applied_still_flagged', 'Applied'],
    ['rejected', 'Rejected'],
    ['failed', 'Failed'],
];

const DECIDE = {
    approve: { title: 'Approve and apply', button: 'Approve and apply', color: 'success' },
    reject: { title: 'Reject this correction', button: 'Reject', color: 'error' },
    retry: { title: 'Retry the failed correction', button: 'Retry now', color: 'warning' },
    withdraw: { title: 'Withdraw your proposal', button: 'Withdraw', color: 'warning' },
};

function DecideDialog({ eventId, ask, onClose, onDone }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    useEffect(() => { setNote(''); setError(''); setResult(null); }, [ask]);
    if (!ask) return null;
    const { p, kind } = ask;
    const cfg = DECIDE[kind];
    const changes = kind === 'approve' || kind === 'retry';
    const go = () => {
        setBusy(true); setError('');
        const call = kind === 'withdraw' ? ecProposalWithdraw(eventId, p.id, note.trim()) : ecProposalDecide(eventId, p.id, kind, note.trim());
        call.then((r) => { setResult({ ...r.data, state: r.data.state || (kind === 'withdraw' ? 'withdrawn' : undefined) }); onDone(); })
            .catch((e) => { setError(errText(e)); if (is409(e)) onDone(); })
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={narrow} scroll="paper">
            <DialogTitle>{cfg.title} — #{p.id}</DialogTitle>
            <DialogContent dividers>
                {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
                {!result && <>
                    {changes && <Alert severity="warning" sx={{ mb: 1 }}>This changes ticket records: the steps below run once, then the order is re-checked. Nothing is emailed.</Alert>}
                    <Typography variant="body2" fontWeight={600}>{p.summary}</Typography>
                    <ChangeLine from={valueText(p.current_value)} to={valueText(p.proposed_value)} />
                    <Typography variant="subtitle2">Steps</Typography>
                    {(p.steps || []).map((s, i) => <Typography key={i} variant="body2">{i + 1}. {stepText(s)}</Typography>)}
                    <Typography variant="body2" sx={{ mt: 1 }}><b>Reason given:</b> {p.reason}</Typography>
                    <TextField fullWidth multiline minRows={2} sx={{ mt: 2 }} value={note} onChange={(e) => setNote(e.target.value)}
                               label={kind === 'reject' ? 'Why you reject it (required)' : kind === 'withdraw' ? 'Why you withdraw it (required)' : 'What you checked (required)'} />
                </>}
                {result && <>
                    <Alert severity={result.state === 'failed' ? 'error' : result.state === 'applied_still_flagged' ? 'warning' : 'success'} sx={{ mb: 1 }}>
                        {{ applied: 'Applied.', applied_still_flagged: 'Applied, but the re-check still finds the problem.', failed: 'A step failed. Nothing after it ran; you can retry.',
                           rejected: 'Rejected. Nothing was changed.', withdrawn: 'Withdrawn. Nothing was changed.' }[result.state] || `Result: ${result.state}`}
                    </Alert>
                    {(result.results || []).filter((r) => r.state === 'failed').map((r, i) => (
                        <Typography key={i} variant="body2" color="error">• {stepText({ action: r.action })} {String(r.error || '')}</Typography>
                    ))}
                    <ValidationResult v={result.validation} issueId={p.issue_id} />
                </>}
            </DialogContent>
            <DialogActions>
                {result ? <Button variant="contained" onClick={onClose}>Close</Button> : <>
                    <Button disabled={busy} onClick={onClose}>Cancel</Button>
                    <Button variant="contained" color={cfg.color} disabled={busy || note.trim().length < 3} onClick={go}>{busy ? 'Working…' : cfg.button}</Button>
                </>}
            </DialogActions>
        </Dialog>
    );
}

function ProposalCard({ p, me, canDecide, onOpen, onAsk }) {
    const mine = p.proposed_by_id != null && p.proposed_by_id === me?.user_id;
    return (
        <Card variant="outlined">
            <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                    <ProposalChip s={p.state} />
                    <Typography variant="subtitle2">#{p.id}</Typography>
                    {p.booking && <Button size="small" variant="outlined" onClick={() => onOpen(p.booking)}>Open order {p.booking}</Button>}
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1, textAlign: 'right' }}>
                        Proposed by {p.proposed_by || '—'} · {gst(p.proposed_at)}
                    </Typography>
                </Stack>
                <Typography variant="body1" fontWeight={600}>{p.summary}</Typography>
                <ChangeLine from={valueText(p.current_value)} to={valueText(p.proposed_value)} />
                <Typography variant="body2"><b>Reason:</b> {p.reason}</Typography>
                <Typography variant="body2"><b>Root cause:</b> {rootCauseLabel(p.root_cause)}</Typography>
                <Typography variant="subtitle2" sx={{ mt: 1 }}>Steps</Typography>
                {(p.steps || []).map((s, i) => <Typography key={i} variant="body2">{i + 1}. {stepText(s)}</Typography>)}
                {p.evidence && (
                    <Accordion disableGutters variant="outlined" sx={{ mt: 1 }}>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography variant="subtitle2">Evidence — payments and tickets</Typography></AccordionSummary>
                        <AccordionDetails><EvidenceTables ev={p.evidence} /></AccordionDetails>
                    </Accordion>
                )}
                {p.decided_by && (
                    <Typography variant="body2" sx={{ mt: 1 }}>
                        <b>Decided by</b> {p.decided_by} · {gst(p.decided_at)}{p.decision_note ? ` — “${p.decision_note}”` : ''}
                        {p.applied_at ? ` · applied ${gst(p.applied_at)}` : ''}
                    </Typography>
                )}
                {p.state === 'withdrawn' && !p.decided_by && p.decision_note && <Typography variant="body2" sx={{ mt: 1 }}>Withdrawn — “{p.decision_note}”</Typography>}
                {p.validation && <ValidationResult v={p.validation} issueId={p.issue_id} />}

                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mt: 1.5 }} alignItems="center">
                    {p.state === 'proposed' && canDecide && !mine && <>
                        <Button variant="contained" color="success" onClick={() => onAsk(p, 'approve')}>Approve and apply</Button>
                        <Button variant="outlined" color="error" onClick={() => onAsk(p, 'reject')}>Reject</Button>
                    </>}
                    {p.state === 'failed' && canDecide && !mine && <Button variant="contained" color="warning" onClick={() => onAsk(p, 'retry')}>Retry</Button>}
                    {['proposed', 'failed'].includes(p.state) && canDecide && mine && (
                        <Typography variant="body2" color="text.secondary">You proposed this — another admin must approve.</Typography>)}
                    {p.state === 'proposed' && mine && <Button color="warning" onClick={() => onAsk(p, 'withdraw')}>Withdraw</Button>}
                    {p.state === 'proposed' && !canDecide && !mine && (
                        <Typography variant="body2" color="text.secondary">Waiting for a platform admin to approve.</Typography>)}
                </Stack>
            </CardContent>
        </Card>
    );
}

export default function EmailCenterApprovals({ eventId, me, goTab, onCount }) {
    const [state, setState] = useState('proposed');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [ask, setAsk] = useState(null); // {p, kind}
    const load = useCallback(() => ecProposals(eventId, state)
        .then((r) => { setData(r.data); setError(''); if (state === 'proposed' && onCount) onCount((r.data.items || []).length); })
        .catch((e) => setError(errText(e))), [eventId, state, onCount]);
    useEffect(() => { setData(null); load(); }, [load]);
    const afterAction = () => {
        load();
        if (state !== 'proposed' && onCount) ecProposals(eventId, 'proposed').then((r) => onCount((r.data.items || []).length)).catch(() => {});
    };
    const items = data?.items || [];
    return (
        <Box>
            {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
                <Box sx={{ overflowX: 'auto' }}>
                    <ToggleButtonGroup size="small" exclusive value={state} onChange={(_, v) => v && setState(v)}>
                        {STATES.map(([v, l]) => <ToggleButton key={v} value={v} sx={{ textTransform: 'none' }}>{l}</ToggleButton>)}
                    </ToggleButtonGroup>
                </Box>
                <Typography variant="caption" color="text.secondary">
                    Corrections that change ticket records wait here. A platform admin who did not propose one approves it; it is then applied once and re-checked.
                </Typography>
            </Stack>
            {data && !data.can_decide && (
                <Alert severity="info" sx={{ mb: 1.5 }}>You can read these proposals. Only a platform admin can approve or reject them.</Alert>
            )}
            {!data && !error && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
            <Stack spacing={1.5}>
                {items.map((p) => (
                    <ProposalCard key={p.id} p={p} me={me} canDecide={Boolean(data?.can_decide)}
                                  onOpen={(key) => goTab('tickets', { openKey: key, focus: 'problems' })} onAsk={(x, kind) => setAsk({ p: x, kind })} />
                ))}
                {data && !items.length && <Alert severity="success">{state === 'proposed' ? 'No correction is waiting for approval.' : 'Nothing here.'}</Alert>}
            </Stack>
            <DecideDialog eventId={eventId} ask={ask} onClose={() => setAsk(null)} onDone={afterAction} />
        </Box>
    );
}
