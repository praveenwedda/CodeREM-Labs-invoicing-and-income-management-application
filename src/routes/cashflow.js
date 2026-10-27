'use strict';
const express = require('express');
const billing = require('../lib/billing');
const audit = require('../lib/audit');
const { parseMoney, CURRENCIES, toInput } = require('../lib/money');
const { isISODate } = require('../lib/dates');
const { toCsv } = require('../lib/csv');
const { str, who, action, need } = require('./_helpers');

const CATEGORIES_IN = ['Other income', 'Capital injection', 'Refund received', 'Interest'];
const CATEGORIES_OUT = ['Salaries', 'Rent', 'Utilities', 'Software & subscriptions', 'Hardware', 'Marketing', 'Taxes', 'Bank charges', 'Contractors', 'Other expense'];

module.exports = (db) => {
  const r = express.Router();

  function query(req) {
    const currency = CURRENCIES.includes(req.query.currency) ? req.query.currency : null;
    const from = isISODate(req.query.from) ? req.query.from : null;
    const to = isISODate(req.query.to) ? req.query.to : null;
    const where = [];
    if (currency) where.push('e.currency = @currency');
    if (from) where.push('e.entry_date >= @from');
    if (to) where.push('e.entry_date <= @to');
    const entries = db.prepare(`SELECT e.*, u.email recorded_by_email,
        (SELECT id FROM cash_entries x WHERE x.reverses_id = e.id) reversed_by
      FROM cash_entries e LEFT JOIN users u ON u.id = e.recorded_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.entry_date, e.id`).all({ currency, from, to });
    // Running balance per currency (balance before `from` is carried forward as opening balance)
    const opening = {};
    if (from) {
      for (const row of db.prepare(`SELECT currency, SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) b
          FROM cash_entries WHERE entry_date < ? GROUP BY currency`).all(from)) opening[row.currency] = row.b;
    }
    const running = { ...opening };
    const totals = {};
    for (const e of entries) {
      const signed = e.direction === 'in' ? e.amount : -e.amount;
      running[e.currency] = (running[e.currency] || 0) + signed;
      e.balance = running[e.currency];
      const t = (totals[e.currency] ||= { in: 0, out: 0, opening: opening[e.currency] || 0 });
      t[e.direction] += e.amount;
    }
    for (const c of Object.keys(totals)) totals[c].closing = totals[c].opening + totals[c].in - totals[c].out;
    return { entries, totals, filters: { currency, from, to } };
  }

  r.get('/', (req, res) => {
    const { entries, totals, filters } = query(req);
    res.render('cashflow/index', { title: 'Cashflow ledger', entries: entries.reverse(), totals, filters,
      CATEGORIES_IN, CATEGORIES_OUT });
  });

  r.get('/export.csv', (req, res) => {
    const { entries } = query(req);
    audit.record(db, { ...who(req), action: 'cash.export', entity: 'cash_entry', details: { rows: entries.length, query: req.query } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coderem-cashflow.csv"');
    res.send(toCsv(['Entry #', 'Date', 'Direction', 'Currency', 'Amount', 'Balance', 'Category', 'Description', 'Recorded by', 'Recorded at'],
      entries.map((e) => [e.id, e.entry_date, e.direction, e.currency, toInput(e.amount), toInput(e.balance), e.category,
        e.description, e.recorded_by_email || 'system', e.created_at])));
  });

  r.post('/', action((req, res) => {
    const amount = parseMoney(req.body.amount);
    need(isISODate(req.body.entry_date), 'Enter a valid date.');
    need(CURRENCIES.includes(req.body.currency), 'Select a currency.');
    need(amount !== null && amount > 0, 'Enter a positive amount.');
    const direction = req.body.direction === 'out' ? 'out' : 'in';
    const allowed = direction === 'in' ? CATEGORIES_IN : CATEGORIES_OUT;
    need(allowed.includes(req.body.category), 'Select a category.');
    billing.recordCashEntry(db, { entryDate: req.body.entry_date, direction, amount, currency: req.body.currency,
      category: req.body.category, description: str(req.body.description), ...who(req) });
    req.flash('success', `Cash ${direction === 'in' ? 'inflow' : 'outflow'} recorded.`);
    res.redirect('/cashflow');
  }));

  r.post('/:id/reverse', action((req, res) => {
    billing.reverseCashEntry(db, { entryId: Number(req.params.id), reason: str(req.body.reason), ...who(req) });
    req.flash('success', 'Entry reversed.');
    res.redirect('/cashflow');
  }));

  return r;
};
