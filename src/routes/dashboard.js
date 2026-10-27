'use strict';
const express = require('express');
const { INVOICE_WITH_PAID, decorate, nextContractPeriod } = require('../lib/billing');
const { today, addDays, addMonths } = require('../lib/dates');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const t = today();
    const invoices = db.prepare(`${INVOICE_WITH_PAID} WHERE i.status = 'issued'`).all().map(decorate);

    // Per-currency summary
    const byCur = {};
    const bucket = (c) => (byCur[c] ||= { currency: c, invoiced: 0, received: 0, outstanding: 0, overdue: 0, credit: 0, cashIn: 0, cashOut: 0, monthIn: 0 });
    for (const inv of invoices) {
      const b = bucket(inv.currency);
      b.invoiced += inv.total;
      b.received += inv.paid;
      if (inv.balance > 0) b.outstanding += inv.balance;
      if (inv.balance < 0) b.credit += -inv.balance;
      if (inv.balance > 0 && inv.due_date < t) b.overdue += inv.balance;
    }
    const monthStart = `${t.slice(0, 7)}-01`;
    for (const row of db.prepare(`SELECT currency, direction, SUM(amount) s,
        SUM(CASE WHEN entry_date >= ? THEN amount ELSE 0 END) m FROM cash_entries GROUP BY currency, direction`).all(monthStart)) {
      const b = bucket(row.currency);
      if (row.direction === 'in') { b.cashIn += row.s; b.monthIn += row.m; } else b.cashOut += row.s;
    }

    // Last 12 months of cashflow per currency
    const from = `${addMonths(monthStart, -11)}`;
    const months = Array.from({ length: 12 }, (_, i) => addMonths(from, i).slice(0, 7));
    const monthly = {};
    for (const row of db.prepare(`SELECT substr(entry_date,1,7) ym, currency, direction, SUM(amount) s FROM cash_entries
        WHERE entry_date >= ? GROUP BY ym, currency, direction`).all(from)) {
      const m = (monthly[row.currency] ||= Object.fromEntries(months.map((ym) => [ym, { in: 0, out: 0 }])));
      if (m[row.ym]) m[row.ym][row.direction] = row.s;
    }

    const overdue = invoices.filter((i) => i.balance > 0 && i.due_date < t).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 10);

    const horizon = addDays(t, 30);
    const upcoming = db.prepare(`SELECT ct.*, c.name client_name, c.currency FROM contracts ct JOIN clients c ON c.id = ct.client_id
        WHERE ct.status = 'active'`).all()
      .map((c) => ({ ...c, next: nextContractPeriod(c) }))
      .filter((c) => c.next && c.next.issueDate <= horizon)
      .sort((a, b) => a.next.issueDate.localeCompare(b.next.issueDate));

    const counts = db.prepare(`SELECT
        (SELECT COUNT(*) FROM clients) clients,
        (SELECT COUNT(*) FROM projects WHERE status IN ('planned','active','on_hold')) projects,
        (SELECT COUNT(*) FROM contracts WHERE status = 'active') contracts,
        (SELECT COUNT(*) FROM invoices WHERE status = 'issued') invoices`).get();

    const activity = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 12').all();

    res.render('dashboard', {
      title: 'Dashboard', summary: Object.values(byCur).sort((a, b) => a.currency.localeCompare(b.currency)),
      months, monthly, overdue, upcoming, counts, activity,
    });
  });

  return r;
};
