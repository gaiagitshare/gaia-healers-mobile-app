# Gaia Healers Event System - Admin Guide

## 🎯 How to Access Admin Dashboard

### Step 1: Login
```
URL: https://ba2ki.com/event/
→ Sign in with your admin email/password
→ Or click "Create Account" if first time
```

### Step 2: Dashboard Overview
Once logged in, you'll see:
- **Sidebar Menu**: Dashboard | Events | Check-In
- **Top Stats**: Total events, attendees, check-ins, exhibitors
- **Quick Actions**: Create event, start check-in

---

## 📊 What You Can Control & Monitor

### 1. Dashboard Analytics
| Metric | What It Shows |
|--------|---------------|
| **Total Events** | Number of events created |
| **Total Attendees** | All registered attendees across events |
| **Check-in Rate** | Percentage of attendees checked in |
| **Total Exhibitors** | Wellness vendors/partners set up |
| **Total Leads** | Attendee QR scans by exhibitors |

### 2. Events Management
**Path**: Dashboard → Events

**Actions**:
- ✅ Create new event
- ✅ Edit event details
- ✅ View attendee count
- ✅ View check-in count
- ✅ Delete event

### 3. Attendee Management
**Path**: Click on any Event → "Manage Attendees"

**Actions**:
- ✅ Add attendee manually
- ✅ View all attendees
- ✅ Generate QR code
- ✅ Download PDF badge
- ✅ Delete attendee
- ✅ Check-in status

### 4. Check-In Monitoring
**Path**: Dashboard → Check-In

**Real-time Features**:
- 🔴 **QR Scanner**: Webcam scans attendee badges
- 🟢 **Manual Entry**: Type QR code if scan fails
- 📊 **Live Results**: Shows attendee info + check-in status
- 🔔 **Alerts**: Already checked in, invalid QR, etc.

### 5. Exhibitor Lead Retrieval
**Path**: Event Detail → Add Exhibitor

**Setup**:
1. Add exhibitor (company name, booth, email)
2. System generates unique link: `https://ba2ki.com/event/scan/EXH-XXX`
3. Share link with exhibitor
4. Exhibitor scans attendee QR codes
5. View all leads captured per exhibitor

---

## 🔐 Admin Controls

### User Management
Only one admin account exists (first registered user).

### Data Control
- All data stored in SQLite database
- Backup: `~/event/backend/event.db`
- Export attendees/leads via API or direct DB access

---

## 📈 Analytics & Results

### Real-time Metrics
```
Dashboard Stats URL: https://ba2ki.com/event/dashboard
API Endpoint: GET /dashboard/stats
```

### Event-specific Data
```
Event URL: https://ba2ki.com/event/events/[ID]
Shows: Attendee count, Check-in count, Exhibitor list
```

### Export Data

**Attendees (CSV)**:
```bash
curl https://ba2ki.com/event-api/events/1/attendees > attendees.json
```

**Leads per Exhibitor**:
```bash
curl https://ba2ki.com/event-api/exhibitors/1/leads > leads.json
```

---

## 🎨 Branding Applied

| Element | Color | Usage |
|---------|-------|-------|
| Primary | Forest Green #2d5a3d | Buttons, headers |
| Secondary | Gold #c9a227 | Accents, highlights |
| Background | Warm Off-white #f5f5f0 | Page background |
| Gradient | Green → Gold | Login page hero |

**Nature/Wellness Theme**: Matches Gaia Healers brand

---

## 🚀 Quick Commands

```bash
# Start system
cd ~/event && ./START_BA2KI.sh

# Stop system
cd ~/event && ./STOP_BA2KI.sh

# Import GHL attendees
cd ~/event/backend
python3 import_ghl.py [EVENT_ID] [CSV_FILE]

# View logs
tail -f ~/event/backend/backend.log
tail -f ~/event/frontend/frontend.log

# Backup database
cp ~/event/backend/event.db ~/backup_$(date +%Y%m%d).db
```

---

## 📱 Mobile Access

All admin pages are responsive:
- ✅ Dashboard works on phone/tablet
- ✅ Check-in page works on tablet (for staff)
- ✅ Exhibitor scan page works on any phone

---

## 🔗 Important URLs

| URL | Purpose |
|-----|---------|
| https://ba2ki.com/event/ | Main App Login |
| https://ba2ki.com/event/dashboard | Admin Dashboard |
| https://ba2ki.com/event/events | Event List |
| https://ba2ki.com/event/checkin | Check-In Page |
| https://ba2ki.com/event-api/docs | API Documentation |

---

## 🆘 Troubleshooting

**Can't login?**
- Clear browser cache (Ctrl+Shift+R)
- Check if backend running: `curl http://localhost:8002/docs`

**Check-in not working?**
- Ensure camera permissions granted
- Try manual QR entry as backup

**White screen?**
- Hard refresh: Ctrl+Shift+R
- Check browser console for errors

---

## 📞 Support Info

- **System Location**: ~/event/
- **Database**: ~/event/backend/event.db
- **Backend Port**: 8002
- **Frontend Port**: 3002
- **VPS IP**: 80.241.220.129
