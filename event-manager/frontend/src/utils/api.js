import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || (
    window.location.hostname === 'localhost' ? 'http://localhost:8002' : '/event-api'
);

const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// When a token expires (or is otherwise rejected) the API answers 401. Without
// this, the SPA keeps rendering as "logged in" while every call silently fails,
// so the admin sees empty lists instead of being asked to sign in again. On any
// 401 that is not the login call itself, drop the dead token and return to login.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error.response && error.response.status;
        const url = (error.config && error.config.url) || '';
        const isLoginCall = url.indexOf('/auth/login') !== -1;
        if (status === 401 && !isLoginCall) {
            localStorage.removeItem('token');
            if (window.location.pathname !== '/event/login') {
                window.location.assign('/event/login');
            }
        }
        return Promise.reject(error);
    }
);

export default api;

// Auth
export const login = (email, password) => {
    const body = new URLSearchParams();
    body.append('username', email);
    body.append('password', password);

    return api.post('/auth/login', body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
};
export const register = (data) => api.post('/auth/register', data);
export const changePassword = (currentPassword, newPassword) =>
    api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword });

// Events
export const getEvents = () => api.get('/events');
export const getPublicEvent = (id) => api.get(`/public/events/${id}`);
export const createEvent = (data) => api.post('/events', data);
export const grabEvent = (data) => api.post('/events/grab', data);
export const getEvent = (id) => api.get(`/events/${id}`);
export const updateEvent = (id, data) => api.put(`/events/${id}`, data);
export const deleteEvent = (id) => api.delete(`/events/${id}`);
export const autoSyncEvents = () => api.post('/events/auto-sync');

// Attendees
export const getAttendees = (eventId) => api.get(`/events/${eventId}/attendees`);
// Sales/acquisition summary: revenue is summed server-side from recorded
// transaction amounts, because one attendee can hold several purchases.
export const getDoorReport = (eventId) => api.get(`/events/${eventId}/door-report`);
export const getAcquisitionReport = (eventId) => api.get(`/events/${eventId}/acquisition-report`);
export const getAttendee = (id) => api.get(`/attendees/${id}`);
export const getTicketCounts = (eventId) => api.get(`/events/${eventId}/ticket-counts`);
export const createAttendee = (data) => api.post('/attendees', data);
export const importAttendees = (eventId, file, options = {}) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mark_paid_member', options.markPaidMember ? 'true' : 'false');
    formData.append('source', options.source || 'admin_csv');
    return api.post(`/events/${eventId}/attendees/import`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    });
};
export const searchAttendees = (eventId, q) =>
    api.get(`/events/${eventId}/attendees/search`, { params: { q } });
export const walkInCheck = (eventId, data) => api.post(`/events/${eventId}/walk-in/check`, data);
export const walkInCreate = (eventId, data) => api.post(`/events/${eventId}/walk-in`, data);
export const updateAttendee = (id, data) => api.put(`/attendees/${id}`, data);
export const deleteAttendee = (id) => api.delete(`/attendees/${id}`);
export const revokeAttendee = (id, reason) => api.post(`/attendees/${id}/revoke`, { reason });
export const reinstateAttendee = (id, reason) => api.post(`/attendees/${id}/reinstate`, { reason });
export const changePass = (id, data) => api.post(`/attendees/${id}/change-pass`, data);
export const checkIn = (qrCode) => api.post('/checkin', { qr_code: qrCode });

// Event-scoped check-in. A door scanner belongs to one event, so this is what
// every check-in screen uses: a badge from another event reads as not found
// here rather than being admitted.
export const authorizeScan = (eventId, data) => api.post(`/events/${eventId}/authorize`, data);
export const getScanLogs = (eventId, limit = 100) =>
    api.get(`/events/${eventId}/scan-logs`, { params: { limit } });
export const setAddonDay = (attendeeId, data) => api.post(`/attendees/${attendeeId}/addon-day`, data);
export const checkInForEvent = (eventId, qrCode) =>
    api.post(`/events/${eventId}/checkin`, { qr_code: qrCode });
