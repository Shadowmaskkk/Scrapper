require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const Bottleneck = require('bottleneck');
const Joi = require('joi');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  port: process.env.PORT || 3000,
  headless: process.env.HEADLESS !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 30000,
  sessionTTL: parseInt(process.env.SESSION_TTL) || 3600000,
  twoCaptchaKey: process.env.TWO_CAPTCHA_API_KEY || null,
  sessionsDir: path.join(__dirname, 'sessions'),
  logsDir: path.join(__dirname, 'logs'),
};

const RETRY_CONFIG = {
  maxAttempts: parseInt(process.env.MAX_RETRIES) || 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

// ============================================================
// LOGGER
// ============================================================
const logger = winston.createLogger({
  level: CONFIG.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(CONFIG.logsDir, 'scraper-error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(CONFIG.logsDir, 'scraper-combined.log')
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
  ],
});

// ============================================================
// RATE LIMITER
// ============================================================
const limiter = new Bottleneck({
  minTime: parseInt(process.env.RATE_LIMIT_MIN_TIME) || 2000,
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 1,
});

limiter.on('failed', (error, jobInfo) => {
  logger.warn(`Rate limiter job failed: ${error.message}`, { jobInfo });
});

// ============================================================
// INPUT VALIDATION SCHEMA
// ============================================================
const scrapeSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  query: Joi.string().min(1).max(500).required(),
  username: Joi.string().alphanum().min(3).max(30).optional(),
  skipSignup: Joi.boolean().optional().default(false),
  sessionId: Joi.string().uuid().optional(),
});

