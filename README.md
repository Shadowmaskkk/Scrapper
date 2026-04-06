# Mamba Scraper

Production-ready Playwright web scraper REST API with session
persistence, retry logic, rate limiting, and CAPTCHA handling.

## Local Setup

# Install dependencies
npm install
npx playwright install chromium

# Configure environment
cp .env.example .env
# Edit .env with your values

# Run locally
npm start &

# Run in dev mode (auto-restart)
npm run dev &

## API Endpoints

### POST /scrape
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "yourpassword",
    "query": "https://example.com",
    "sessionId": "optional-existing-uuid"
  }'

### GET /health
curl http://localhost:3000/health

### GET /sessions
curl http://localhost:3000/sessions

### DELETE /sessions/:id
curl -X DELETE http://localhost:3000/sessions/your-session-uuid

## Deploy to Render

1. Push to GitHub:
   git init
   git add .
   git commit -m "initial commit"
   gh repo create mamba-scraper --private --push

2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects render.yaml
5. Add TWO_CAPTCHA_API_KEY in Environment tab
6. Click Deploy

## Docker

# Build
npm run docker:build

# Run
npm run docker:run

## Customization

In mamba-scraper.js, update these for your target site:
- Line ~180: page.goto('https://your-target-site.com')
- Line ~220: login/signup selectors
- Line ~260: search result selectors

## Troubleshooting

CAPTCHA errors     → Add TWO_CAPTCHA_API_KEY to .env
Session not found  → UUID must match existing session file
Browser fails      → Run: npx playwright install chromium
Port in use        → Change PORT in .env
Render spin-down   → Ping /health every 10min via cron-job.org
