'use strict';
const crypto = require('crypto');
const { getSettings } = require('../db');
const audit = require('./audit');
const { today, nowISO, addDays, addMonths, withDay, formatDate } = require('./dates');

class BillingError extends Error {}

// ---------------------------------------------------------------------------
// Invoice status
// ---------------------------------------------------------------------------

function invoiceStatus(inv, paid, asOf = today()) {
  if (inv.status === 'void') return 'void';
  const balance = inv.total - paid;
  if (balance < 0) return 'overpaid';
  if (balance === 0) return 'paid';
  if (inv.due_date < asOf) return paid > 0 ? 'partial-overdue' : 'overdue';
  return paid > 0 ? 'partial' : 'unpaid';
}

// SQL fragment: invoices with their paid amount. Use as a subquery/CTE.
const INVOICE_WITH_PAID = `
  SELECT i.*, c.name AS client_name,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
  FROM invoices i JOIN clients c ON c.id = i.client_id`;

function decorate(inv) {
  inv.balance = inv.total - inv.paid;
  inv.computed_status = invoiceStatus(inv, inv.paid);
  return inv;
}

// ---------------------------------------------------------------------------
// Invoice creation
// ---------------------------------------------------------------------------

function nextInvoiceUid(db, prefix, issueDate) {
  const year = issueDate.slice(0, 4);
  const stem = `${prefix}-${year}-`;
  const row = db.prepare(`SELECT uid FROM invoices WHERE uid LIKE ? ORDER BY uid DESC LIMIT 1`).get(`${stem}%`);
  const next = row ? Number(row.uid.slice(stem.length)) + 1 : 1;
  return `${stem}${String(next).padStart(5, '0')}`;
}

function contentHash(doc) {
  return crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

function installmentBilledOn(db, installmentId) {
  return db.prepare(`SELECT inv.uid FROM invoice_items it JOIN invoices inv ON inv.id = it.invoice_id
    WHERE it.installment_id = ? AND inv.status = 'issued'`).get(installmentId);
}

/**
 * Create an invoice. items: [{ description, amount, projectId?, installmentId?, contractId?, periodStart?, periodEnd? }]
 * actor: user object or null (system). Must be called inside a transaction (createInvoice wraps it).
 */
function createInvoiceTx(db, { clientId, items, issueDate, dueDate, notes, contractId = null, actor, ip = null }) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new BillingError('Client not found.');
  if (!items.length) throw new BillingError('An invoice needs at least one line item.');
  if (dueDate < issueDate) throw new BillingError('Due date cannot be before the issue date.');

  for (const it of items) {
    if (!it.description || !it.description.trim()) throw new BillingError('Every line item needs a description.');
    if (!Number.isSafeInteger(it.amount) || it.amount <= 0) throw new BillingError('Every line item needs a positive amount.');
    if (it.projectId) {
      const p = db.prepare('SELECT client_id FROM projects WHERE id = ?').get(it.projectId);
      if (!p || p.client_id !== client.id) throw new BillingError('A line item refers to a project of another client.');
    }
    if (it.installmentId) {
      const inst = db.prepare(`SELECT i.*, p.client_id FROM installments i JOIN projects p ON p.id = i.project_id WHERE i.id = ?`)
        .get(it.installmentId);
      if (!inst || inst.client_id !== client.id) throw new BillingError('A line item refers to an installment of another client.');
      const billed = installmentBilledOn(db, it.installmentId);
      if (billed) throw new BillingError(`Installment "${inst.description}" is already billed on invoice ${billed.uid}.`);
      it.projectId = inst.project_id;
    }
  }

  const settings = getSettings(db);
  const uid = nextInvoiceUid(db, settings.invoice_prefix || 'INV', issueDate);
  const total = items.reduce((s, it) => s + it.amount, 0);
  const clientSnapshot = {
    name: client.name, contact_person: client.contact_person, email: client.email,
    phone: client.phone, address: client.address, tax_id: client.tax_id,
  };
  const companySnapshot = {
    name: settings.company_name, address: settings.company_address, reg: settings.company_reg,
    tagline: settings.company_tagline, email: settings.company_email, phone: settings.company_phone,
    website: settings.company_website, bank_details: settings.bank_details, footer: settings.invoice_footer,
  };
  const hash = contentHash({
    uid, issueDate, dueDate, currency: client.currency, total, notes: notes || null,
    client: clientSnapshot, company: companySnapshot,
    items: items.map((it) => [it.description.trim(), it.amount, it.periodStart || null, it.periodEnd || null]),
  });

  const info = db.prepare(`INSERT INTO invoices (uid, client_id, contract_id, currency, issue_date, due_date, total, notes,
      client_snapshot, company_snapshot, content_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uid, client.id, contractId, client.currency, issueDate, dueDate, total, notes || null,
    JSON.stringify(clientSnapshot), JSON.stringify(companySnapshot), hash, actor ? actor.id : null, nowISO());
  const invoiceId = info.lastInsertRowid;

  const insItem = db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, amount, project_id,
      installment_id, contract_id, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  items.forEach((it, i) => insItem.run(invoiceId, i + 1, it.description.trim(), it.amount, it.projectId || null,
    it.installmentId || null, it.contractId || null, it.periodStart || null, it.periodEnd || null));

  audit.record(db, {
    actor, ip, action: 'invoice.issue', entity: 'invoice', entityId: uid,
    details: { client: client.name, currency: client.currency, total, issueDate, dueDate, contractId,
      items: items.map((it) => ({ description: it.description, amount: it.amount, installmentId: it.installmentId || null })) },
  });
  return { id: Number(invoiceId), uid };
}

function createInvoice(db, args) {
  return db.transaction(() => createInvoiceTx(db, args))();
}

function voidInvoice(db, { invoiceId, reason, actor, ip }) {
  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw new BillingError('Invoice not found.');
    if (inv.status === 'void') throw new BillingError('Invoice is already void.');
    if (!reason || !reason.trim()) throw new BillingError('A reason is required to void an invoice.');
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(invoiceId).s;
    if (paid !== 0) throw new BillingError('This invoice has payments recorded. Reverse them before voiding.');
    db.prepare(`UPDATE invoices SET status = 'void', void_reason = ?, voided_at = ?, voided_by = ? WHERE id = ?`)
      .run(reason.trim(), nowISO(), actor.id, invoiceId);
    audit.record(db, { actor, ip, action: 'invoice.void', entity: 'invoice', entityId: inv.uid, details: { reason: reason.trim() } });
  })();
}

// ---------------------------------------------------------------------------
// Payments & cashflow
// ---------------------------------------------------------------------------

function recordPayment(db, { invoiceId, amount, paymentDate, method, reference, notes, actor, ip }) {
  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw new BillingError('Invoice not found.');
    if (inv.status === 'void') throw new BillingError('Cannot record a payment against a void invoice.');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BillingError('Payment amount must be positive.');
    const now = nowISO();
    const p = db.prepare(`INSERT INTO payments (invoice_id, amount, payment_date, method, reference, notes, recorded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(invoiceId, amount, paymentDate, method, reference || null, notes || null, actor.id, now);
    db.prepare(`INSERT INTO cash_entries (entry_date, direction, amount, currency, category, description, payment_id, recorded_by, created_at)
      VALUES (?, 'in', ?, ?, 'Invoice payment', ?, ?, ?, ?)`)
      .run(paymentDate, amount, inv.currency, `Payment for ${inv.uid}${reference ? ` (ref ${reference})` : ''}`, p.lastInsertRowid, actor.id, now);
    audit.record(db, { actor, ip, action: 'payment.record', entity: 'invoice', entityId: inv.uid,
      details: { paymentId: Number(p.lastInsertRowid), amount, currency: inv.currency, paymentDate, method, reference: reference || null } });
    return Number(p.lastInsertRowid);
  })();
}

