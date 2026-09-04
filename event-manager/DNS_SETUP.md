# ba2ki.com/event Setup Guide

## ✅ What's Done on VPS

### Services Running
- **Backend (API)**: Port 8002 ✓
- **Frontend**: Port 3002 ✓
- **Nginx**: Configured for ba2ki.com ✓
- **Landing Page**: /var/www/ba2ki ✓

### URLs Ready
- http://localhost:3002 (local frontend)
- http://localhost:8002 (local backend)
- http://ba2ki.com (landing page - after DNS)
- http://ba2ki.com/event (event system - after DNS)
- http://ba2ki.com/event-api/docs (API docs - after DNS)

---

## 📝 DNS Setup Required (In Squarespace)

### Step 1: Change A Records
In your Squarespace DNS settings (from the screenshot), change:

| Record | Name | Current Value | New Value |
|--------|------|---------------|-----------|
| A | @ | 198.49.23.144 | **80.241.220.129** |
| A | @ | 198.49.23.45 | **80.241.220.129** |

**How to do it:**
1. Log into Squarespace → Domain → DNS Settings
2. Find the two A records showing 198.49.x.x
3. Click each one and change the value to: `80.241.220.129`
4. Save changes

### Step 2: Wait for Propagation
- DNS changes take 5 minutes to 2 hours to propagate globally
- You can check with: https://dnschecker.org

---

## 🔒 SSL/HTTPS Setup (After DNS Works)

Once http://ba2ki.com works, run this on the VPS:

```bash
# Install SSL certificate
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d ba2ki.com -d www.ba2ki.com

# Test automatic renewal
sudo certbot renew --dry-run
```

---

## 🚀 How to Start/Stop

```bash
cd ~/event

# Start everything
./START_BA2KI.sh

# Stop everything
./STOP_BA2KI.sh

# View logs
tail -f backend/backend.log
tail -f frontend/frontend.log
```

---

## 📋 Next Steps

1. **Update DNS** in Squarespace (see Step 1 above)
2. **Wait** 5-60 minutes for DNS to propagate
3. **Test**: Visit http://ba2ki.com - should show landing page
4. **Test Event System**: http://ba2ki.com/event
5. **Register admin account** on first visit
6. **Create "Gaia Healers Elevate 2026"** event
7. **Import attendees** from GHL using `import_ghl.py`

---

## 🔧 Troubleshooting

### If ba2ki.com doesn't load:
```bash
# Check if DNS propagated
dig ba2ki.com +short
# Should show: 80.241.220.129

# Check nginx is running
sudo systemctl status nginx

# Check services are running
curl http://localhost:3002
curl http://localhost:8002/docs
```

### To restart everything:
```bash
cd ~/event
./STOP_BA2KI.sh
./START_BA2KI.sh
sudo systemctl reload nginx
```

---

## 📞 Support Info

- **VPS IP**: 80.241.220.129
- **Backend PID**: ~/event/backend/backend.pid
- **Frontend PID**: ~/event/frontend/frontend.pid
- **Nginx Config**: /etc/nginx/sites-available/ba2ki
