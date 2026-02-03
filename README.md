# BeaconAttend — Proxy-Proof Attendance for MRU

A GPS-verified, photo-captured attendance system with three roles, AI timetable parsing, and real-time proximity checks. **Zero cost to run.**

---

## Quick Start (< 5 minutes)

```bash
cp .env.example .env          # paste your Gemini key inside
npm install
npm run dev                   # → http://localhost:3000
```

Get a **free** Gemini API key at <https://aistudio.google.com/apikey> (no credit card).

---

## How It Works

### Roles

| Role | Email domain | What they do |
|---|---|---|
| **Mentor** | `@mru.edu.in` (whitelisted) | Uploads the *class* timetable for a section. Manually starts Entry / Completion beacons. |
| **Subject Teacher** | `@mru.edu.in` (whitelisted) | Uploads their *personal* teaching timetable. Enables location tracking → attendance **auto-activates** when class time matches. |
| **Student** | `@mru.ac.in` | Sees synced timetable, verifies proximity, captures selfie → attendance recorded. |

### Flow

1. **Mentor** uploads a timetable image → Gemini AI parses it → classes appear for the section.
2. **Subject Teacher** uploads their schedule → system auto-matches by subject + room + time.
3. Teacher enables **location tracking** → when the clock hits class time the attendance beacon fires automatically.
4. **Student** taps *Verify* → GPS distance is checked (must be 10–15 m from teacher) → camera opens → selfie captured → second GPS check → ✅ attendance recorded.

### Anti-Proxy Security

| Layer | What it does |
|---|---|
| Double proximity check | Distance verified *before* camera opens **and again** the instant the photo is taken. |
| Haversine distance | Accurate great-circle math, not Manhattan distance. |
| Location freshness | `maximumAge: 0` — browser never serves a cached position. |
| Location expiry | Faculty location older than 2 hours is rejected. |
| Strict range | Must be **10–15 m** away. Too close (same-device proxy) or too far both fail. |
| Photo evidence | Every attendance record has a selfie timestamp. |

---

## Configuration

### Whitelists (`src/App.jsx` top)

```js
const MENTOR_WHITELIST  = ['faculty1@mru.edu.in', ...];
const TEACHER_WHITELIST = ['ekakshjeena@mru.edu.in', ...];
```

Add or remove emails here before deploying.

### Proximity range

```js
const PROX_MIN = 10;   // metres
const PROX_MAX = 15;   // metres
```

---

## Deployment (free)

### Vercel (recommended)

1. Push the repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → **New Project** → import your repo.
3. Vercel auto-detects Vite and runs `npm run build`.
4. **Settings → Environment Variables** → add `VITE_GEMINI_API_KEY`.
5. Done — HTTPS is included automatically (required for geolocation).

### Netlify

1. `npm run build` → drag the `dist/` folder to [netlify.com](https://netlify.com).
2. Add `VITE_GEMINI_API_KEY` in **Site Settings → Environment Variables**.

### GitHub Pages

Not recommended — geolocation requires HTTPS and the `dist` folder must be served from the repo root or a `/docs` branch with correct base-path config.

---

## Project Structure

```
beaconattend/
├── index.html              # HTML shell
├── vite.config.js          # Vite + env vars
├── package.json
├── .env.example            # copy → .env, add your key
├── .gitignore
└── src/
    ├── main.jsx            # ReactDOM mount
    ├── App.jsx             # Entire app (auth, dashboards, camera, logic)
    └── geminiService.js    # Gemini API call (falls back to mock if no key)
```

---

## FAQ

**Q: Does it work without an API key?**  
A: Yes — `geminiService.js` returns a hard-coded mock timetable when no key is set, so you can test the full flow offline.

**Q: Camera doesn't open on mobile?**  
A: The app requests `{ facingMode: "user" }`. If denied it falls back to a file-upload picker.

**Q: GPS is inaccurate indoors?**  
A: The 10–15 m range provides a buffer. Both teacher and student use the same high-accuracy mode, so any systematic indoor drift affects both equally.
