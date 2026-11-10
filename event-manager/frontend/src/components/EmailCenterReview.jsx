import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
    Grid, IconButton, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography, useMediaQuery,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ecBooking, ecBookingOutcome, ecBookingPreview, ecProblems, ecRevalidate, ecReview, ecSendBooking } from '../utils/api';
import { ProblemsSection, WorkflowBar } from './EmailCenterProblems';
import {
    DeliveryChip, EmailFrame, errText, GatedButton, gst, is409, MapChip, money, NoteDialog, PAYMENT, RECON, ReviewChip, sendBlock,
} from './EmailCenterShared';

const RESENDABLE = new Set(['accepted', 'delivered', 'opened', 'clicked', 'bounced']);
const SEND_STATE = {
    sent: ['success', 'Sent. GHL accepted the email(s).'],
    partial: ['warning', 'Only some of the emails were sent.'],
    held: ['warning', 'Not sent: a ticket on this order is held.'],
    refused: ['warning', 'Not sent: a safety rule refused it.'],
    skipped: ['info', 'Nothing to send: every email of this order has already gone.'],
    failed: ['error', 'GHL refused the email.'],
    unknown: ['warning', 'GHL gave no clear answer. Check GHL before trying again, then settle the outcome.'],
};

function Section({ title, children, sx }) {
    return (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, ...sx }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>{title}</Typography>
            {children}
        </Paper>
    );
}

/**
 * The Review panel for one booking. `bookingKey` opens it; `onChanged(detail)`
 * lets the list replace its row after every action. `focus="problems"` scrolls
 * to "Problems & fixes" once it has loaded (used by Needs Attention).
 */
