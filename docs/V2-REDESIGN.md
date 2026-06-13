# Gaia Healers Prototype V2 — Ecosystem Redesign

## Source material

Content mapped from Gaia Healers CRM / Client Portal (Memberships, Courses, Communities, Credentials).

Event and voice-helper references added from:

- Event Manager on `/root/event`: GHL CSV import, public event grab/sync, QR check-in, PDF badges, exhibitor scan links, lead notes/ratings.
- SnapBOS Assist voice work on `/root/projects/whatsipa`: push-to-talk orb, live transcript pattern, suggested actions, explicit review-before-save safety model.

## Real communities (in prototype)

| Community | Members (CRM) |
|-----------|---------------|
| Bio-Well Practitioners | 376 |
| BioPulsar Practitioners | 505 |
| Biotekna Practitioners | 158 |
| Healeex Community | 22 |
| [Start Here] All Gaia Healers | 232 |
| The Abundant Healer Collective | 117 |

## Real certification path (Bio-Well)

1. BIO-WELL Orientation Training  
2. BIO-WELL Basic Certification (top platform course)  
3. Bio-Well Advanced Level 1 (+ Live Training, Dr. Nina Bashkir)  
4. Bio-Well Advanced Level 2  

## Continuing education (catalog samples)

- BioPulsar Basic Technical & Business Training  
- BioTekna Live Trainings  
- Healeex — Getting Started  
- 9-Week Chakra Challenge  
- The Abundant Healer (monthly calls)  
- Gaia Healers Level 2 Certification 2025  
- Biofield Coach, Sujok, Remote Scan (listed as available)

## Platform facts used in UI

- **1,233** Client Portal users (dashboard metric)  
- **education.gaiahealers.com** — portal URL  
- **Credentials** — new platform feature (badge in Academy/Profile)  
- **Nima Farshid** — community owner (feed pin)  
- **Gokollab Marketplace** — referenced in CRM nav (future)

## Screen mapping

### Home → Today dashboard
- Bio-Well readiness hero  
- Next cert step (Advanced L1)  
- Growth journey stepper  
- Community activity (Bio-Well, BioPulsar)  
- Upcoming live training  
- CE progress bar  

### Bio-Well
- Energy index + 7D trend  
- Chakra trends + body map  
- Scan history (self/client)  
- Practicum progress (14/20 scans)  

### Academy
- Resume Advanced L1  
- Full Bio-Well roadmap  
- Exams & practicum gates  
- Credentials wallet  
- CE / modality catalog  

### Community
- Feed (practitioner discussions)  
- Groups (all 6 communities)  
- Directory (LinkedIn-style)  
- Events (live trainings)  
- Mentorship CTA  
- Elevate 2026 operations tab: GHL import, QR badges, attendee stats, access tiers, exhibitor lead retrieval

### Profile
- Full Access membership  
- CE credits (18.5/24)  
- Certifications + Credentials  
- Activity history  
- Communities joined  
- GHL-linked Elevate event pass
- Gaia Assist safety preference

## What V2 removed

- Generic persona “Elena Vasquez” as primary brand voice  
- Fictional courses (Energy Medicine II, Sacred Geometry-only focus)  
- Emoji-only social UI  
- Confusing “Upgrade” on already-Pro accounts  

## Next (production)

- Deep links to `education.gaiahealers.com` courses  
- Live Credentials API  
- Bio-Well device pairing  
- Gokollab Marketplace entry  
- Replace static `gaia-ecosystem.js` samples with live GHL/Event Manager API reads
- Production voice assistant using backend-only OpenAI Realtime credentials and explicit save gates
