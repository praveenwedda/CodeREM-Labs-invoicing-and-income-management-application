'use strict';
const express = require('express');
const audit = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const { str, who } = require('./_helpers');

const PAGE = 50;

module.exports = (db) => {
  const r = express.Router();

  function filters(req) {
    const f = { q: str(req.query.q), action: str(req.query.action), user: str(req.query.user) };
    const where = [];
    if (f.q) where.push('(entity_id LIKE @q OR details LIKE @q)');
    if (f.action) where.push('action LIKE @action');
    if (f.user) where.push('user_label = @user');
    return { f, sql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params: { q: f.q && `%${f.q}%`, action: f.action && `${f.action}%`, user: f.user } };
  }

  r.get('/', (req, res) => {
    const { f, sql, params } = filters(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${sql}`).get(params).n;
    const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).all(params);
    const users = db.prepare('SELECT DISTINCT user_label FROM audit_log ORDER BY user_label').all().map((u) => u.user_label);
    const actions = db.prepare(`SELECT DISTINCT substr(action, 1, instr(action, '.') - 1) a FROM audit_log ORDER BY a`).all().map((a) => a.a);
    const verification = req.query.verify ? audit.verifyChain(db) : null;
    if (verification) audit.record(db, { ...who(req), action: 'audit.verify', details: verification });
    res.render('audit/index', { title: 'Audit trail', rows, f, page, pages: Math.max(1, Math.ceil(total / PAGE)), total, users, actions, verification });
  });

  r.get('/export.csv', (req, res) => {
    const { sql, params } = filters(req);
    const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY id`).all(params);
    audit.record(db, { ...who(req), action: 'audit.export', details: { rows: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coderem-audit-log.csv"');
    res.send(toCsv(['#', 'Timestamp (UTC)', 'User', 'Action', 'Entity', 'Entity ID', 'Details', 'IP', 'Hash'],
      rows.map((x) => [x.id, x.ts, x.user_label, x.action, x.entity, x.entity_id, x.details, x.ip, x.hash])));
  });

  return r;
};
