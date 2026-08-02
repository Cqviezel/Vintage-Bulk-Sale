'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('./db');

const findUser = db.prepare('SELECT * FROM admin_users WHERE username = ?');
const countUsers = db.prepare('SELECT COUNT(*) AS n FROM admin_users');
const upsertUser = db.prepare(
  'INSERT INTO admin_users (username, password_hash) VALUES (@username, @hash) ' +
    'ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash'
);

function hasAdmin() {
  return countUsers.get().n > 0;
}

function setPassword(username, plainPassword) {
  if (!username || !plainPassword) throw new Error('username and password are required');
  if (plainPassword.length < 10) {
    throw new Error('password must be at least 10 characters');
  }
  const hash = bcrypt.hashSync(plainPassword, 12);
  upsertUser.run({ username, hash });
}

function verify(username, plainPassword) {
  const user = findUser.get(username);
  // Hash even when the user is missing so a wrong username and a wrong password
  // take the same amount of time.
  const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = bcrypt.compareSync(plainPassword, hash);
  return ok && Boolean(user);
}

/** Route guard for the admin API — returns JSON so the frontend can react. */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not signed in' });
}

/** Page guard for /admin — redirects a browser to the login screen. */
function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/admin/login');
}

module.exports = { hasAdmin, setPassword, verify, requireAuth, requireAuthPage };
