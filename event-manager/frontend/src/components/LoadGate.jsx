import React from 'react';
import { Alert, Button, Typography } from '@mui/material';

// A list's "none yet" message is only true once the list has loaded. Before
// that this says Loading; if the request failed it says so, with Retry --
// never "No passes yet" while the passes are still on their way (12 Nov 2026).
// status: 'loading' | 'failed' | 'ok'. Children render only when 'ok'.
export default function LoadGate({ status, what, onRetry, children, sx }) {
    if (status === 'loading') {
        return <Typography variant="body2" color="text.secondary" sx={{ py: 1, ...sx }}>Loading {what}…</Typography>;
    }
    if (status === 'failed') {
        return (
            <Alert severity="warning" sx={sx}
                   action={onRetry ? <Button size="small" onClick={onRetry}>Retry</Button> : undefined}>
                Could not load {what}. Nothing has changed — try again.
            </Alert>
        );
    }
    return <>{children}</>;
}