export const getAttendeeQR = (id) => api.get(`/attendees/${id}/qr`);
export const generateBadge = (id) => api.get(`/attendees/${id}/badge`);
// The thermal sticker (name + badge QR) as a 1-bit PNG at 203 dpi. Fetched
// through the API layer so the auth header travels with it.
export const badgeLabelBlob = (eventId, attendeeId, size = '50x30') =>
    api.get(`/events/${eventId}/attendees/${attendeeId}/badge-label.png`, { params: { size }, responseType: 'blob' });
// A print attempt, success or failure. Separate from check-in by design.
export const recordBadgePrint = (eventId, attendeeId, data) =>
    api.post(`/events/${eventId}/attendees/${attendeeId}/badge-print`, data);
export const undoCheckIn = (eventId, attendeeId, reason) =>
    api.post(`/events/${eventId}/attendees/${attendeeId}/undo-checkin`, { reason });

// Exhibitors
export const getExhibitors = (eventId) => api.get(`/events/${eventId}/exhibitors`);
export const createExhibitor = (data) => api.post('/exhibitors', data);
export const updateExhibitor = (id, data) => api.put(`/exhibitors/${id}`, data);
export const deleteExhibitor = (id) => api.delete(`/exhibitors/${id}`);
export const getExhibitorLeads = (exhibitorId) => api.get(`/exhibitors/${exhibitorId}/leads`);

// Agenda — sessions
export const getSessions = (eventId) => api.get(`/events/${eventId}/sessions`);
export const createSession = (eventId, data) => api.post(`/events/${eventId}/sessions`, data);
export const updateSession = (id, data) => api.put(`/sessions/${id}`, data);
export const deleteSession = (id) => api.delete(`/sessions/${id}`);

// Agenda — speakers
export const getSpeakers = (eventId) => api.get(`/events/${eventId}/speakers`);
export const createSpeaker = (eventId, data) => api.post(`/events/${eventId}/speakers`, data);
export const updateSpeaker = (id, data) => api.put(`/speakers/${id}`, data);
export const deleteSpeaker = (id) => api.delete(`/speakers/${id}`);

// Sponsors
export const getSponsors = (eventId) => api.get(`/events/${eventId}/sponsors`);
export const createSponsor = (eventId, data) => api.post(`/events/${eventId}/sponsors`, data);
export const updateSponsor = (id, data) => api.put(`/sponsors/${id}`, data);
export const deleteSponsor = (id) => api.delete(`/sponsors/${id}`);

// Announcements (live updates during the event)
export const getAnnouncements = (eventId) => api.get(`/events/${eventId}/announcements`);
export const createAnnouncement = (eventId, data) => api.post(`/events/${eventId}/announcements`, data);
export const updateAnnouncement = (id, data) => api.put(`/announcements/${id}`, data);
export const deleteAnnouncement = (id) => api.delete(`/announcements/${id}`);

// Bulk publish/unpublish/feature/unfeature/delete, scoped to one event.
export const bulkAction = (eventId, entity, action, ids) =>
    api.post(`/events/${eventId}/${entity}/bulk`, { action, ids });

