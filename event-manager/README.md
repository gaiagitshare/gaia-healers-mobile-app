# Gaia Healers Event Management System

A lightweight event management platform for **Gaia Healers** conferences - handles check-in, badging, and exhibitor lead retrieval for events like Elevate 2026.

**Complements GoHighLevel**: GHL handles registration/ticketing → This system handles on-site event management.

## Features
- **Event Management**: Create and manage multiple events
- **Custom Registration**: Configurable attendee fields
- **QR Code Check-in**: Fast attendee verification
- **PDF Badging**: Generate professional badges
- **Lead Retrieval**: Exhibitors scan attendees and add notes
- **Admin Dashboard**: Complete control panel
- **No Ticketing**: Focus on attendance, not sales

## Tech Stack
- **Backend**: Python/FastAPI (port 8002)
- **Frontend**: React + Material-UI (port 3002)
- **Database**: SQLite (default) / PostgreSQL (production)
- **QR Codes**: html5-qrcode + python-qrcode
- **PDF**: ReportLab for badge generation

## Quick Start

### Option 1: Direct Run
```bash
cd ~/event
./start.sh
```

### Option 2: Docker
```bash
cd ~/event
docker-compose up -d
```

### Option 3: Production with Nginx
```bash
# Copy nginx config
sudo cp nginx-event.conf /etc/nginx/sites-available/event
sudo ln -s /etc/nginx/sites-available/event /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Start services
cd ~/event/backend
uvicorn main:app --host 0.0.0.0 --port 8002 &

cd ~/event/frontend
PORT=3002 npm start &
```

## Access Points
- **Frontend**: http://your-vps-ip:3002
- **Backend API**: http://your-vps-ip:8002
- **API Documentation**: http://your-vps-ip:8002/docs

## Directory Structure
```
event/
├── backend/              # FastAPI backend
│   ├── main.py           # API endpoints
│   ├── models.py         # Database models
│   ├── schemas.py        # Pydantic schemas
│   ├── database.py       # DB connection
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/             # React frontend
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── utils/api.js  # API client
│   │   └── App.js
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml    # Docker orchestration
├── nginx-event.conf      # Nginx configuration
├── start.sh              # Quick start script
└── README.md
```

## Key Features Explained

### 1. Registration
- Public registration link per event
- Custom attendee fields
- Automatic QR code generation

### 2. Check-In
- QR code scanning via webcam
- Manual QR code entry
- Real-time check-in tracking

### 3. Badging
- PDF badge generation with QR code
- Event branding support
- Ready to print

### 4. Exhibitor Lead Retrieval
- Exhibitors get unique access link
- Scan attendee QR codes
- Add notes and ratings
- Export leads

## First Time Setup for Gaia Healers Events

### 1. Start the System
```bash
cd ~/event
./start.sh
```

### 2. Create Admin Account
- Visit http://your-vps-ip:3002
- Click "Register" to create admin account

### 3. Create Event (e.g., Elevate 2026)
- Go to Events → Create Event
- Name: "Gaia Healers Elevate 2026"
- Location: "Rosen Shingle Creek, Orlando, FL"
- Date: Nov 20-22, 2026

### 4. Import Attendees from GHL
```bash
cd ~/event/backend
python import_ghl.py 1 /path/to/ghl_export.csv
```

**Note**: Export CSV from GoHighLevel with columns: First Name, Last Name, Email, Phone, Company, Job Title

### 5. Set Up Exhibitors (Wellness Vendors/Partners)
- Go to your event → Add Exhibitor
- Enter company name, booth number, contact info
- System generates unique access link for each exhibitor
- Share links with exhibitors before the event

### 6. Print Badges
- Go to Event → Attendees
- Click badge icon next to each attendee
- Download PDF badges with QR codes
- Print on-site or beforehand

### 7. Event Day
- Open Check-In page on tablet/laptop at venue entrance
- Scan attendee QR codes as they arrive
- Exhibitors use their links to scan and capture leads
- Track check-in rate in real-time

## API Endpoints
- `POST /auth/register` - Register admin
- `POST /auth/login` - Login
- `GET/POST /events` - Manage events
- `GET/POST /attendees` - Manage attendees
- `POST /checkin` - QR check-in
- `POST /register` - Public registration
- `POST /scan` - Exhibitor lead scan
- `GET /attendees/{id}/badge` - Generate badge

