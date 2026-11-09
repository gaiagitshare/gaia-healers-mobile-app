import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    Alert, Autocomplete, Box, Button, CircularProgress, Grid, Paper, Snackbar, Stack, TextField, Typography,
} from '@mui/material';
import { getShareLinks, shareQrUrl } from '../utils/api';

/**
 * Share & QR codes: a link, a QR code and a printable sign for each public page
 * of the event (directory, map, agenda...) and for each published stand. Every
 * page here opens without signing in. Nothing is stored or sent.
 */
const err = (e) => { const d = e?.response?.data?.detail; return typeof d === 'string' ? d : (e?.message || 'Something went wrong'); };

function QrCard({ eventId, title, help, url, query, fileBase, onCopied }) {
    const img = shareQrUrl(eventId, query);
    const sign = shareQrUrl(eventId, { ...query, sign: 1 });
    return (
        <Paper variant="outlined" sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{title}</Typography>
            {help && <Typography variant="body2" color="text.secondary">{help}</Typography>}
            <Box sx={{ my: 1.5, textAlign: 'center' }}>
                <Box component="img" src={img} alt={`QR code for ${title}`} loading="lazy"
                     sx={{ width: 180, height: 180, bgcolor: '#fff', borderRadius: 1 }} />
            </Box>
            <Typography variant="caption" sx={{ wordBreak: 'break-all', mb: 1 }}>{url}</Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 'auto', flexWrap: 'wrap', gap: 1 }}>
                <Button size="small" variant="contained" onClick={() => navigator.clipboard.writeText(url).then(onCopied, () => window.prompt('Copy this link:', url))}>Copy link</Button>
                <Button size="small" variant="outlined" component="a" href={img} download={`${fileBase}-qr.png`}>Download QR</Button>
                <Button size="small" variant="outlined" component="a" href={sign} download={`${fileBase}-sign.png`}>Printable sign</Button>
                <Button size="small" component="a" href={url} target="_blank" rel="noopener noreferrer">Open</Button>
            </Stack>
        </Paper>
    );
}

export default function ShareQr() {
    const { id } = useParams();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState('');
    const [stand, setStand] = useState(null);
    useEffect(() => { getShareLinks(id).then((r) => setData(r.data)).catch((e) => setError(err(e))); }, [id]);
    const stands = useMemo(() => data?.stands || [], [data]);

    if (!data) return error ? <Alert severity="error">{error}</Alert> : <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress /></Box>;
    return (
        <Box>
            <Typography variant="h5">Share &amp; QR codes</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Links and QR codes for this event's public pages: post them, send them, or print a sign for a table or the
                hall entrance. Each one opens the page straight away on any phone, without signing in. Do a test scan of a
                printed sign before putting it up.
            </Typography>

            <Grid container spacing={2}>
                {data.pages.map((p) => (
                    <Grid item xs={12} sm={6} md={4} key={p.key}>
                        <QrCard eventId={id} title={p.label} help={p.help} url={p.url} query={{ page: p.key }}
                                fileBase={p.key} onCopied={() => setCopied(`${p.label} link copied.`)} />
                    </Grid>
                ))}
            </Grid>

            <Typography variant="h6" sx={{ mt: 3 }}>One exhibitor's stand</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Opens the hall map on that stand. Useful for an exhibitor to share, or on their table. Only stands published in
                the directory are listed.
            </Typography>
            <Autocomplete options={stands} value={stand} onChange={(e, v) => setStand(v)} sx={{ maxWidth: 420, mb: 2 }}
                          getOptionLabel={(s) => `${s.name}${s.booth ? ` · Booth ${s.booth}` : ''}`}
                          renderInput={(params) => <TextField {...params} size="small" label="Choose an exhibitor" />} />
            {stand && (
                <Grid container spacing={2}>
                    <Grid item xs={12} sm={6} md={4}>
                        <QrCard eventId={id} title={stand.name} help={stand.booth ? `Booth ${stand.booth}` : 'No booth number yet'}
                                url={stand.url} query={{ stand: stand.id }} fileBase={`stand-${stand.id}`}
                                onCopied={() => setCopied(`${stand.name} link copied.`)} />
                    </Grid>
                </Grid>
            )}
            <Snackbar open={Boolean(copied)} autoHideDuration={4000} onClose={() => setCopied('')}
                      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
                <Alert severity="success" variant="filled" onClose={() => setCopied('')}>{copied}</Alert>
            </Snackbar>
        </Box>
    );
}
