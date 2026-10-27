'use strict';
const express = require('express');
const audit = require('../lib/audit');
const { parseMoney } = require('../lib/money');
const { nowISO, isISODate, today } = require('../lib/dates');
const billing = require('../lib/billing');
const { str, int, who, diff, action, need } = require('./_helpers');

const FIELDS = ['title', 'description', 'project_id', 'monthly_amount', 'start_date', 'end_date', 'invoice_day', 'payment_terms'];

function readForm(body) {
  return {
    title: str(body.title), description: str(body.description), project_id: int(body.project_id) || null,
    monthly_amount: parseMoney(body.monthly_amount), start_date: str(body.start_date), end_date: str(body.end_date),
    invoice_day: int(body.invoice_day), payment_terms: int(body.payment_terms),
  };
}

function validate(db, f, clientId) {
  need(f.title, 'Contract title is required.');
  need(f.monthly_amount !== null && f.monthly_amount > 0, 'Enter a positive monthly amount.');
  need(isISODate(f.start_date), 'A valid service start date is required.');
  need(!f.end_date || isISODate(f.end_date), 'Invalid end date.');
  need(!f.end_date || f.end_date >= f.start_date, 'End date must be after the start date.');
  need(f.invoice_day >= 1 && f.invoice_day <= 28, 'Invoice day must be between 1 and 28.');
  need(f.payment_terms !== null && f.payment_terms >= 0 && f.payment_terms <= 365, 'Payment terms must be 0–365 days.');
  if (f.project_id) {
    const p = db.prepare('SELECT client_id FROM projects WHERE id = ?').get(f.project_id);
    need(p && p.client_id === clientId, 'Selected project belongs to another client.');
  }
}

