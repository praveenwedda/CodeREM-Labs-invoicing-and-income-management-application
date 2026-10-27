'use strict';
const express = require('express');
const billing = require('../lib/billing');
const { str, who, action } = require('./_helpers');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const from = str(req.query.from);
    const to = str(req.query.to);
    const where = [];
    if (from) where.push('p.payment_date >= @from');
    if (to) where.push('p.payment_date <= @to');
    const payments = db.prepare(`SELECT p.*, i.uid, i.currency, c.name client_name, u.email recorded_by_email,
        (SELECT id FROM payments r WHERE r.reverses_id = p.id) reversed_by
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
      LEFT JOIN users u ON u.id = p.recorded_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.payment_date DESC, p.id DESC`).all({ from, to });
    const totals = {};
    for (const p of payments) totals[p.currency] = (totals[p.currency] || 0) + p.amount;
    res.render('payments/index', { title: 'Payments received', payments, totals, from, to });
  });

  r.post('/:id/reverse', action((req, res) => {
    const p = db.prepare('SELECT invoice_id FROM payments WHERE id = ?').get(req.params.id);
    billing.reversePayment(db, { paymentId: Number(req.params.id), reason: str(req.body.reason), ...who(req) });
    req.flash('success', 'Payment reversed. A reversing entry was added to the ledger.');
    res.redirect(p ? `/invoices/${p.invoice_id}` : '/payments');
  }));

  return r;
};