// Generic CSV import — dry_run=true previews without writing.
export const importCsv = (eventId, entity, file, dryRun = true) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('dry_run', dryRun ? 'true' : 'false');
    return api.post(`/events/${eventId}/import/${entity}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    });
};

// Public event surface (what the Gaia app reads)
export const getPublicLive = (eventId) => api.get(`/public/events/${eventId}/live`);
export const getPublicEvents = () => api.get('/public/events');
export const getPublicAgenda = (eventId) => api.get(`/public/events/${eventId}/agenda`);
export const getPublicSpeakers = (eventId) => api.get(`/public/events/${eventId}/speakers`);
export const getPublicExhibitors = (eventId) => api.get(`/public/events/${eventId}/exhibitors`);

// Public
export const publicRegister = (data) => api.post('/register', data);
export const scanQR = (qrCode, accessToken) => api.post('/scan', { qr_code: qrCode, access_token: accessToken });
export const getPublicExhibitorLeads = (accessToken) => api.get(`/scan/leads/${accessToken}`);
export const updatePublicLead = (leadId, accessToken, data) => api.put(`/scan/leads/${leadId}`, {
    access_token: accessToken,
    ...data,
});

// Dashboard
export const getDashboardStats = () => api.get('/dashboard/stats');
export const getEntitlementReview = () => api.get('/entitlement-review');

// Ticket types — the canonical pass identities. `code` is a product/price id,
// never display copy; renaming a pass must not move anyone's access.
export const getTicketTypes = (eventId) => api.get(`/events/${eventId}/ticket-types`);
export const createTicketType = (eventId, data) => api.post(`/events/${eventId}/ticket-types`, data);
export const updateTicketType = (id, data) => api.put(`/ticket-types/${id}`, data);
export const deleteTicketType = (id) => api.delete(`/ticket-types/${id}`);
export const getTicketMappings = (eventId) => api.get(`/events/${eventId}/ticket-mappings`);
export const createTicketMapping = (eventId, data) => api.post(`/events/${eventId}/ticket-mappings`, data);
export const updateTicketMapping = (id, data) => api.put(`/ticket-mappings/${id}`, data);
export const deleteTicketMapping = (id) => api.delete(`/ticket-mappings/${id}`);

// Per-event roles. Grantable roles only — the API refuses anything above them.
export const getRoles = (eventId) => api.get(`/events/${eventId}/roles`);
export const grantRole = (eventId, data) => api.post(`/events/${eventId}/roles`, data);
export const revokeRole = (roleId) => api.delete(`/roles/${roleId}`);

// Venue places (map pins). Coordinates are percentages of the plan image.
export const getPublicMap = (eventId) => api.get(`/public/events/${eventId}/map`);
// Admin listing: includes drafts, works on unpublished events.
export const getPlaces = (eventId) => api.get(`/events/${eventId}/places`);
export const createPlace = (eventId, data) => api.post(`/events/${eventId}/places`, data);
export const updatePlace = (id, data) => api.put(`/places/${id}`, data);
export const deletePlace = (id) => api.delete(`/places/${id}`);

// Feedback aggregates — counts and averages, never names.
export const getFeedbackSummary = (eventId) => api.get(`/events/${eventId}/feedback/summary`);

// Push notifications — send to subscribed attendees of one event.
export const sendNotification = (eventId, data) =>
    api.post(`/events/${eventId}/notifications`, data);

// Event Info / FAQ / Help cards.
export const getEventInfo = (eventId) => api.get(`/events/${eventId}/info`);
export const createEventInfo = (eventId, data) => api.post(`/events/${eventId}/info`, data);
export const updateEventInfo = (id, data) => api.put(`/info/${id}`, data);
export const deleteEventInfo = (id) => api.delete(`/info/${id}`);

// Attendee CSV export (blob) + the export audit log.
export const exportAttendees = (eventId) => api.get(`/events/${eventId}/attendees/export`, { responseType: 'blob' });
export const getExportAudit = (eventId) => api.get(`/events/${eventId}/exports`);

// Event resources / documents.
export const getEventResources = (eventId) => api.get(`/events/${eventId}/resources`);
export const createEventResource = (eventId, data) => api.post(`/events/${eventId}/resources`, data);
export const updateEventResource = (id, data) => api.put(`/resources/${id}`, data);
export const deleteEventResource = (id) => api.delete(`/resources/${id}`);

// Duplicate an event structure (not attendees) as a new draft.
export const duplicateEvent = (eventId) => api.post(`/events/${eventId}/duplicate`);

// Community feed moderation
export const getEventPosts = (eventId) => api.get(`/events/${eventId}/posts`);
export const moderatePost = (postId, action) => api.post(`/posts/${postId}/moderate`, { action });
export const announceToEvent = (eventId, body, authorName) => api.post(`/events/${eventId}/announce`, { body, author_name: authorName });
export const suspendMember = (eventId, memberKey, authorName) => api.post(`/events/${eventId}/community/suspend`, { member_key: memberKey, author_name: authorName });
export const unsuspendMember = (eventId, memberKey) => api.post(`/events/${eventId}/community/unsuspend`, { member_key: memberKey });
export const getCommunityBans = (eventId) => api.get(`/events/${eventId}/community/bans`);
