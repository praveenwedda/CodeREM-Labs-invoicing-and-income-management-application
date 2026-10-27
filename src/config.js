'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secrets come from the environment; if absent they are generated once and kept in the data dir
// so sessions and the audit-log signature chain survive restarts.
function loadSecrets() {
  const file = path.join(DATA_DIR, '.secrets.json');
  let stored = {};
  if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const secrets = {
    session: process.env.SESSION_SECRET || stored.session,
    audit: process.env.AUDIT_SECRET || stored.audit,
  };
  let changed = false;
  for (const k of Object.keys(secrets)) {
    if (!secrets[k]) { secrets[k] = crypto.randomBytes(32).toString('hex'); stored[k] = secrets[k]; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return secrets;
}

const secrets = loadSecrets();

module.exports = {
  port: Number(process.env.PORT || 3000),
  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'coderem.db'),
  timezone: process.env.TZ_NAME || 'Asia/Colombo',
  sessionSecret: secrets.session,
  auditSecret: secrets.audit,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 15 * 60 * 1000),
};
