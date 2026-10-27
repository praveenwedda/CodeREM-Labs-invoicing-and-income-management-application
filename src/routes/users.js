'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const audit = require('../lib/audit');
const { nowISO } = require('../lib/dates');
const { str, who, action, need } = require('./_helpers');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const users = db.prepare(`SELECT u.*, c.email created_by_email FROM users u LEFT JOIN users c ON c.id = u.created_by ORDER BY u.name`).all();
    res.render('users/index', { title: 'Administrators', users });
  });

  r.get('/me', (req, res) => res.render('users/me', { title: 'My account' }));

  r.post('/me/password', action((req, res) => {
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    need(bcrypt.compareSync(String(req.body.current || ''), me.password_hash), 'Current password is incorrect.');
    need(String(req.body.password || '').length >= 10, 'New password must be at least 10 characters.');
    need(req.body.password === req.body.password2, 'New passwords do not match.');
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), me.id);
      // Sign out every other session of this user
      db.prepare(`DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid != ?`).run(me.id, req.sessionID);
      audit.record(db, { ...who(req), action: 'user.change_password', entity: 'user', entityId: me.id });
    })();
    req.flash('success', 'Password changed. Other sessions were signed out.');
    res.redirect('/users/me');
  }));

  r.post('/', action((req, res) => {
    const name = str(req.body.name);
    const email = str(req.body.email);
    const password = String(req.body.password || '');
    need(name && email, 'Name and email are required.');
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email.');
    need(password.length >= 10, 'Initial password must be at least 10 characters.');
    need(!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email), 'An administrator with that email already exists.');
    db.transaction(() => {
      const info = db.prepare('INSERT INTO users (name, email, password_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, email, bcrypt.hashSync(password, 12), req.user.id, nowISO());
      audit.record(db, { ...who(req), action: 'user.create', entity: 'user', entityId: info.lastInsertRowid, details: { name, email } });
    })();
    req.flash('success', `Administrator ${email} created. Share the initial password securely and ask them to change it.`);
    res.redirect('/users');
  }));

  r.post('/:id/status', action((req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    need(u, 'User not found.');
    const activate = req.body.op === 'activate';
    need(activate || u.id !== req.user.id, 'You cannot deactivate your own account.');
    if (!activate) need(db.prepare('SELECT COUNT(*) n FROM users WHERE is_active = 1').get().n > 1, 'At least one active administrator is required.');
    db.transaction(() => {
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(activate ? 1 : 0, u.id);
      if (!activate) db.prepare(`DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?`).run(u.id);
      audit.record(db, { ...who(req), action: activate ? 'user.activate' : 'user.deactivate', entity: 'user', entityId: u.id, details: { email: u.email } });
    })();
    req.flash('success', `${u.email} ${activate ? 'reactivated' : 'deactivated'}.`);
    res.redirect('/users');
  }));

  r.post('/:id/reset-password', action((req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    need(u, 'User not found.');
    need(String(req.body.password || '').length >= 10, 'Password must be at least 10 characters.');
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), u.id);
      db.prepare(`DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid != ?`).run(u.id, req.sessionID);
      audit.record(db, { ...who(req), action: 'user.reset_password', entity: 'user', entityId: u.id, details: { email: u.email } });
    })();
    req.flash('success', `Password for ${u.email} reset.`);
    res.redirect('/users');
  }));

  return r;
};
