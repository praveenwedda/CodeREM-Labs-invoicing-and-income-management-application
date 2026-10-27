'use strict';
const express = require('express');
const audit = require('../lib/audit');
const { getSettings, DEFAULT_SETTINGS } = require('../db');
const { CURRENCIES } = require('../lib/money');
const { who, action, need } = require('./_helpers');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => res.render('settings/index', { title: 'Company settings', s: getSettings(db) }));

  r.post('/', action((req, res) => {
    const before = getSettings(db);
    const next = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) next[k] = String(req.body[k] ?? '').trim();
    need(next.company_name, 'Company name is required.');
    need(/^[A-Z0-9]{2,10}$/.test(next.invoice_prefix), 'Invoice prefix must be 2–10 uppercase letters/digits.');
    need(CURRENCIES.includes(next.default_currency), 'Select a default currency.');
    need(/^\d{1,3}$/.test(next.default_payment_terms), 'Payment terms must be a number of days.');
    const changes = {};
    for (const k of Object.keys(next)) if (before[k] !== next[k]) changes[k] = { from: before[k], to: next[k] };
    if (Object.keys(changes).length) {
      db.transaction(() => {
        const up = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        for (const k of Object.keys(changes)) up.run(k, next[k]);
        audit.record(db, { ...who(req), action: 'settings.update', entity: 'settings', details: changes });
      })();
    }
    req.flash('success', 'Settings saved. They apply to invoices issued from now on; existing invoices are unchanged.');
    res.redirect('/settings');
  }));

  return r;
};
