'use strict';
const express = require('express');
const { parseMoney } = require('../lib/money');
const { today, addDays, isISODate } = require('../lib/dates');
const billing = require('../lib/billing');
const audit = require('../lib/audit');
const { renderInvoicePdf } = require('../lib/pdf');
const { str, int, who, action, need } = require('./_helpers');

const METHODS = ['Bank transfer', 'Cash', 'Cheque', 'Card', 'Online payment', 'Other'];
const STATUS_FILTERS = ['unpaid', 'partial', 'overdue', 'paid', 'overpaid', 'void', 'open'];

module.exports = (db) => {
  const r = express.Router();
  const getInvoice = (id) => {
    const inv = db.prepare(`${billing.INVOICE_WITH_PAID} WHERE i.id = ?`).get(id);
    return inv ? billing.decorate(inv) : null;
  };

  r.get('/', (req, res) => {
    const q = str(req.query.q);
    const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : null;
    const clientId = int(req.query.client_id);
    const where = [];
    const params = {};
    if (q) { where.push('(i.uid LIKE @q OR c.name LIKE @q)'); params.q = `%${q}%`; }
    if (clientId) { where.push('i.client_id = @cid'); params.cid = clientId; }
    let invoices = db.prepare(`${billing.INVOICE_WITH_PAID} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.issue_date DESC, i.id DESC`).all(params).map(billing.decorate);
    if (status) {
      invoices = invoices.filter((i) => {
        const s = i.computed_status;
        if (status === 'open') return i.status === 'issued' && i.balance > 0;
        if (status === 'overdue') return s === 'overdue' || s === 'partial-overdue';
        if (status === 'partial') return s === 'partial' || s === 'partial-overdue';
        return s === status;
      });
    }
    const clients = db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all();
    res.render('invoices/index', { title: 'Invoices', invoices, clients, q, status, clientId });
  });

  r.get('/new', (req, res) => {
    const clients = db.prepare('SELECT id, name, currency FROM clients ORDER BY name COLLATE NOCASE').all();
    const client = clients.find((c) => c.id === int(req.query.client_id)) || null;
    let projects = [];
    if (client) {
      projects = db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY name').all(client.id).map((p) => ({
        ...p,
        installments: db.prepare(`SELECT * FROM installments WHERE project_id = ? ORDER BY seq, id`).all(p.id)
          .filter((i) => !billing.installmentBilledOn(db, i.id)),
      }));
    }
    const terms = Number(res.locals.company.default_payment_terms || 14);
    res.render('invoices/new', {
      title: 'New invoice', clients, client, projects,
      preselect: [].concat(req.query.installment || []).map(Number),
      defaults: { issue_date: today(), due_date: addDays(today(), terms) },
    });
  });

  r.post('/', action((req, res) => {
    const clientId = int(req.body.client_id);
    need(clientId, 'Select a client.');
    const issueDate = str(req.body.issue_date);
    const dueDate = str(req.body.due_date);
    need(isISODate(issueDate) && isISODate(dueDate), 'Valid issue and due dates are required.');

    const items = [];
    for (const id of [].concat(req.body.installment_ids || [])) {
      const inst = db.prepare(`SELECT i.*, p.name project_name FROM installments i JOIN projects p ON p.id = i.project_id WHERE i.id = ?`).get(id);
      need(inst, 'Selected installment not found.');
      const desc = str(req.body[`inst_desc_${inst.id}`]) || `${inst.project_name} — ${inst.description}`;
      items.push({ description: desc, amount: inst.amount, installmentId: inst.id, projectId: inst.project_id });
    }
    const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const d = arr(req.body.item_description), a = arr(req.body.item_amount), p = arr(req.body.item_project);
    for (let i = 0; i < d.length; i++) {
      if (!str(d[i]) && !str(a[i])) continue;
      const amount = parseMoney(a[i]);
      need(str(d[i]), `Custom item ${i + 1}: description is required.`);
      need(amount !== null && amount > 0, `Custom item ${i + 1}: enter a positive amount.`);
      items.push({ description: str(d[i]), amount, projectId: int(p[i]) || null });
    }
    need(items.length, 'Select at least one installment or add a custom line item.');

    const inv = billing.createInvoice(db, { clientId, items, issueDate, dueDate, notes: str(req.body.notes), ...who(req) });
    req.flash('success', `Invoice ${inv.uid} issued.`);
    res.redirect(`/invoices/${inv.id}`);
  }));

  r.get('/:id', (req, res, next) => {
    const invoice = getInvoice(req.params.id);
    if (!invoice) return next();
    const items = db.prepare(`SELECT it.*, p.name project_name FROM invoice_items it LEFT JOIN projects p ON p.id = it.project_id
      WHERE it.invoice_id = ? ORDER BY position`).all(invoice.id);
    const payments = db.prepare(`SELECT p.*, u.email recorded_by_email,
        (SELECT id FROM payments r WHERE r.reverses_id = p.id) reversed_by
      FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.invoice_id = ? ORDER BY p.payment_date, p.id`).all(invoice.id);
    const history = db.prepare(`SELECT * FROM audit_log WHERE entity = 'invoice' AND entity_id = ? ORDER BY id`).all(invoice.uid);
    const creator = invoice.created_by ? db.prepare('SELECT email FROM users WHERE id = ?').get(invoice.created_by) : null;
    res.render('invoices/show', {
      title: `Invoice ${invoice.uid}`, invoice, items, payments, history, METHODS,
      creator: creator ? creator.email : 'system (scheduled)', client: JSON.parse(invoice.client_snapshot),
    });
  });

  // PDF is regenerated on demand from the immutable record — nothing is stored on disk.
  r.get('/:id/pdf', (req, res, next) => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return next();
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position').all(invoice.id);
    audit.record(db, { ...who(req), action: 'invoice.download', entity: 'invoice', entityId: invoice.uid });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${invoice.uid}.pdf"`);
    renderInvoicePdf(invoice, items, res);
  });

  r.post('/:id/payments', action((req, res) => {
    const amount = parseMoney(req.body.amount);
    const paymentDate = str(req.body.payment_date);
    need(amount !== null && amount > 0, 'Enter a positive payment amount.');
    need(isISODate(paymentDate), 'Enter a valid payment date.');
    need(METHODS.includes(req.body.method), 'Select a payment method.');
    const inv = getInvoice(req.params.id);
    need(inv, 'Invoice not found.');
    billing.recordPayment(db, { invoiceId: inv.id, amount, paymentDate, method: req.body.method,
      reference: str(req.body.reference), notes: str(req.body.notes), ...who(req) });
    const after = getInvoice(inv.id);
    if (after.balance < 0) req.flash('warning', `Payment recorded. The client has overpaid by ${after.currency} ${(-after.balance / 100).toFixed(2)} — this is held as a credit on the invoice.`);
    else req.flash('success', after.balance === 0 ? 'Payment recorded. Invoice is now fully paid.' : 'Partial payment recorded.');
    res.redirect(`/invoices/${inv.id}`);
  }));

  r.post('/:id/void', action((req, res) => {
    billing.voidInvoice(db, { invoiceId: Number(req.params.id), reason: str(req.body.reason), ...who(req) });
    req.flash('success', 'Invoice voided. Any installments on it can now be billed again.');
    res.redirect(`/invoices/${req.params.id}`);
  }));

  return r;
};