// ============================================================
// RETRY LOGIC
// ============================================================
async function withRetry(fn, context = 'operation') {
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === RETRY_CONFIG.maxAttempts) {
        logger.error(`[Retry] ${context} failed after ${RETRY_CONFIG.maxAttempts} attempts`, {
          error: err.message
        });
        throw err;
      }
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1),
        RETRY_CONFIG.maxDelay
      );
      logger.warn(`[Retry] ${context} failed (attempt ${attempt}/${RETRY_CONFIG.maxAttempts}), retrying in ${delay}ms`, {
        error: err.message
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================
async function saveSession(context, sessionId) {
  try {
    const storageState = await context.storageState();
    const sessionData = {
      storageState,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIG.sessionTTL,
    };
    await fs.writeFile(
      path.join(CONFIG.sessionsDir, `${sessionId}.json`),
      JSON.stringify(sessionData, null, 2)
    );
    logger.info(`Session saved: ${sessionId}`);
  } catch (err) {
    logger.error(`Failed to save session: ${sessionId}`, { error: err.message });
  }
}

async function loadSession(browser, sessionId) {
  const sessionPath = path.join(CONFIG.sessionsDir, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const sessionData = JSON.parse(raw);

    if (Date.now() > sessionData.expiresAt) {
      logger.info(`Session expired: ${sessionId}`);
      await fs.unlink(sessionPath).catch(() => {});
      return null;
    }

    const context = await browser.newContext({
      storageState: sessionData.storageState,
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
    });

    logger.info(`Session loaded: ${sessionId}`);
    return { context, cached: true };
  } catch {
    return null;
  }
}

async function cleanExpiredSessions() {
  try {
    const files = await fs.readdir(CONFIG.sessionsDir);
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(CONFIG.sessionsDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const sessionData = JSON.parse(raw);
        if (Date.now() > sessionData.expiresAt) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch {
        await fs.unlink(filePath).catch(() => {});
        cleaned++;
      }
    }
    if (cleaned > 0) logger.info(`Cleaned ${cleaned} expired sessions`);
  } catch (err) {
    logger.error('Session cleanup failed', { error: err.message });
  }
}

// ============================================================
// BROWSER LAUNCH
// ============================================================
async function launchBrowser() {
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return browser;
}

async function createContext(browser) {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

  const context = await browser.newContext({
    userAgent,
    viewport,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  // Block unnecessary resources
  await context.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot}', route => route.abort());
  await context.route('**/{analytics,tracking,ads}/**', route => route.abort());

  return context;
}

// ============================================================
// ANTI-DETECTION
// ============================================================
async function applyAntiDetection(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
}

async function randomDelay(min = 500, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

// ============================================================
// CAPTCHA HANDLING
// ============================================================
async function solveCaptcha(page) {
  if (!CONFIG.twoCaptchaKey) {
    logger.warn('CAPTCHA detected but no 2Captcha API key configured');
    return false;
  }

  try {
    const captchaFrame = page.frameLocator('iframe[src*="recaptcha"]');
    const siteKeyEl = await page.locator('[data-sitekey]').first();
    if (!siteKeyEl) return false;

    const siteKey = await siteKeyEl.getAttribute('data-sitekey');
    const pageUrl = page.url();

    logger.info('Submitting CAPTCHA to 2Captcha...');

    const submitRes = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      body: new URLSearchParams({
        key: CONFIG.twoCaptchaKey,
        method: 'userrecaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: '1',
      }),
    });

    const submitData = await submitRes.json();
    if (submitData.status !== 1) {
      logger.error('2Captcha submission failed', { response: submitData });
      return false;
    }

    const captchaId = submitData.request;
    logger.info(`CAPTCHA submitted, ID: ${captchaId}. Polling for solution...`);

    // Poll for solution (max 2 minutes)
    for (let i = 0; i < 24; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const pollRes = await fetch(
        `https://2captcha.com/res.php?key=${CONFIG.twoCaptchaKey}&action=get&id=${captchaId}&json=1`
      );
      const pollData = await pollRes.json();

      if (pollData.status === 1) {
        const token = pollData.request;
        logger.info('CAPTCHA solved successfully');

        await page.evaluate((token) => {
          document.getElementById('g-recaptcha-response').innerHTML = token;
          if (window.___grecaptcha_cfg) {
            const id = Object.keys(window.___grecaptcha_cfg.clients)[0];
            window.___grecaptcha_cfg.clients[id].aa.l.callback(token);
          }
        }, token);

        return true;
      }

      if (pollData.request !== 'CAPCHA_NOT_READY') {
        logger.error('2Captcha polling error', { response: pollData });
        return false;
      }
    }

    logger.error('CAPTCHA solving timed out');
    return false;
  } catch (err) {
    logger.error('CAPTCHA solving error', { error: err.message });
    return false;
  }
}

// ============================================================
// CORE SCRAPING LOGIC
// ============================================================
async function performScrape(params) {
  const { email, password, query, username, skipSignup, sessionId } = params;
  const startTime = Date.now();
  let browser = null;
  let context = null;
  let retries = 0;
  let cached = false;

  return await withRetry(async () => {
    browser = await launchBrowser();

    // Try loading existing session
    if (sessionId) {
      const sessionResult = await loadSession(browser, sessionId);
      if (sessionResult) {
        context = sessionResult.context;
        cached = sessionResult.cached;
      }
    }

    // Create fresh context if no session
    if (!context) {
      context = await createContext(browser);
    }

    const page = await context.newPage();
    await applyAntiDetection(page);

    page.setDefaultTimeout(CONFIG.requestTimeout);

    try {
      let isLoggedIn = cached;

      // Login flow if not using cached session
      if (!isLoggedIn) {
        logger.info('Starting login flow...');

        // Navigate to target site
        await page.goto('https://mambapanel.com/', {
          waitUntil: 'domcontentloaded',
          timeout: CONFIG.requestTimeout,
        });

        await randomDelay();

        // Check for CAPTCHA on landing page
        const hasCaptcha = await page.locator('iframe[src*="recaptcha"]').count() > 0;
        if (hasCaptcha) {
          await solveCaptcha(page);
          await randomDelay();
        }

        // Handle signup if needed
        if (!skipSignup && username) {
          logger.info('Attempting signup...');
          await page.goto('https://mambapanel.com/signup', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.requestTimeout,
          });
          await randomDelay();

          await page.fill('input[name="username"], input[placeholder*="username"]', username);
          await randomDelay(300, 800);
          await page.fill('input[name="email"], input[type="email"]', email);
          await randomDelay(300, 800);
          await page.fill('input[name="password"], input[type="password"]', password);
          await randomDelay(500, 1200);

          const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          await submitBtn.click();
          await page.waitForLoadState('networkidle', { timeout: CONFIG.requestTimeout });
          await randomDelay();

          isLoggedIn = true;
          logger.info('Signup completed');
        }

        // Login flow
        if (!isLoggedIn) {
          logger.info('Attempting login...');

          await page.goto('https://mambapanel.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.requestTimeout,
          });
          await randomDelay();

          await page.fill('input[name="email"], input[type="email"]', email);
          await randomDelay(300, 800);
          await page.fill('input[name="password"], input[type="password"]', password);
          await randomDelay(500, 1200);

          const loginBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          await loginBtn.click();
          await page.waitForLoadState('networkidle', { timeout: CONFIG.requestTimeout });
          await randomDelay();

          const captchaAfterLogin = await page.locator('iframe[src*="recaptcha"]').count() > 0;
          if (captchaAfterLogin) {
            await solveCaptcha(page);
            await page.waitForLoadState('networkidle', { timeout: CONFIG.requestTimeout });
          }

          isLoggedIn = true;
          logger.info('Login completed');
        }
      }

      // ---- EXECUTE QUERY / SCRAPE ----
      logger.info(`Executing query: ${query}`);

      // Check if query is a URL or a search term
      const isUrl = query.startsWith('http://') || query.startsWith('https://');

      let results = {};

      if (isUrl) {
        await page.goto(query, {
          waitUntil: 'domcontentloaded',
          timeout: CONFIG.requestTimeout,
        });
        await randomDelay();

        // Extract page data
        results = await page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          text: document.body.innerText.substring(0, 5000),
          links: Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 50)
            .map(a => ({ text: a.innerText.trim(), href: a.href }))
            .filter(l => l.text && l.href),
          meta: {
            description: document.querySelector('meta[name="description"]')?.content || '',
            keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          },
        }));
      } else {
        // Search flow - navigate to target page
        await page.goto('https://mambapanel.com/data-lookup', {
          waitUntil: 'domcontentloaded',
          timeout: CONFIG.requestTimeout,
        });
        await randomDelay();

        // customize selector for your target site
        const searchInput = page.locator('input[type="search"], input[placeholder*="search"], input[name="q"], input').first();
        const searchVisible = await searchInput.isVisible().catch(() => false);

        if (searchVisible) {
          await searchInput.fill(query);
          await randomDelay(300, 800);
          await page.keyboard.press('Enter');
          await page.waitForLoadState('domcontentloaded', { timeout: CONFIG.requestTimeout });
          await randomDelay();

          // Extract search results - customize selectors for your target site
          results = await page.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            items: Array.from(document.querySelectorAll('article, .result, .item, [data-testid*="result"]'))
              .slice(0, 20)
              .map(el => ({
                text: el.innerText.trim().substring(0, 500),
                html: el.innerHTML.substring(0, 1000),
              })),
            total: document.querySelectorAll('article, .result, .item').length,
          }));
        } else {
          results = {
            url: page.url(),
            title: await page.title(),
            message: 'Search input not found — customize selectors for your target site',
          };
        }
      }

      // Save session after successful scrape
      const newSessionId = sessionId || uuidv4();
      await saveSession(context, newSessionId);

      return {
        success: true,
        sessionId: newSessionId,
        data: results,
        meta: {
          duration: Date.now() - startTime,
          retries,
          cached,
        },
      };

    } finally {
      await page.close().catch(() => {});
    }
  }, 'scrape');
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// POST /scrape
app.post('/scrape', async (req, res) => {
  const { error, value } = scrapeSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message,
      code: 'VALIDATION_ERROR',
    });
  }

  try {
    const result = await limiter.schedule(() => performScrape(value));
    return res.json(result);
  } catch (err) {
    logger.error('Scrape endpoint error', { error: err.message });
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal scraping error',
      code: 'SCRAPE_ERROR',
      meta: { duration: 0 },
    });
  }
});

