'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crl-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const billing = require('../src/lib/billing');
const audit = require('../src/lib/audit');
const { parseMoney, formatAmount } = require('../src/lib/money');
const { addMonths } = require('../src/lib/dates');

function fresh() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO users (name, email, password_hash, created_at) VALUES ('A', 'a@x.lk', 'x', '2026-01-01')`).run();
  db.prepare(`INSERT INTO clients (name, currency, created_at, updated_at) VALUES ('Acme', 'LKR', 'now', 'now')`).run();
  db.prepare(`INSERT INTO projects (client_id, name, total_amount, created_at, updated_at) VALUES (1, 'App', 100000, 'now', 'now')`).run();
  db.prepare(`INSERT INTO installments (project_id, seq, description, amount, created_at) VALUES (1, 1, 'Advance', 40000, 'now'), (1, 2, 'Final', 60000, 'now')`).run();
  return { db, actor: { id: 1, email: 'a@x.lk' } };
}

test('money parsing and formatting', () => {
  assert.strictEqual(parseMoney('1,250.5'), 125050);
  assert.strictEqual(parseMoney('10'), 1000);
  assert.strictEqual(parseMoney('1.234'), null);
  assert.strictEqual(parseMoney('abc'), null);
  assert.strictEqual(formatAmount(123456789), '1,234,567.89');
  assert.strictEqual(formatAmount(-5), '-0.05');
});

test('addMonths clamps to month end', () => {
  assert.strictEqual(addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(addMonths('2026-01-31', 2), '2026-03-31');
  assert.strictEqual(addMonths('2026-11-15', 3), '2027-02-15');
});

test('invoice for multiple installments, sequential UIDs, no double billing', () => {
  const { db, actor } = fresh();
  const a = billing.createInvoice(db, { clientId: 1, issueDate: '2026-03-01', dueDate: '2026-03-15', actor,
    items: [{ description: 'Advance', amount: 40000, installmentId: 1 }, { description: 'Final', amount: 60000, installmentId: 2 }] });
  assert.strictEqual(a.uid, 'CRL-2026-00001');
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(a.id);
  assert.strictEqual(inv.total, 100000);
  assert.throws(() => billing.createInvoice(db, { clientId: 1, issueDate: '2026-03-02', dueDate: '2026-03-15', actor,
    items: [{ description: 'Again', amount: 40000, installmentId: 1 }] }), /already billed/);
  const b = billing.createInvoice(db, { clientId: 1, issueDate: '2026-04-01', dueDate: '2026-04-15', actor, items: [{ description: 'Extra', amount: 500 }] });
  assert.strictEqual(b.uid, 'CRL-2026-00002');
});

test('partial, full and over payments; reversal', () => {
  const { db, actor } = fresh();
  const { id } = billing.createInvoice(db, { clientId: 1, issueDate: '2026-03-01', dueDate: '2099-03-15', actor, items: [{ description: 'X', amount: 10000 }] });
  const paid = () => db.prepare('SELECT SUM(amount) s FROM payments WHERE invoice_id = ?').get(id).s;
  const inv = () => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  const p1 = billing.recordPayment(db, { invoiceId: id, amount: 4000, paymentDate: '2026-03-05', method: 'Cash', actor });
  assert.strictEqual(billing.invoiceStatus(inv(), paid()), 'partial');
  billing.recordPayment(db, { invoiceId: id, amount: 7000, paymentDate: '2026-03-06', method: 'Cash', actor });
  assert.strictEqual(billing.invoiceStatus(inv(), paid()), 'overpaid');
  billing.reversePayment(db, { paymentId: p1, reason: 'bounced', actor });
  assert.strictEqual(paid(), 7000);
  assert.throws(() => billing.reversePayment(db, { paymentId: p1, reason: 'again', actor }), /already reversed/);
  const net = db.prepare(`SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) n FROM cash_entries`).get().n;
  assert.strictEqual(net, 7000);
});

test('void requires payments reversed; voided installment becomes billable again', () => {
  const { db, actor } = fresh();
  const { id } = billing.createInvoice(db, { clientId: 1, issueDate: '2026-03-01', dueDate: '2026-03-15', actor, items: [{ description: 'Adv', amount: 40000, installmentId: 1 }] });
  const pid = billing.recordPayment(db, { invoiceId: id, amount: 100, paymentDate: '2026-03-02', method: 'Cash', actor });
  assert.throws(() => billing.voidInvoice(db, { invoiceId: id, reason: 'wrong', actor }), /Reverse them/);
  billing.reversePayment(db, { paymentId: pid, reason: 'err', actor });
  billing.voidInvoice(db, { invoiceId: id, reason: 'wrong', actor });
  assert.strictEqual(billing.installmentBilledOn(db, 1), undefined);
});

test('database enforces immutability', () => {
  const { db, actor } = fresh();
  const { id } = billing.createInvoice(db, { clientId: 1, issueDate: '2026-03-01', dueDate: '2026-03-15', actor, items: [{ description: 'X', amount: 100 }] });
  assert.throws(() => db.prepare('UPDATE invoices SET total = 1 WHERE id = ?').run(id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM invoices WHERE id = ?').run(id), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE invoice_items SET amount = 1').run(), /immutable/);
  assert.throws(() => db.prepare('UPDATE audit_log SET action = ?').run('x'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM users').run(), /deactivate/);
});

test('audit chain verifies and detects tampering', () => {
  const { db, actor } = fresh();
  for (let i = 0; i < 5; i++) audit.record(db, { actor, action: 'test.event', details: { i } });
  assert.deepStrictEqual(audit.verifyChain(db), { ok: true, count: 5 });
  // Simulate someone bypassing the app: drop the trigger and edit a row directly.
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare(`UPDATE audit_log SET details = '{"i":99}' WHERE id = 3`).run();
  const v = audit.verifyChain(db);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 3);
});

test('contract scheduler issues each due month exactly once', () => {
  const { db } = fresh();
  db.prepare(`INSERT INTO contracts (client_id, title, monthly_amount, start_date, end_date, invoice_day, payment_terms, created_at, updated_at)
    VALUES (1, 'Support', 25000, '2026-01-15', '2026-04-14', 5, 14, 'now', 'now')`).run();
  // Periods: Jan15–Feb14 (issue Jan 5), Feb15–Mar14 (Feb 5), Mar15–Apr14 (Mar 5)
  assert.deepStrictEqual(billing.runDueContracts(db, '2026-02-10'), ['CRL-2026-00001', 'CRL-2026-00002']);
  assert.deepStrictEqual(billing.runDueContracts(db, '2026-02-20'), []);
  assert.deepStrictEqual(billing.runDueContracts(db, '2026-12-31'), ['CRL-2026-00003']);
  const c = db.prepare('SELECT * FROM contracts WHERE id = 1').get();
  assert.strictEqual(c.status, 'ended');
  const items = db.prepare('SELECT period_start, period_end FROM invoice_items ORDER BY id').all();
  assert.deepStrictEqual(items.map((i) => [i.period_start, i.period_end]),
    [['2026-01-15', '2026-02-14'], ['2026-02-15', '2026-03-14'], ['2026-03-15', '2026-04-14']]);
});

test('issue contract invoice right away', () => {
  const { db, actor } = fresh();
  db.prepare(`INSERT INTO contracts (client_id, title, monthly_amount, start_date, invoice_day, payment_terms, created_at, updated_at)
    VALUES (1, 'Support', 25000, '2099-01-01', 1, 7, 'now', 'now')`).run();
  const r = billing.issueContractNow(db, { contractId: 1, actor });
  assert.ok(r.uid);
  const c = db.prepare('SELECT * FROM contracts WHERE id = 1').get();
  assert.strictEqual(c.periods_issued, 1);
  assert.strictEqual(billing.nextContractPeriod(c).start, '2099-02-01');
});
