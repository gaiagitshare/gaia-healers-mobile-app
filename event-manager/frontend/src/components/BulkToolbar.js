import React, { useState } from 'react';
import {
    Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
    DialogContentText, DialogTitle, Paper, Snackbar, Stack, Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { bulkAction } from '../utils/api';

/**
 * Selection state for one list. Kept here so every section behaves identically
 * and no list has to reimplement select-all or clearing after an action.
 */
export function useBulkSelection(items) {
    const [selected, setSelected] = useState([]);
    const ids = (items || []).map((item) => item.id);
    const visibleSelected = selected.filter((id) => ids.includes(id));

    return {
        selected: visibleSelected,
        isSelected: (id) => visibleSelected.includes(id),
        toggle: (id) => setSelected((current) => (
            current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
        )),
        // "All visible" deliberately means what is on screen, not everything in
        // the database — an operator should never publish rows they cannot see.
        toggleAll: () => setSelected((current) => (
            ids.every((id) => current.includes(id)) ? [] : ids
        )),
        allSelected: ids.length > 0 && ids.every((id) => visibleSelected.includes(id)),
        someSelected: visibleSelected.length > 0 && !ids.every((id) => visibleSelected.includes(id)),
        clear: () => setSelected([]),
    };
}

export function SelectAllCheckbox({ selection, label = 'Select all visible' }) {
    return (
        <Box display="flex" alignItems="center" gap={0.5}>
            <Checkbox
                size="small"
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                onChange={selection.toggleAll}
                inputProps={{ 'aria-label': label }}
            />
            <Typography variant="body2" color="text.secondary">{label}</Typography>
        </Box>
    );
}

/**
 * Actions over the selected rows of one entity, for one event.
 *
 * The event id is passed in by the section on screen, so a bulk action can only
 * ever reach the event the operator is looking at. The backend enforces the same
 * boundary, and ids from another event simply fall out of scope.
 */
const plural = (count, word) => (count === 1 && word.endsWith('s') ? word.slice(0, -1) : word);

function BulkToolbar({ eventId, entity, selection, supportsFeature = false, onDone, label }) {
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [feedback, setFeedback] = useState(null);
    const count = selection.selected.length;

    const run = async (action) => {
        setBusy(true);
        try {
            const response = await bulkAction(eventId, entity, action, selection.selected);
            const affected = response.data?.affected ?? 0;
            setFeedback({
                severity: affected > 0 ? 'success' : 'warning',
                message: affected > 0
                    ? `${action} applied to ${affected} ${affected === 1 ? 'record' : 'records'}.`
                    : `Nothing was changed — no matching records in this event.`,
            });
            selection.clear();
            await onDone?.();
        } catch (error) {
            setFeedback({
                severity: 'error',
                message: error?.response?.data?.detail || `Could not ${action} those records.`,
            });
        } finally {
            setBusy(false);
            setConfirmDelete(false);
        }
    };

    // The bar disappears once the selection is cleared, but the confirmation and
    // the result message must outlive that — clearing on success would otherwise
    // unmount the very feedback the operator needs to read.
    if (count === 0 && !feedback && !confirmDelete) return null;

    return (
        <>
            {count > 0 && (
            <Paper
                elevation={3}
                sx={{
                    position: 'sticky', top: 8, zIndex: 5, mb: 2, p: 1.5,
                    borderLeft: 3, borderColor: 'primary.main',
                }}
            >
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems={{ sm: 'center' }}
                    justifyContent="space-between"
                >
                    <Typography variant="subtitle2">
                        {count} {plural(count, label || entity)} selected
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <Button size="small" variant="contained" disabled={busy} onClick={() => run('publish')}>
                            Publish
                        </Button>
                        <Button size="small" variant="outlined" disabled={busy} onClick={() => run('unpublish')}>
                            Unpublish
                        </Button>
                        {supportsFeature && (
                            <>
                                <Button size="small" variant="outlined" disabled={busy} onClick={() => run('feature')}>
                                    Feature
                                </Button>
                                <Button size="small" variant="outlined" disabled={busy} onClick={() => run('unfeature')}>
                                    Unfeature
                                </Button>
                            </>
                        )}
                        <Button
                            size="small" color="error" variant="outlined" startIcon={<DeleteIcon />}
                            disabled={busy} onClick={() => setConfirmDelete(true)}
                        >
                            Delete
                        </Button>
                        <Button size="small" disabled={busy} onClick={selection.clear}>Clear</Button>
                    </Stack>
                </Stack>
            </Paper>
            )}

            <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
                <DialogTitle>Delete {count} {plural(count, label || entity)}?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This cannot be undone from the admin. Anything attached to these records —
                        captured leads, speaker assignments — goes with them.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Button>
                    <Button color="error" variant="contained" disabled={busy} onClick={() => run('delete')}>
                        Delete {count}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar
                open={Boolean(feedback)}
                autoHideDuration={4000}
                onClose={() => setFeedback(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                {feedback ? <Alert severity={feedback.severity}>{feedback.message}</Alert> : undefined}
            </Snackbar>
        </>
    );
}

export default BulkToolbar;