// GET /health
app.get('/health', async (req, res) => {
  const status = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };

  try {
    const sessionFiles = await fs.readdir(CONFIG.sessionsDir).catch(() => []);
    status.sessions = sessionFiles.filter(f => f.endsWith('.json')).length;
  } catch {
    status.sessions = 0;
  }

  try {
    const browser = await launchBrowser();
    await browser.close();
    status.browser = 'operational';
  } catch (err) {
    status.browser = 'failed';
    status.browserError = err.message;
    status.status = 'degraded';
  }

  res.status(status.status === 'healthy' ? 200 : 503).json(status);
});

// GET /sessions
app.get('/sessions', async (req, res) => {
  try {
    const files = await fs.readdir(CONFIG.sessionsDir);
    const sessions = [];

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(CONFIG.sessionsDir, file), 'utf8');
        const data = JSON.parse(raw);
        sessions.push({
          sessionId: file.replace('.json', ''),
          createdAt: new Date(data.createdAt).toISOString(),
          expiresAt: new Date(data.expiresAt).toISOString(),
          expired: Date.now() > data.expiresAt,
        });
      } catch {
        sessions.push({
          sessionId: file.replace('.json', ''),
          error: 'Unreadable session file',
        });
      }
    }

    res.json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /sessions/:id
app.delete('/sessions/:id', async (req, res) => {
  const sessionPath = path.join(CONFIG.sessionsDir, `${req.params.id}.json`);
  try {
    await fs.unlink(sessionPath);
    res.json({ success: true, message: `Session ${req.params.id} deleted` });
  } catch {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// ============================================================
// STARTUP
// ============================================================
async function start() {
  // Ensure directories exist
  await fs.mkdir(CONFIG.sessionsDir, { recursive: true });
  await fs.mkdir(CONFIG.logsDir, { recursive: true });

  // Clean expired sessions on startup
  await cleanExpiredSessions();

  // Schedule session cleanup every 30 minutes
  setInterval(cleanExpiredSessions, 30 * 60 * 1000);

  // Start server
  app.listen(CONFIG.port, () => {
    logger.info(`Mamba Scraper running on port ${CONFIG.port}`);
    logger.info(`Headless: ${CONFIG.headless}`);
    logger.info(`Session TTL: ${CONFIG.sessionTTL}ms`);
  });
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
