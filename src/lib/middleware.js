'use strict';
const crypto = require('crypto');

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Go back, refresh the page and try again.' });
    }
  }
  next();
}

function flash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  req.flash = (type, text) => { (req.session.flash ||= []).push({ type, text }); };
  next();
}

function requireAuth(db) {
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = db.prepare('SELECT id, name, email, is_active FROM users WHERE id = ?').get(req.session.userId);
    if (!user || !user.is_active) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    req.user = user;
    res.locals.user = user;
    next();
  };
}

// Simple in-memory login throttle: 8 failures per IP+email per 15 minutes.
const attempts = new Map();
function loginThrottle(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first > 15 * 60 * 1000) attempts.delete(key);
  return {
    blocked: (attempts.get(key)?.count || 0) >= 8,
    fail() { const r = attempts.get(key) || { count: 0, first: now }; r.count++; attempts.set(key, r); },
    reset() { attempts.delete(key); },
  };
}

module.exports = { csrf, flash, requireAuth, loginThrottle };
