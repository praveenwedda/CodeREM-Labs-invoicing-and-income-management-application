'use strict';
const crypto = require('crypto');
const config = require('../config');
const { nowISO } = require('./dates');

// Every audit entry is HMAC-signed and chained to the previous entry's hash. The database refuses
// UPDATE/DELETE on the table (see schema triggers); the chain additionally makes any tampering
// done outside the application (e.g. editing the DB file directly) detectable via verifyChain().

const GENESIS = '0'.repeat(64);

function computeHash(e) {
  const payload = [e.prev_hash, e.ts, e.user_id ?? '', e.user_label, e.action, e.entity ?? '',
    e.entity_id ?? '', e.details ?? '', e.ip ?? ''].join('\u001f');
  return crypto.createHmac('sha256', config.auditSecret).update(payload).digest('hex');
}

// actor: { id, email } for a user, or null for the system (scheduler).
function record(db, { actor, action, entity = null, entityId = null, details = null, ip = null }) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const entry = {
    ts: nowISO(),
    user_id: actor ? actor.id : null,
    user_label: actor ? actor.email : 'system',
    action,
    entity,
    entity_id: entityId === null ? null : String(entityId),
    details: details === null ? null : JSON.stringify(details),
    ip,
    prev_hash: last ? last.hash : GENESIS,
  };
  entry.hash = computeHash(entry);
  db.prepare(`INSERT INTO audit_log (ts, user_id, user_label, action, entity, entity_id, details, ip, prev_hash, hash)
    VALUES (@ts, @user_id, @user_label, @action, @entity, @entity_id, @details, @ip, @prev_hash, @hash)`).run(entry);
}

function verifyChain(db) {
  let prev = GENESIS;
  let count = 0;
  for (const row of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
    count++;
    if (row.prev_hash !== prev || computeHash(row) !== row.hash) {
      return { ok: false, count, brokenAt: row.id };
    }
    prev = row.hash;
  }
  return { ok: true, count };
}

module.exports = { record, verifyChain };
