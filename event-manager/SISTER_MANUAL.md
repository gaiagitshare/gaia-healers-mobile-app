# Gaia Healers Event System - Complete Manual for Your Sister

## 🎯 QUICK START (5 Minutes)

### Step 1: Open the Website
```
Go to: https://ba2ki.com/event/
```

### Step 2: Create Admin Account
1. Click **"Create Account"** tab
2. Enter:
   - **Full Name**: [Your Sister's Name]
   - **Email**: [Her Email]
   - **Password**: [Choose a strong password]
3. Click **"Create Account"** button
4. Done! You're now admin and automatically logged in

---

## 📋 WHAT IS THIS SYSTEM?

**Purpose**: Manage event check-in, badging, and exhibitor lead retrieval for Gaia Healers conferences

**Works With**: GoHighLevel (GHL) handles registration → THIS system handles everything at the event

**Key Features**:
- ✅ Print professional badges with QR codes
- ✅ Scan attendees in at venue entrance
- ✅ Let exhibitors scan attendees for lead capture
- ✅ See real-time stats (who checked in, how many leads, etc.)

---

## 🎪 SETTING UP "GAIA HEALERS ELEVATE 2026"

### PART 1: Create the Event

1. **After logging in**, click **"Events"** in left sidebar
2. Click **"Create Event"** button (top right)
3. Fill in:
   ```
   Event Name: Gaia Healers Elevate 2026
   Description: Three-day integrative wellness conference featuring 15+ speakers, exhibitors, and hands-on experiences
   Start Date: Nov 20, 2026 8:00 AM
   End Date: Nov 22, 2026 6:00 PM
   Location: Rosen Shingle Creek, Orlando, FL
   ```
4. Click **"Create"**
5. The event appears in your list with ID (e.g., ID: 1)

### PART 2: Import Attendees from GHL

**What you need**: CSV export from GoHighLevel

**Steps**:
1. In GHL, export your attendee list to CSV
2. The CSV should have columns: `First Name`, `Last Name`, `Email`, `Phone`, `Company`, `Job Title`
3. **SSH into VPS** (or ask your brother to run this):
   ```bash
   cd ~/event/backend
   python3 import_ghl.py 1 /path/to/ghl_export.csv
   ```
   (The "1" is the event ID from step 1)

4. **What happens**:
   - Each attendee gets a unique QR code (like `ATT-ABC123XYZ`)
   - Stored in database
   - Ready for badge printing

### PART 3: Print Badges

1. Go to **Events** → Click on **"Gaia Healers Elevate 2026"**
2. Click **"Manage Attendees"**
3. For each attendee:
   - Click the **badge icon** (looks like an ID card)
   - Download PDF badge
   - Print on badge paper (or regular paper + badge holders)

**Badge includes**:
- Attendee name
- Company/Title
- **QR Code** (for check-in)
- Event name

---

## 📱 CHECK-IN DAY (Event Day)

### Setup at Venue Entrance

**Equipment needed**:
- Laptop or tablet
- Webcam (built-in or USB)
- Printed badges (already distributed or on table)

**Process**:

1. **Open Check-In Page**
   ```
   https://ba2ki.com/event/checkin
   ```
   (Must be logged in as admin)

2. **Scan Attendee QR Code**
   - Click "Start QR Scanner"
   - Point webcam at attendee's badge QR code
   - System beeps and shows:
     ```
     ✅ John Smith - Gaia Wellness Center
     Status: Checked In Successfully!
     ```

3. **If Scan Fails**
   - Type the QR code manually (e.g., `ATT-ABC123`)
   - Click "Check In"

4. **Monitor Dashboard**
   - Go to https://ba2ki.com/event/dashboard
   - See real-time stats:
     - "450 of 700 checked in (64%)"

---

## 🏢 EXHIBITOR LEAD RETRIEVAL

### Setting Up Exhibitors

**Before the event**:

1. Go to **Events** → Click **"Gaia Healers Elevate 2026"**
2. Scroll to **"Exhibitors"** section
3. Click **"Add Exhibitor"**
4. Fill in:
   ```
   Company Name: Biohacking Labs
   Booth Number: A12
   Contact Email: info@biohackinglabs.com
   Contact Phone: 555-0123
   ```
5. Click **"Add"**
6. **System generates unique link**, example:
   ```
   https://ba2ki.com/event/scan/EXH-ABC123XYZ789
   ```
7. **Copy this link and send to the exhibitor**

### How Exhibitors Use It

**What exhibitors do**:
1. Open their unique link on phone/tablet
2. Point camera at attendee's badge QR code
3. System captures the lead
4. They can add notes:
   ```
   "Interested in red light therapy package"
   Rating: ⭐⭐⭐⭐⭐
   ```

**What you see**:
- Go to Event → Exhibitor → "View Leads"
- See all leads captured
- Export to CSV if needed

---

## 📊 MONITORING & RESULTS

### Real-Time Dashboard

**URL**: https://ba2ki.com/event/dashboard

**What you see**:
```
┌─────────────────────────────────────┐
│  GAIA HEALERS ELEVATE 2026          │
│                                     │
│  Total Attendees:      723          │
│  Checked In:           684 (94%)    │
│  Exhibitors:           15           │
│  Total Leads:          1,247        │
└─────────────────────────────────────┘
```

### Event Day Checklist

**Before Event**:
- [ ] Create event in system
- [ ] Import GHL attendees
- [ ] Print all badges
- [ ] Set up exhibitors with their links
- [ ] Test check-in scanner

**During Event**:
- [ ] Open check-in page at entrance
- [ ] Staff scans attendee badges
- [ ] Monitor dashboard for stats
- [ ] Exhibitors scanning leads

**After Event**:
- [ ] Export attendee list (who attended)
- [ ] Export leads per exhibitor
- [ ] Export check-in stats

---

## 🔧 TROUBLESHOOTING

### "Can't login"
- Make sure you're at https://ba2ki.com/event/
- Check Caps Lock
- Clear browser cache: Ctrl+Shift+R

### "QR scanner not working"
- Allow camera permissions in browser
- Use Chrome or Firefox (not Safari)
- Try manual entry as backup

### "Page is white/blank"
- Wait 10 seconds (React app loading)
- Hard refresh: Ctrl+Shift+R
- Check internet connection

### "Exhibitor says link not working"
- Copy the exact link (includes token)
- Make sure they use https:// not http://
- Link format: `https://ba2ki.com/event/scan/EXH-...`

---

## 📱 MOBILE ACCESS

**All pages work on mobile/tablet**:
- Dashboard: View stats on phone
- Check-In: Use tablet at venue
- Exhibitor scan: Works on any phone

---

## 💾 BACKUP & DATA

**Database location**: `~/event/backend/event.db`

**To backup**:
```bash
cp ~/event/backend/event.db ~/backup_$(date +%Y%m%d).db
```

**Your brother can help with this**

---

## 📞 WHO TO CONTACT

| Issue | Who |
|-------|-----|
| Login problems | Your brother |
| QR scanner not working | Your brother |
| Need to restart system | Your brother |
| Import GHL data | Your brother (first time) |
| How to use features | This manual |
| Export data | Run API calls or ask brother |

---

## 🎓 SUMMARY: YOUR ROLE AS ADMIN

**Before Event**:
1. ✅ Login to https://ba2ki.com/event/
2. ✅ Create "Gaia Healers Elevate 2026" event
3. ✅ Ask brother to import GHL attendees
4. ✅ Print all badges
5. ✅ Add exhibitors, send them their unique links

**During Event**:
1. ✅ Open https://ba2ki.com/event/checkin at venue entrance
2. ✅ Staff scans attendee QR codes as they arrive
3. ✅ Watch dashboard for real-time check-in count
4. ✅ Exhibitors handle their own lead scanning

**After Event**:
1. ✅ View final stats on dashboard
2. ✅ Export data if needed (ask brother)
3. ✅ Send exhibitors their lead lists

---

## 🌟 ONE-PAGE CHEAT SHEET

```
LOGIN:     https://ba2ki.com/event/
DASHBOARD: https://ba2ki.com/event/dashboard
CHECK-IN:  https://ba2ki.com/event/checkin
EVENTS:    https://ba2ki.com/event/events

STEP 1: Login/Create Account
STEP 2: Create Event
STEP 3: Brother imports GHL data
STEP 4: Print badges
STEP 5: Add exhibitors (get their links)
STEP 6: Event day → open check-in page
STEP 7: Scan attendee QR codes
STEP 8: Watch dashboard for stats
```

---

**Questions? Ask your brother or check this manual! 🌿**