function reversePayment(db, { paymentId, reason, actor, ip }) {
  return db.transaction(() => {
    const p = db.prepare('SELECT p.*, i.uid, i.currency FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?').get(paymentId);
    if (!p) throw new BillingError('Payment not found.');
    if (p.amount < 0) throw new BillingError('A reversal cannot itself be reversed.');
    if (db.prepare('SELECT 1 FROM payments WHERE reverses_id = ?').get(paymentId)) throw new BillingError('This payment is already reversed.');
    if (!reason || !reason.trim()) throw new BillingError('A reason is required to reverse a payment.');
    const now = nowISO();
    const d = today();
    const r = db.prepare(`INSERT INTO payments (invoice_id, amount, payment_date, method, reference, notes, reverses_id, recorded_by, created_at)
      VALUES (?, ?, ?, 'Reversal', ?, ?, ?, ?, ?)`).run(p.invoice_id, -p.amount, d, p.reference, reason.trim(), p.id, actor.id, now);
    const original = db.prepare('SELECT id FROM cash_entries WHERE payment_id = ?').get(p.id);
    db.prepare(`INSERT INTO cash_entries (entry_date, direction, amount, currency, category, description, payment_id, reverses_id, recorded_by, created_at)
      VALUES (?, 'out', ?, ?, 'Payment reversal', ?, ?, ?, ?, ?)`)
      .run(d, p.amount, p.currency, `Reversal of payment #${p.id} on ${p.uid}: ${reason.trim()}`, r.lastInsertRowid, original ? original.id : null, actor.id, now);
    audit.record(db, { actor, ip, action: 'payment.reverse', entity: 'invoice', entityId: p.uid,
      details: { paymentId: p.id, amount: p.amount, reason: reason.trim() } });
  })();
}

