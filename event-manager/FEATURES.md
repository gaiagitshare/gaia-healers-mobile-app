# Gaia Healers Event System - Features & How It Works

## 📝 Registration Flow

### 1. First-Time Setup (Admin)
```
Visit https://ba2ki.com/event/
→ Click "Register" tab
→ Enter: Full Name, Email, Password
→ System creates admin account
→ Auto-redirects to Dashboard
```

### 2. Create Event
```
Dashboard → "Events" → "Create Event"
→ Event Name: "Gaia Healers Elevate 2026"
→ Location: "Rosen Shingle Creek, Orlando, FL"
→ Dates: Nov 20-22, 2026
→ Description: Event details
→ Save
```

### 3. Import Attendees from GHL
```bash
cd ~/event/backend
python3 import_ghl.py 1 /path/to/ghl_export.csv
```

### 4. What Happens for Each Attendee:
1. **Imported** → System generates unique QR code
2. **Badge Generated** → PDF with QR code ready to print
3. **Check-in** → Staff scan QR at entrance
4. **Exhibitor Lead Capture** → Vendors scan attendee QR, add notes

---

## 🎯 Key Features

### Check-In System
- **QR Code Scanning** via webcam
- **Manual Entry** for backup
- **Real-time Stats** - see who checked in
- **Badge Printing** - PDF generation

### Exhibitor Lead Retrieval
Each exhibitor gets a unique link like:
```
https://ba2ki.com/event/scan/EXH-ABC123XYZ
```

They can:
- Scan attendee QR codes
- Add notes about the lead
- Rate leads (1-5 stars)
- Export their leads after event

### Dashboard Analytics
- Total attendees
- Check-in rate (%)
- Exhibitor count
- Lead capture count

---

## 🔄 Integration with GHL

**Your Current Flow:**
```
GHL (Registration/Payment)
    ↓
Export CSV from GHL
    ↓
Import to Event System
    ↓
Print Badges
    ↓
Event Day Check-in
    ↓
Exhibitor Lead Capture
```

**No Ticketing** - Just attendance tracking!
