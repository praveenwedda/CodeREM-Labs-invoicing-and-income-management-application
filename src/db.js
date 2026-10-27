'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_SETTINGS = {
  company_name: 'CodeREM Labs Pvt. Ltd.',
  company_address: '22, Pangiriwatte Mawatha, Mirihana, Nugegoda',
  company_reg: 'PV 00363236',
  company_tagline: 'Medical Grade Precision, F1 Grade Performance',
  company_email: '',
  company_phone: '',
  company_website: '',
  bank_details: '',
  invoice_prefix: 'CRL',
  default_currency: 'LKR',
  default_payment_terms: '14',
  invoice_footer: 'Thank you for your business.',
};

function openDatabase(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

module.exports = { openDatabase, getSettings, DEFAULT_SETTINGS };
