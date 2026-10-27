'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const audit = require('../lib/audit');
const { nowISO } = require('../lib/dates');
const { loginThrottle } = require('../lib/middleware');
const { str } = require('./_helpers');

module.exports = (db) => {
  const r = express.Router();
  const hasUsers = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();

  r.get('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    res.render('setup', { title: 'First-time setup', error: null, form: {} });
  });

  r.post('/setup', (req, res) => {
    if (hasUsers()) return res.redirect('/login');
    const form = { name: str(req.body.name), email: str(req.body.email) };
    const password = req.body.password || '';
    let error = null;
    if (!form.name || !form.email) error = 'Name and email are required.';
    else if (password.length < 10) error = 'Password must be at least 10 characters.';
    else if (password !== req.body.password2) error = 'Passwords do not match.';
    if (error) return res.render('setup', { title: 'First-time setup', error, form });
    db.transaction(() => {
      const info = db.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(form.name, form.email, bcrypt.hashSync(password, 12), nowISO());
      const actor = { id: Number(info.lastInsertRowid), email: form.email };
      audit.record(db, { actor, ip: req.ip, action: 'system.setup', entity: 'user', entityId: actor.id, details: { name: form.name, email: form.email } });
    })();
    req.flash('success', 'Administrator account created. Please sign in.');
    res.redirect('/login');
  });

  r.get('/login', (req, res) => {
    if (!hasUsers()) return res.redirect('/setup');
    if (req.session.userId) return res.redirect('/');
    res.render('login', { title: 'Sign in', error: null, email: '' });
  });

  r.post('/login', (req, res, next) => {
    const email = String(req.body.email || '').trim();
    const throttle = loginThrottle(`${req.ip}|${email.toLowerCase()}`);
    if (throttle.blocked) {
      return res.status(429).render('login', { title: 'Sign in', error: 'Too many failed attempts. Try again in 15 minutes.', email });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = user && user.is_active && bcrypt.compareSync(String(req.body.password || ''), user.password_hash);
    if (!ok) {
      throttle.fail();
      audit.record(db, { actor: null, ip: req.ip, action: 'auth.login_failed', entity: 'user', entityId: user ? user.id : null,
        details: { email, reason: !user ? 'unknown email' : !user.is_active ? 'account deactivated' : 'wrong password' } });
      return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.', email });
    }
    throttle.reset();
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowISO(), user.id);
      audit.record(db, { actor: user, ip: req.ip, action: 'auth.login', entity: 'user', entityId: user.id });
      res.redirect('/');
    });
  });

  r.post('/logout', (req, res) => {
    if (req.session.userId) {
      const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.userId);
      if (user) audit.record(db, { actor: user, ip: req.ip, action: 'auth.logout', entity: 'user', entityId: user.id });
    }
    req.session.destroy(() => res.redirect('/login'));
  });

  return r;
};