export default function EmailCenterReview({ eventId, bookingKey, me, onClose, onChanged, focus }) {
    const narrow = useMediaQuery('(max-width:700px)');
    const navigate = useNavigate();
    const [d, setD] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(null); // {severity, text}
    const [busy, setBusy] = useState(false);
    const [noteAsk, setNoteAsk] = useState(null); // {kind, ...}
    const [sendAsk, setSendAsk] = useState(null); // 'send' | 'retry'
    const [preview, setPreview] = useState(null);
    const [probs, setProbs] = useState(null);
    const [probsErr, setProbsErr] = useState('');
    const [recheck, setRecheck] = useState(null); // {at, v}
    const [rechecking, setRechecking] = useState(false);
    const problemsRef = useRef(null);
    const scrolled = useRef(false);

    const load = useCallback(() => {
        if (!bookingKey) return Promise.resolve();
        return ecBooking(eventId, bookingKey).then((r) => { setD(r.data); onChanged && onChanged(r.data); })
            .catch((e) => setError(errText(e)));
    }, [eventId, bookingKey, onChanged]);
    const loadProblems = useCallback(() => {
        if (!bookingKey) return Promise.resolve();
        return ecProblems(eventId, bookingKey).then((r) => { setProbs(r.data); setProbsErr(''); }).catch((e) => setProbsErr(errText(e)));
    }, [eventId, bookingKey]);
    // After any fix, proposal, note or assignment: problems, detail and the list row.
    const reloadAll = useCallback(() => Promise.all([loadProblems(), load()]), [loadProblems, load]);
    useEffect(() => {
        setD(null); setError(''); setNotice(null); setPreview(null); setProbs(null); setProbsErr(''); setRecheck(null);
        scrolled.current = false;
        reloadAll();
    }, [reloadAll]);
    useEffect(() => {
        if (focus === 'problems' && probs && d && !scrolled.current && problemsRef.current) {
            scrolled.current = true;
            problemsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, [focus, probs, d]);
    const recheckNow = () => {
        setRechecking(true); setProbsErr('');
        ecRevalidate(eventId, bookingKey).then((r) => { setRecheck({ at: new Date().toISOString(), v: r.data }); return reloadAll(); })
            .catch((e) => setProbsErr(errText(e))).finally(() => setRechecking(false));
    };

    // Every action: send the fingerprint we displayed; on 409 say why and reload.
    const run = (p, onOk) => {
        setBusy(true); setError('');
        return p.then((r) => { onOk && onOk(r.data); setNoteAsk(null); setSendAsk(null); return reloadAll(); })
            .catch((e) => {
                if (is409(e)) {
                    setNotice({ severity: 'warning', text: `${errText(e)} The panel has been reloaded: check it again before acting.` });
                    setNoteAsk(null); setSendAsk(null); reloadAll();
                } else setError(errText(e));
            })
            .finally(() => setBusy(false));
    };
    const review = (action, note = '') => run(ecReview(eventId, d.key, { action, note, fingerprint: d.fingerprint }),
        () => setNotice({ severity: 'success', text: `${{ verify: 'Verified', approve: 'Approved', flag: 'Flagged for review', hold: 'Held', reset: 'Reset to pending' }[action]}.` }));
    const sendResult = (r) => {
        const [sev, text] = SEND_STATE[r.state] || ['info', `Result: ${r.state}.`];
        setNotice({ severity: sev, text: `${text}${r.reason ? ` ${r.reason}` : ''}` });
    };
    const send = (extra = {}) => run(ecSendBooking(eventId, d.key, { fingerprint: d.fingerprint, ...extra }), sendResult);
    const openPreview = () => {
        setPreview({ loading: true });
        ecBookingPreview(eventId, d.key).then((r) => setPreview({ emails: r.data.emails || [] }))
            .catch((e) => { setPreview(null); setError(errText(e)); });
    };

    const blocked = (d?.critical || []).length > 0;
    const sBlock = sendBlock(me);
    const units = d?.units || [];
    const unknownUnits = units.filter((u) => u.delivery === 'unknown');
    const pendingUnits = units.filter((u) => u.delivery === 'not_sent');
    const failedUnits = units.filter((u) => ['failed', 'bounced'].includes(u.delivery));
    const canResend = RESENDABLE.has(d?.delivery);
    const match = d && d.paid_for === d.tickets_generated;

    const confirmUnits = sendAsk === 'retry' ? failedUnits : pendingUnits;
    return (
        <Dialog open={Boolean(bookingKey)} onClose={onClose} fullWidth maxWidth="lg" fullScreen={narrow} scroll="paper">
            <DialogTitle sx={{ pr: 6 }}>
                {d ? <>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                        <Typography variant="h6" component="span">Order {d.order_number || d.key}</Typography>
                        <ReviewChip s={d.review_state} />
                        <DeliveryChip s={d.delivery} />
                        <MapChip map={RECON} s={d.reconciliation} />
                        {d.changed_since_review && <Chip size="small" color="warning" label="Changed since review" />}
                        {d.late_order && <Chip size="small" variant="outlined" label="Late order" />}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">{d.purchaser_name} · {d.purchaser_email}{d.order_ids?.length > 1 ? ` · GHL orders ${d.order_ids.join(', ')}` : ''}</Typography>
                </> : 'Loading…'}
                <IconButton onClick={onClose} aria-label="Close" sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
            </DialogTitle>
            <DialogContent dividers>
                {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
                {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 1 }}>{notice.text}</Alert>}
                {!d && !error && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
                {d && <>
                    <WorkflowBar stage={probs?.workflow_stage} />
                    <ProblemsSection ref={problemsRef} eventId={eventId} data={probs} loading={!probs} error={probsErr} me={me} booking={d}
                                     onChanged={reloadAll} onRecheck={recheckNow} recheck={recheck} rechecking={rechecking} />

                    <Paper sx={{ p: 2, mb: 2, textAlign: 'center', bgcolor: match ? 'success.main' : 'error.main', color: '#fff' }}>
                        <Typography variant="h5" fontWeight={700}>Paid for {d.paid_for} · Generated {d.tickets_generated}</Typography>
                        <Typography variant="body2">{match ? 'The numbers match.' : 'The numbers do not match. Fix it under Problems & fixes above before approving.'}</Typography>
                    </Paper>

                    {blocked && (
                        <Alert severity="error" sx={{ mb: 1 }}>
                            <b>Blockers — this order cannot be approved or sent until these are fixed:</b>
                            {d.critical.map((c, i) => <div key={i}>• {c.detail}</div>)}
                        </Alert>
                    )}
                    {d.warnings?.length > 0 && (
                        <Alert severity="warning" sx={{ mb: 2 }}>
                            <b>Warnings — check these before approving:</b>
                            {d.warnings.map((w, i) => <div key={i}>• {w.detail}</div>)}
                        </Alert>
                    )}

                    {/* Actions */}
                    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }} alignItems="center">
                            {me?.review && <>
                                <GatedButton variant="outlined" disabled={busy} reason={blocked ? 'Fix the blockers first.' : ''} onClick={() => review('verify')}>Verify</GatedButton>
                                <GatedButton variant="contained" color="success" disabled={busy || !d.can_approve}
                                             reason={blocked ? 'Cannot approve while there are blockers.' : ''} onClick={() => review('approve')}>Approve</GatedButton>
                                <Button variant="outlined" color="warning" disabled={busy} onClick={() => setNoteAsk({ kind: 'flag' })}>Flag for review</Button>
                                <Button variant="outlined" color="warning" disabled={busy} onClick={() => setNoteAsk({ kind: 'hold' })}>Hold</Button>
                                <Button disabled={busy || d.review_state === 'pending_review'} onClick={() => review('reset')}>Reset to pending</Button>
                                <Divider orientation="vertical" flexItem />
                            </>}
                            <Button variant="outlined" onClick={openPreview}>Preview email</Button>
                            {me?.send && <>
                                {pendingUnits.length > 0 && (
                                    <GatedButton variant="contained" disabled={busy || !d.sendable}
                                                 reason={sBlock || (!d.sendable ? (d.review_state !== 'approved' ? 'Approve the order first.' : 'This order cannot be sent right now.') : '')}
                                                 onClick={() => setSendAsk('send')}>Send email</GatedButton>)}
                                {d.retryable && <GatedButton variant="contained" color="warning" disabled={busy} reason={sBlock} onClick={() => setSendAsk('retry')}>Retry</GatedButton>}
                                {canResend && <GatedButton variant="outlined" disabled={busy} reason={sBlock} onClick={() => setNoteAsk({ kind: 'resend' })}>Resend</GatedButton>}
                                {unknownUnits.length > 0 && (
                                    <Button variant="outlined" color="warning" disabled={busy} onClick={() => setNoteAsk({ kind: 'outcome' })}>Settle uncertain outcome</Button>)}
                            </>}
                        </Stack>
                        {d.review?.reviewed_by && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                Reviewed by {d.review.reviewed_by} · {gst(d.review.reviewed_at)}
                                {d.review.approved_by ? ` · Approved by ${d.review.approved_by} · ${gst(d.review.approved_at)}` : ''}
                                {d.review.note ? ` · “${d.review.note}”` : ''}
                            </Typography>
                        )}
                    </Paper>

                    <Grid container spacing={2}>
                        <Grid item xs={12} md={5}>
                            <Section title={`What they bought — paid for ${d.paid_for}`}>
                                <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
                                    <MapChip map={PAYMENT} s={d.payment_status} />
                                    <Typography variant="body2">Total paid {money(d.amount_paid)}</Typography>
                                </Stack>
                                {(d.payments || []).map((p, i) => (
                                    <Box key={i} sx={{ py: 1, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
                                        <Typography variant="body2" fontWeight={600}>{(p.products || []).join(', ') || p.type || 'Payment'}</Typography>
                                        <Typography variant="body2">
                                            Order {p.order_id} · {money(p.amount, p.currency)} · {p.status}{p.refunded ? ` · refunded ${money(p.refunded, p.currency)}` : ''}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {gst(p.paid_at)}{p.buyer_name ? ` · ${p.buyer_name}` : ''}{p.buyer_email ? ` · ${p.buyer_email}` : ''}{p.ticket_id ? ` · ticket #${p.ticket_id}` : ''}
                                        </Typography>
                                    </Box>
                                ))}
                                {!d.payments?.length && <Typography variant="body2">No payment record found.</Typography>}
                            </Section>
                        </Grid>
                        <Grid item xs={12} md={7}>
                            <Section title={`What we generated — ${d.tickets_generated} ticket${d.tickets_generated === 1 ? '' : 's'}`}>
                                {(d.tickets || []).map((t, i) => (
                                    <Stack key={t.id} direction="row" spacing={1.5} sx={{ py: 1, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
                                        <Box sx={{ width: 84, flexShrink: 0, textAlign: 'center' }}>
                                            {t.qr_image_url
                                                ? <Box component="img" src={t.qr_image_url} alt={`QR code for ticket ${t.id}`} sx={{ width: 84, height: 84, display: 'block', bgcolor: '#fff' }} />
                                                : <Box sx={{ width: 84, height: 84, border: 1, borderColor: 'error.main', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                    <Typography variant="caption" color="error">No QR</Typography></Box>}
                                            {t.qr_code && <Typography variant="caption" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 10 }}>{t.qr_code}</Typography>}
                                        </Box>
                                        <Box sx={{ flex: 1, minWidth: 0 }}>
                                            <Typography variant="body2" fontWeight={600}>
                                                #{t.id} · {t.name}{t.is_buyer ? ' (buyer)' : ''}
                                            </Typography>
                                            <Typography variant="body2">{t.ticket_type}{t.pass && t.pass !== t.ticket_type ? ` · ${t.pass}` : ''}{t.seat ? ` · seat ${t.seat}` : ''}</Typography>
                                            {t.includes && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Includes: {Array.isArray(t.includes) ? t.includes.join(', ') : t.includes}</Typography>}
                                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.email}</Typography>
                                            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                                                <Chip size="small" variant="outlined" label={t.status} />
                                                {t.qr_valid === false && <Chip size="small" color="error" label="QR invalid" />}
                                                {t.held && <Chip size="small" color="warning" label="Held" />}
                                                {t.needs_name_check && <Chip size="small" color="warning" label="Name to confirm" />}
                                                {t.checked_in && <Chip size="small" color="success" label={`Checked in ${gst(t.checked_in_at)}`} />}
                                                {t.ticket_url && <Button size="small" href={t.ticket_url} target="_blank" rel="noopener noreferrer">View ticket</Button>}
                                            </Stack>
                                        </Box>
                                    </Stack>
                                ))}
                                {!d.tickets?.length && <Typography variant="body2" color="error">No tickets generated.</Typography>}
                            </Section>
                        </Grid>
                    </Grid>

                    <Section title={`Recipients — ${units.length} email${units.length === 1 ? '' : 's'}`}>
                        <Box sx={{ overflowX: 'auto' }}>
                            <Table size="small">
                                <TableHead><TableRow>
                                    <TableCell>Recipient</TableCell><TableCell>Tickets</TableCell><TableCell>Status</TableCell>
                                    <TableCell>Attempts</TableCell><TableCell>GHL status</TableCell><TableCell>Last update</TableCell><TableCell>Result</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {units.map((u) => (
                                        <TableRow key={u.unit_key}>
                                            <TableCell>{u.recipient || <Typography color="error" variant="body2">No email</Typography>}</TableCell>
                                            <TableCell>{(u.ticket_ids || []).map((x) => `#${x}`).join(', ')}{u.held_ticket_ids?.length ? ` (held: ${u.held_ticket_ids.join(', ')})` : ''}</TableCell>
                                            <TableCell><DeliveryChip s={u.delivery} /></TableCell>
                                            <TableCell>{u.attempts ?? 0}</TableCell>
                                            <TableCell>{u.provider_status || '—'}{u.provider_checked_at ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>checked {gst(u.provider_checked_at)}</Typography> : null}</TableCell>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(u.last_update)}</TableCell>
                                            <TableCell sx={{ minWidth: 200 }}>{u.result || '—'}</TableCell>
                                        </TableRow>
                                    ))}
                                    {!units.length && <TableRow><TableCell colSpan={7}>No email planned for this order.</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                        </Box>
                    </Section>

                    {d.issues?.length > 0 && (
                        <Section title="Reconciliation cases">
                            {d.issues.map((x) => (
                                <Box key={x.id} sx={{ py: 1, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0 } }}>
                                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                                        <Chip size="small" label={x.priority} color={x.priority === 'critical' ? 'error' : x.priority === 'high' ? 'warning' : 'default'} />
                                        <Chip size="small" variant="outlined" label={String(x.status || '').replace(/_/g, ' ')} />
                                        <Typography variant="body2" fontWeight={600}>{x.title}</Typography>
                                    </Stack>
                                    {x.explanation && <Typography variant="body2" sx={{ mt: 0.5 }}>{x.explanation}</Typography>}
                                    {x.recommendation && <Typography variant="body2" color="text.secondary"><b>What to do:</b> {x.recommendation}</Typography>}
                                </Box>
                            ))}
                            {me?.reconcile && (
                                <Button size="small" variant="outlined" sx={{ mt: 1 }}
                                        onClick={() => navigate(`/events/${eventId}/reconcile?q=${encodeURIComponent(d.purchaser_email || d.order_number || '')}`)}>
                                    Open in Ticket Reconciliation
                                </Button>
                            )}
                        </Section>
                    )}

                    <Section title="Email history">
                        <Box sx={{ overflowX: 'auto' }}>
                            <Table size="small">
                                <TableHead><TableRow>
                                    <TableCell>When</TableCell><TableCell>Kind</TableCell><TableCell>Recipient</TableCell><TableCell>State</TableCell>
                                    <TableCell>Result</TableCell><TableCell>By</TableCell><TableCell>Template</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {(d.history || []).map((h, i) => (
                                        <TableRow key={i}>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{gst(h.at)}</TableCell>
                                            <TableCell>{h.kind}</TableCell>
                                            <TableCell>{h.recipient}</TableCell>
                                            <TableCell><DeliveryChip s={h.state} variant="outlined" /></TableCell>
                                            <TableCell sx={{ minWidth: 180 }}>{h.result}{h.reason ? ` — ${h.reason}` : ''}</TableCell>
                                            <TableCell>{h.actor || '—'}</TableCell>
                                            <TableCell>{h.template || '—'}</TableCell>
                                        </TableRow>
                                    ))}
                                    {!d.history?.length && <TableRow><TableCell colSpan={7}>No email has been sent for this order yet.</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                        </Box>
                    </Section>

                    <Section title="Review log">
                        {(d.review_log || []).map((l, i) => (
                            <Typography key={i} variant="body2" sx={{ py: 0.25 }}>
                                <Typography component="span" variant="caption" color="text.secondary">{gst(l.at)}</Typography>{' '}
                                <b>{l.actor}</b> {String(l.action || '').replace(/_/g, ' ')}
                                {l.from || l.to ? ` (${(l.from || '—').replace(/_/g, ' ')} → ${(l.to || '—').replace(/_/g, ' ')})` : ''}
                                {l.note ? ` — ${l.note}` : ''}
                            </Typography>
                        ))}
                        {!d.review_log?.length && <Typography variant="body2" color="text.secondary">Not reviewed yet.</Typography>}
                    </Section>
                </>}
            </DialogContent>
            <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>

            {/* Send / retry confirmation */}
            <Dialog open={Boolean(sendAsk)} onClose={() => setSendAsk(null)} fullWidth maxWidth="sm" fullScreen={narrow}>
                <DialogTitle>{sendAsk === 'retry' ? 'Retry the failed email' : 'Send the ticket email'}</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" sx={{ mb: 1 }}>Template: <b>Official ticket email</b></Typography>
                    {me?.sending?.fake_gateway && <Alert severity="info" sx={{ mb: 1 }}>Test mode — emails go to a simulated mailbox; nothing reaches anyone.</Alert>}
                    <Typography variant="subtitle2">This will send:</Typography>
                    {confirmUnits.map((u) => (
                        <Typography key={u.unit_key} variant="body2">• {u.recipient} — {(u.ticket_ids || []).length} ticket{(u.ticket_ids || []).length === 1 ? '' : 's'}</Typography>
                    ))}
                    {!confirmUnits.length && <Typography variant="body2">Every email of this order that can be sent.</Typography>}
                    <Typography variant="body2" sx={{ mt: 1 }}>
                        <b>{confirmUnits.length || '—'}</b> email(s), <b>{confirmUnits.reduce((a, u) => a + (u.ticket_ids || []).length, 0)}</b> ticket(s) in total.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSendAsk(null)}>Cancel</Button>
                    <GatedButton variant="contained" disabled={busy} reason={sBlock}
                                 onClick={() => send(sendAsk === 'retry' ? { retry: true } : {})}>
                        {busy ? 'Sending…' : sendAsk === 'retry' ? 'Retry now' : 'Send now'}
                    </GatedButton>
                </DialogActions>
            </Dialog>

            {/* Notes: flag / hold / resend / settle */}
            <NoteDialog open={noteAsk?.kind === 'flag'} title="Flag for review" busy={busy}
                        help="Marks this order as needing correction. Say what is wrong so the next person can fix it."
                        confirmLabel="Flag" confirmColor="warning" onClose={() => setNoteAsk(null)} onConfirm={({ note }) => review('flag', note)} />
            <NoteDialog open={noteAsk?.kind === 'hold'} title="Hold this order" busy={busy}
                        help="A held order is not sent, alone or in a batch, until someone resets it."
                        confirmLabel="Hold" confirmColor="warning" onClose={() => setNoteAsk(null)} onConfirm={({ note }) => review('hold', note)} />
            <NoteDialog open={noteAsk?.kind === 'resend'} title="Resend the ticket email" busy={busy} noteLabel="Reason for resending"
                        help={`The email was already ${d?.delivery || 'sent'}. It goes again to: ${units.map((u) => u.recipient).filter(Boolean).join(', ')}. Template: Official ticket email.`}
                        confirmLabel="Resend" onClose={() => setNoteAsk(null)}
                        onConfirm={({ note }) => send({ resend: true, resend_reason: note })} />
            <NoteDialog open={noteAsk?.kind === 'outcome'} title="Settle an uncertain outcome" busy={busy} noteLabel="How you checked GHL"
                        help="The send got no clear answer. Look the email up in GHL first, then record what GHL shows. Choosing “was not sent” makes a retry possible."
                        fields={[
                            ...(unknownUnits.length > 1 ? [{ key: 'unit_key', label: 'Which email', options: unknownUnits.map((u) => [u.unit_key, `${u.recipient} (${(u.ticket_ids || []).length} tickets)`]) }] : []),
                            { key: 'outcome', label: 'What GHL shows', options: [['sent', 'I checked GHL: it WAS sent'], ['not_sent', 'I checked GHL: it was NOT sent']] },
                        ]}
                        confirmLabel="Record outcome" onClose={() => setNoteAsk(null)}
                        onConfirm={({ note, outcome, unit_key: uk }) => run(
                            ecBookingOutcome(eventId, d.key, { unit_key: uk || unknownUnits[0]?.unit_key, outcome, note }),
                            () => setNotice({ severity: 'success', text: `Outcome recorded: ${outcome === 'sent' ? 'sent' : 'not sent'}.` }))} />

            {/* Email preview */}
            <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} fullWidth maxWidth="md" fullScreen={narrow}>
                <DialogTitle>Email preview</DialogTitle>
                <DialogContent dividers>
                    {preview?.loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
                    {(preview?.emails || []).map((m) => (
                        <Box key={m.unit_key} sx={{ mb: 3 }}>
                            {m.error ? <Alert severity="error">{m.unit_key}: {m.error}</Alert> : <>
                                <Typography variant="body2"><b>To:</b> {m.recipient} · <b>From:</b> {m.from || '—'}</Typography>
                                <Typography variant="body2" sx={{ mb: 1 }}><b>Subject:</b> {m.subject} · {Array.isArray(m.tickets) ? m.tickets.length : m.tickets} ticket(s) · <DeliveryChip s={m.delivery} /></Typography>
                                <EmailFrame html={m.html} title={`Preview for ${m.recipient}`} />
                            </>}
                        </Box>
                    ))}
                    {preview && !preview.loading && !preview.emails?.length && <Typography>No email to preview for this order.</Typography>}
                </DialogContent>
                <DialogActions><Button onClick={() => setPreview(null)}>Close</Button></DialogActions>
            </Dialog>
        </Dialog>
    );
}

