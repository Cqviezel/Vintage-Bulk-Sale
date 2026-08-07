'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

const { db, DATA_DIR } = require('./src/db');
const auth = require('./src/auth');
const telegram = require('./src/telegram');
const publicRoutes = require('./src/routes/public');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  console.error('\nFATAL: SESSION_SECRET is not set.');
  console.error('Copy .env.example to .env and set a long random SESSION_SECRET.\n');
  process.exit(1);
}

// Behind nginx/Caddy on a VPS, trust one proxy hop so secure cookies and
// rate-limit client IPs work correctly.
if (process.env.TRUST_PROXY === 'true' || IS_PROD) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use(
  session({
    name: 'ctcg.sid',
    secret: process.env.SESSION_SECRET,
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD, // requires HTTPS in production
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

/* ----------------------------------------------------------------- API --- */

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

/* --------------------------------------------------------------- pages --- */

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin', auth.requireAuthPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

const insertPageView = db.prepare('INSERT INTO page_views (visitor) VALUES (?)');

// Counts storefront loads for the admin Analytics tab. The seller's own visits while
// logged in are excluded so testing the storefront doesn't inflate the numbers.
// "visitor" is IP + SESSION_SECRET hashed, letting DISTINCT count unique visitors
// without ever storing the IP itself.
app.get('/', (req, res, next) => {
  if (!(req.session && req.session.user)) {
    try {
      const visitor = crypto
        .createHash('sha256')
        .update(`${req.ip}${process.env.SESSION_SECRET}`)
        .digest('hex')
        .slice(0, 16);
      insertPageView.run(visitor);
    } catch (err) {
      console.error('Visit tracking failed:', err.message);
    }
  }
  next();
});

// Customer-uploaded card photos. Long cache: filenames are content-random.
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '30d',
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

app.use(
  express.static(PUBLIC_DIR, {
    // max-age=0 forces a revalidation request on every load, so a deploy is visible
    // immediately instead of waiting out a stale browser cache.
    maxAge: 0,
    extensions: ['html'],
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* -------------------------------------------------------------- errors --- */

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our end.' : err.message,
  });
});

/* --------------------------------------------------------------- start --- */

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Crazed TCG running on http://localhost:${PORT}`);
  console.log(`  Storefront   /`);
  console.log(`  Seller admin /admin`);
  console.log(`  Database     ${path.join(DATA_DIR, 'store.db')}`);

  // On a host with no shell access (Railway etc.) this is the only way to get the
  // first admin account onto a fresh volume — set the env vars once, then remove them.
  if (!auth.hasAdmin() && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    try {
      auth.setPassword(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
      console.log(`\n  Admin account "${process.env.ADMIN_USERNAME}" created from ADMIN_USERNAME/ADMIN_PASSWORD.`);
      console.log('  You can remove those two env vars now — they are only read when no admin exists yet.\n');
    } catch (err) {
      console.error(`\n  ! Could not create admin from env vars: ${err.message}\n`);
    }
  } else if (!auth.hasAdmin()) {
    console.warn('\n  ! No admin account yet. Create one with:');
    console.warn('      npm run set-password -- <username> <password>');
    console.warn('    (or set ADMIN_USERNAME / ADMIN_PASSWORD env vars and restart)\n');
  }
  if (!telegram.isConfigured()) {
    console.warn('  ! Telegram not configured — orders will save but you will not be pinged.');
    console.warn('    Set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID in .env\n');
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing.`);
  server.close(() => {
    try {
      db.close();
    } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