function recordCashEntry(db, { entryDate, direction, amount, currency, category, description, actor, ip }) {
  if (!['in', 'out'].includes(direction)) throw new BillingError('Direction must be in or out.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new BillingError('Amount must be positive.');
  if (!category || !description) throw new BillingError('Category and description are required.');
  return db.transaction(() => {
    const r = db.prepare(`INSERT INTO cash_entries (entry_date, direction, amount, currency, category, description, recorded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(entryDate, direction, amount, currency, category, description, actor.id, nowISO());
    audit.record(db, { actor, ip, action: 'cash.record', entity: 'cash_entry', entityId: Number(r.lastInsertRowid),
      details: { entryDate, direction, amount, currency, category, description } });
  })();
}

function reverseCashEntry(db, { entryId, reason, actor, ip }) {
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM cash_entries WHERE id = ?').get(entryId);
    if (!e) throw new BillingError('Entry not found.');
    if (e.payment_id) throw new BillingError('Payment entries are corrected by reversing the payment on its invoice.');
    if (e.reverses_id) throw new BillingError('A reversal cannot itself be reversed.');
    if (db.prepare('SELECT 1 FROM cash_entries WHERE reverses_id = ?').get(entryId)) throw new BillingError('This entry is already reversed.');
    if (!reason || !reason.trim()) throw new BillingError('A reason is required.');
    db.prepare(`INSERT INTO cash_entries (entry_date, direction, amount, currency, category, description, reverses_id, recorded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(today(), e.direction === 'in' ? 'out' : 'in', e.amount, e.currency,
      'Reversal', `Reversal of entry #${e.id}: ${reason.trim()}`, e.id, actor.id, nowISO());
    audit.record(db, { actor, ip, action: 'cash.reverse', entity: 'cash_entry', entityId: e.id, details: { reason: reason.trim() } });
  })();
}

// ---------------------------------------------------------------------------
// Monthly maintenance / support contracts
// ---------------------------------------------------------------------------

// Period n (0-based) of a contract: [start + n months, start + n+1 months - 1 day].
function contractPeriod(contract, n) {
  const start = addMonths(contract.start_date, n);
  const end = addDays(addMonths(contract.start_date, n + 1), -1);
  return { start, end, issueDate: withDay(start, contract.invoice_day) };
}

// The next period still to be invoiced, or null if the contract has run its course.
function nextContractPeriod(contract) {
  const p = contractPeriod(contract, contract.periods_issued);
  if (contract.end_date && p.start > contract.end_date) return null;
  if (contract.end_date && p.end > contract.end_date) p.end = contract.end_date;
  return p;
}

function issueContractPeriod(db, contract, { issueDate, actor, ip }) {
  const period = nextContractPeriod(contract);
  if (!period) throw new BillingError('This contract has no remaining periods to invoice.');
  const res = createInvoiceTx(db, {
    clientId: contract.client_id,
    contractId: contract.id,
    issueDate,
    dueDate: addDays(issueDate, contract.payment_terms),
    actor, ip,
    items: [{
      description: `${contract.title} — ${formatDate(period.start)} to ${formatDate(period.end)}`,
      amount: contract.monthly_amount,
      projectId: contract.project_id,
      contractId: contract.id,
      periodStart: period.start,
      periodEnd: period.end,
    }],
  });
  db.prepare('UPDATE contracts SET periods_issued = periods_issued + 1, updated_at = ? WHERE id = ?').run(nowISO(), contract.id);
  contract.periods_issued += 1;
  if (!nextContractPeriod(contract)) {
    db.prepare(`UPDATE contracts SET status = 'ended', updated_at = ? WHERE id = ?`).run(nowISO(), contract.id);
    audit.record(db, { actor, ip, action: 'contract.end', entity: 'contract', entityId: contract.id, details: { reason: 'all periods invoiced' } });
  }
  return res;
}

// Issue the next period of a contract immediately, dated today.
function issueContractNow(db, { contractId, actor, ip }) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
    if (!c) throw new BillingError('Contract not found.');
    if (c.status === 'ended') throw new BillingError('This contract has ended.');
    return issueContractPeriod(db, c, { issueDate: today(), actor, ip });
  })();
}

// Called by the scheduler: issues every period whose scheduled issue date has arrived.
function runDueContracts(db, asOf = today()) {
  const issued = [];
  const contracts = db.prepare(`SELECT * FROM contracts WHERE status = 'active'`).all();
  for (const c of contracts) {
    db.transaction(() => {
      for (let guard = 0; guard < 120; guard++) {
        const p = nextContractPeriod(c);
        if (!p || p.issueDate > asOf) break;
        issued.push(issueContractPeriod(db, c, { issueDate: p.issueDate, actor: null }).uid);
        if (!nextContractPeriod(c)) break;
      }
    })();
  }
  return issued;
}

module.exports = {
  BillingError, invoiceStatus, INVOICE_WITH_PAID, decorate, installmentBilledOn,
  createInvoice, voidInvoice, recordPayment, reversePayment, recordCashEntry, reverseCashEntry,
  contractPeriod, nextContractPeriod, issueContractNow, runDueContracts, nextInvoiceUid,
};