module.exports = (db) => {
  const r = express.Router();
  const getContract = (id) => db.prepare(`SELECT ct.*, c.name client_name, c.currency, p.name project_name FROM contracts ct
    JOIN clients c ON c.id = ct.client_id LEFT JOIN projects p ON p.id = ct.project_id WHERE ct.id = ?`).get(id);

  r.get('/', (req, res) => {
    const contracts = db.prepare(`SELECT ct.*, c.name client_name, c.currency, p.name project_name FROM contracts ct
        JOIN clients c ON c.id = ct.client_id LEFT JOIN projects p ON p.id = ct.project_id
        ORDER BY CASE ct.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, c.name`).all()
      .map((c) => ({ ...c, next: c.status === 'active' ? billing.nextContractPeriod(c) : null }));
    res.render('contracts/index', { title: 'Maintenance & support contracts', contracts });
  });

  r.get('/new', (req, res) => {
    const clients = db.prepare('SELECT id, name, currency FROM clients ORDER BY name COLLATE NOCASE').all();
    const clientId = int(req.query.client_id);
    const projects = clientId ? db.prepare('SELECT id, name FROM projects WHERE client_id = ? ORDER BY name').all(clientId) : [];
    res.render('contracts/form', {
      title: 'New maintenance / support contract', clients, projects, isNew: true,
      contract: { client_id: clientId, project_id: int(req.query.project_id), start_date: today(), invoice_day: 1,
        payment_terms: Number(res.locals.company.default_payment_terms || 14) },
    });
  });

  r.post('/', action((req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.body.client_id);
    need(client, 'Select a client.');
    const f = readForm(req.body);
    validate(db, f, client.id);
    const issueNow = req.body.issue_now === 'on';
    const { id } = db.transaction(() => {
      const now = nowISO();
      const info = db.prepare(`INSERT INTO contracts (client_id, project_id, title, description, monthly_amount, start_date, end_date,
          invoice_day, payment_terms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(client.id, f.project_id, f.title, f.description, f.monthly_amount, f.start_date, f.end_date, f.invoice_day, f.payment_terms, now, now);
      const cid = Number(info.lastInsertRowid);
      audit.record(db, { ...who(req), action: 'contract.create', entity: 'contract', entityId: cid, details: { client: client.name, ...f, issueNow } });
      return { id: cid };
    })();
    let msg = `Contract "${f.title}" created.`;
    if (issueNow) {
      const inv = billing.issueContractNow(db, { contractId: id, ...who(req) });
      msg += ` First invoice ${inv.uid} issued.`;
    }
    const caught = billing.runDueContracts(db);
    if (caught.length) msg += ` ${caught.length} invoice(s) for past periods issued: ${caught.join(', ')}.`;
    req.flash('success', msg);
    res.redirect(`/contracts/${id}`);
  }));

  r.get('/:id', (req, res, next) => {
    const contract = getContract(req.params.id);
    if (!contract) return next();
    const next_ = contract.status !== 'ended' ? billing.nextContractPeriod(contract) : null;
    const invoices = db.prepare(`${billing.INVOICE_WITH_PAID} WHERE i.contract_id = ? ORDER BY i.issue_date DESC, i.id DESC`)
      .all(contract.id).map(billing.decorate);
    res.render('contracts/show', { title: contract.title, contract, next: next_, invoices });
  });

  r.get('/:id/edit', (req, res, next) => {
    const contract = getContract(req.params.id);
    if (!contract) return next();
    const clients = db.prepare('SELECT id, name, currency FROM clients WHERE id = ?').all(contract.client_id);
    const projects = db.prepare('SELECT id, name FROM projects WHERE client_id = ? ORDER BY name').all(contract.client_id);
    res.render('contracts/form', { title: `Edit ${contract.title}`, clients, projects, contract, isNew: false });
  });

  r.post('/:id', action((req, res, next) => {
    const before = getContract(req.params.id);
    if (!before) return next();
    need(before.status !== 'ended', 'Ended contracts cannot be edited.');
    const f = readForm(req.body);
    if (before.periods_issued > 0) f.start_date = before.start_date; // schedule anchor is fixed once invoicing has begun
    validate(db, f, before.client_id);
    const changes = diff(before, f, FIELDS);
    db.transaction(() => {
      db.prepare(`UPDATE contracts SET title=?, description=?, project_id=?, monthly_amount=?, start_date=?, end_date=?, invoice_day=?,
        payment_terms=?, updated_at=? WHERE id=?`).run(f.title, f.description, f.project_id, f.monthly_amount, f.start_date, f.end_date,
        f.invoice_day, f.payment_terms, nowISO(), before.id);
      if (Object.keys(changes).length) audit.record(db, { ...who(req), action: 'contract.update', entity: 'contract', entityId: before.id, details: changes });
    })();
    const caught = before.status === 'active' ? billing.runDueContracts(db) : [];
    req.flash('success', `Contract updated. Changes apply to invoices issued from now on.${caught.length ? ` Issued: ${caught.join(', ')}.` : ''}`);
    res.redirect(`/contracts/${before.id}`);
  }));

  r.post('/:id/status', action((req, res, next) => {
    const c = getContract(req.params.id);
    if (!c) return next();
    let to = { pause: 'paused', resume: 'active', end: 'ended' }[req.body.op];
    need(to, 'Unknown action.');
    need(c.status !== 'ended', 'This contract has already ended.');
    let skipped = 0;
    db.transaction(() => {
      // On resume, periods that fell due while paused are skipped (not billed) unless the admin opts to bill them.
      if (to === 'active' && req.body.bill_missed !== 'on') {
        const t = today();
        for (let p = billing.nextContractPeriod(c); p && p.issueDate < t; p = billing.nextContractPeriod(c)) { c.periods_issued++; skipped++; }
        if (skipped) db.prepare('UPDATE contracts SET periods_issued = ? WHERE id = ?').run(c.periods_issued, c.id);
        if (!billing.nextContractPeriod(c)) to = 'ended';
      }
      db.prepare('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?').run(to, nowISO(), c.id);
      audit.record(db, { ...who(req), action: `contract.${req.body.op}`, entity: 'contract', entityId: c.id,
        details: { from: c.status, to, ...(to === 'active' ? { skippedPeriods: skipped } : {}) } });
    })();
    let msg = `Contract ${to === 'active' ? 'resumed' : to}.${skipped ? ` ${skipped} period(s) missed while paused were not billed.` : ''}`;
    if (to === 'active') {
      const caught = billing.runDueContracts(db);
      if (caught.length) msg += ` Issued overdue period invoices: ${caught.join(', ')}.`;
    }
    req.flash('success', msg);
    res.redirect(`/contracts/${c.id}`);
  }));

  r.post('/:id/issue', action((req, res) => {
    const inv = billing.issueContractNow(db, { contractId: Number(req.params.id), ...who(req) });
    req.flash('success', `Invoice ${inv.uid} issued.`);
    res.redirect(`/invoices/${inv.id}`);
  }));

  return r;
};
