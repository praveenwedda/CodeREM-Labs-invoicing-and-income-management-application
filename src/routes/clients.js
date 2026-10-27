'use strict';
const express = require('express');
const audit = require('../lib/audit');
const { CURRENCIES } = require('../lib/money');
const { nowISO } = require('../lib/dates');
const { INVOICE_WITH_PAID, decorate, nextContractPeriod } = require('../lib/billing');
const { str, who, diff, action, need } = require('./_helpers');

const FIELDS = ['name', 'contact_person', 'email', 'phone', 'address', 'tax_id', 'currency', 'notes'];

function readForm(body) {
  const f = {};
  for (const k of FIELDS) f[k] = str(body[k]);
  f.currency = f.currency || 'LKR';
  return f;
}

function validate(f) {
  need(f.name, 'Client name is required.');
  need(CURRENCIES.includes(f.currency), 'Select a valid currency.');
  need(!f.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email), 'Enter a valid email address.');
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const q = str(req.query.q);
    const clients = db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) project_count,
        (SELECT COUNT(*) FROM contracts ct WHERE ct.client_id = c.id AND ct.status = 'active') contract_count,
        (SELECT COALESCE(SUM(i.total),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'issued') invoiced,
        (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.client_id = c.id) received
      FROM clients c ${q ? 'WHERE c.name LIKE @q OR c.contact_person LIKE @q OR c.email LIKE @q' : ''}
      ORDER BY c.name COLLATE NOCASE`).all(q ? { q: `%${q}%` } : {});
    res.render('clients/index', { title: 'Clients', clients, q });
  });

  r.get('/new', (req, res) => {
    res.render('clients/form', { title: 'New client', client: { currency: res.locals.company.default_currency || 'LKR' } });
  });

  r.post('/', action((req, res) => {
    const f = readForm(req.body);
    validate(f);
    const id = db.transaction(() => {
      const now = nowISO();
      const info = db.prepare(`INSERT INTO clients (name, contact_person, email, phone, address, tax_id, currency, notes, created_at, updated_at)
        VALUES (@name, @contact_person, @email, @phone, @address, @tax_id, @currency, @notes, @now, @now)`).run({ ...f, now });
      audit.record(db, { ...who(req), action: 'client.create', entity: 'client', entityId: info.lastInsertRowid, details: f });
      return info.lastInsertRowid;
    })();
    req.flash('success', `Client "${f.name}" created.`);
    res.redirect(`/clients/${id}`);
  }));

  r.get('/:id', (req, res, next) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return next();
    const projects = db.prepare(`SELECT p.*,
        (SELECT COALESCE(SUM(it.amount),0) FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
          WHERE it.project_id = p.id AND i.status = 'issued') invoiced
      FROM projects p WHERE p.client_id = ? ORDER BY p.created_at DESC`).all(client.id);
    const contracts = db.prepare('SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC').all(client.id)
      .map((c) => ({ ...c, next: c.status === 'active' ? nextContractPeriod(c) : null }));
    const invoices = db.prepare(`${INVOICE_WITH_PAID} WHERE i.client_id = ? ORDER BY i.issue_date DESC, i.id DESC`).all(client.id).map(decorate);
    const live = invoices.filter((i) => i.status === 'issued');
    const totals = {
      invoiced: live.reduce((s, i) => s + i.total, 0),
      received: live.reduce((s, i) => s + i.paid, 0),
    };
    totals.balance = totals.invoiced - totals.received;
    res.render('clients/show', { title: client.name, client, projects, contracts, invoices, totals });
  });

  r.get('/:id/edit', (req, res, next) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return next();
    const hasInvoices = !!db.prepare('SELECT 1 FROM invoices WHERE client_id = ?').get(client.id);
    res.render('clients/form', { title: `Edit ${client.name}`, client, hasInvoices });
  });

  r.post('/:id', action((req, res, next) => {
    const before = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!before) return next();
    const f = readForm(req.body);
    validate(f);
    const hasInvoices = !!db.prepare('SELECT 1 FROM invoices WHERE client_id = ?').get(before.id);
    need(!hasInvoices || f.currency === before.currency, 'Currency cannot be changed once invoices exist for this client.');
    const changes = diff(before, f, FIELDS);
    db.transaction(() => {
      db.prepare(`UPDATE clients SET name=@name, contact_person=@contact_person, email=@email, phone=@phone, address=@address,
        tax_id=@tax_id, currency=@currency, notes=@notes, updated_at=@now WHERE id=@id`).run({ ...f, now: nowISO(), id: before.id });
      if (Object.keys(changes).length) audit.record(db, { ...who(req), action: 'client.update', entity: 'client', entityId: before.id, details: changes });
    })();
    req.flash('success', 'Client updated. Existing invoices keep the details they were issued with.');
    res.redirect(`/clients/${before.id}`);
  }));

  return r;
};
