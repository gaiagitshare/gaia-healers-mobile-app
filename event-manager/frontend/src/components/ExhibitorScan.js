import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
    Box,
    Typography,
    Card,
    CardContent,
    Button,
    TextField,
    Alert,
    Avatar,
    Paper,
    List,
    ListItem,
    ListItemText,
    ListItemAvatar,
    Rating,
} from '@mui/material';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { getPublicExhibitorLeads, scanQR, updatePublicLead } from '../utils/api';

function ExhibitorScan() {
    const { token } = useParams();
    const [scanning] = useState(true);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [leads, setLeads] = useState([]);
    const [note, setNote] = useState('');
    const [rating, setRating] = useState(0);
    const [savingNote, setSavingNote] = useState(false);
    const scannerRef = useRef(null);

    useEffect(() => {
        if (token) {
            loadLeads();
        }
    }, [token]);

    useEffect(() => {
        if (scanning && token) {
            scannerRef.current = new Html5QrcodeScanner('exhibitor-qr-reader', {
                qrbox: { width: 250, height: 250 },
                fps: 10,
            });

            scannerRef.current.render(onScanSuccess, onScanError);
        }

        return () => {
            if (scannerRef.current) {
                scannerRef.current.clear();
            }
        };
    }, [scanning, token]);

    const onScanSuccess = async (decodedText) => {
        if (scannerRef.current) {
            scannerRef.current.pause();
        }
        await processScan(decodedText);
    };

    const onScanError = (errorMessage) => {
        // Ignore errors
    };

    const processScan = async (qrCode) => {
        setError('');
        setResult(null);
        
        try {
            const response = await scanQR(qrCode, token);
            setResult(response.data);
            setNote('');
            setRating(0);
            loadLeads();
            
            setTimeout(() => {
                if (scannerRef.current && scanning) {
                    scannerRef.current.resume();
                }
            }, 3000);
        } catch (err) {
            setError(err.response?.data?.detail || 'Scan failed');
        }
    };

    const loadLeads = async () => {
        try {
            const response = await getPublicExhibitorLeads(token);
            setLeads(response.data);
        } catch (err) {
            setError(err.response?.data?.detail || 'Could not load recent leads');
        }
    };

    const saveLeadNote = async () => {
        if (!result?.lead_id) {
            setError('Scan an attendee before saving notes.');
            return;
        }

        setSavingNote(true);
        setError('');
        try {
            await updatePublicLead(result.lead_id, token, {
                notes: note,
                rating: rating || null,
            });
            await loadLeads();
        } catch (err) {
            setError(err.response?.data?.detail || 'Could not save lead notes');
        } finally {
            setSavingNote(false);
        }
    };

    return (
        <Box sx={{ maxWidth: 600, mx: 'auto', p: 2 }}>
            <Typography variant="h4" align="center" gutterBottom>
                Exhibitor Lead Scanner
            </Typography>

            {!token ? (
                <Alert severity="error">
                    Invalid access token. Please use the link provided by the event organizer.
                </Alert>
            ) : (
                <>
                    {scanning && (
                        <Paper sx={{ p: 2, mb: 3 }}>
                            <div id="exhibitor-qr-reader" style={{ width: '100%' }}></div>
                        </Paper>
                    )}

                    {error && (
                        <Alert severity="error" sx={{ mb: 3 }}>
                            {error}
                        </Alert>
                    )}

                    {result && (
                        <Card sx={{ mb: 3 }}>
                            <CardContent>
                                <Box display="flex" alignItems="center" mb={2}>
                                    <Avatar sx={{ width: 64, height: 64, mr: 2, bgcolor: result.success ? 'success.main' : 'error.main' }}>
                                        {result.success ? '✓' : '✗'}
                                    </Avatar>
                                    <Box>
                                        <Typography variant="h5" color={result.success ? 'success.main' : 'error.main'}>
                                            {result.success ? 'Lead Captured!' : 'Scan Failed'}
                                        </Typography>
                                        <Typography variant="body1">{result.message}</Typography>
                                    </Box>
                                </Box>

                                {result.attendee && (
                                    <Box>
                                        <Typography variant="h6">
                                            {result.attendee.first_name} {result.attendee.last_name}
                                        </Typography>
                                        <Typography color="textSecondary">
                                            {result.attendee.company} - {result.attendee.job_title}
                                        </Typography>
                                        <Typography variant="body2">
                                            {result.attendee.email}
                                        </Typography>

                                        {result.success && (
                                            <Box mt={2}>
                                                <Typography variant="subtitle2" gutterBottom>
                                                    Add Notes:
                                                </Typography>
                                                <TextField
                                                    fullWidth
                                                    multiline
                                                    rows={2}
                                                    value={note}
                                                    onChange={(e) => setNote(e.target.value)}
                                                    placeholder="Enter notes about this lead..."
                                                    sx={{ mb: 2 }}
                                                />
                                                <Box display="flex" alignItems="center" gap={2}>
                                                    <Typography>Rating:</Typography>
                                                    <Rating
                                                        value={rating}
                                                        onChange={(e, newValue) => setRating(newValue)}
                                                    />
                                                </Box>
                                                <Button
                                                    variant="contained"
                                                    onClick={saveLeadNote}
                                                    disabled={savingNote}
                                                    sx={{ mt: 2 }}
                                                >
                                                    {savingNote ? 'Saving...' : 'Save Notes'}
                                                </Button>
                                            </Box>
                                        )}
                                    </Box>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    <Typography variant="h6" gutterBottom>
                        Recently Scanned Leads
                    </Typography>
                    
                    {leads.length === 0 ? (
                        <Typography color="textSecondary">
                            No leads scanned yet. Start scanning attendee QR codes!
                        </Typography>
                    ) : (
                        <List>
                            {leads.map((lead) => (
                                <ListItem key={lead.id}>
                                    <ListItemAvatar>
                                        <Avatar>{lead.attendee?.first_name?.[0]}</Avatar>
                                    </ListItemAvatar>
                                    <ListItemText
                                        primary={`${lead.attendee?.first_name} ${lead.attendee?.last_name}`}
                                        secondary={
                                            <>
                                                <Typography variant="body2" component="span">
                                                    {[lead.attendee?.company, lead.attendee?.job_title].filter(Boolean).join(' - ')}
                                                </Typography>
                                                {lead.rating ? (
                                                    <>
                                                        <br />
                                                        <Typography variant="body2" component="span">
                                                            Rating: {lead.rating}/5
                                                        </Typography>
                                                    </>
                                                ) : null}
                                                {lead.notes ? (
                                                    <>
                                                        <br />
                                                        <Typography variant="caption" component="span" color="textSecondary">
                                                            {lead.notes}
                                                        </Typography>
                                                    </>
                                                ) : null}
                                            </>
                                        }
                                    />
                                </ListItem>
                            ))}
                        </List>
                    )}
                </>
            )}
        </Box>
    );
}

export default ExhibitorScan;
