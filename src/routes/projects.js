'use strict';
const express = require('express');
const audit = require('../lib/audit');
const { parseMoney } = require('../lib/money');
const { nowISO, isISODate } = require('../lib/dates');
const { installmentBilledOn, INVOICE_WITH_PAID, decorate } = require('../lib/billing');
const { str, who, diff, action, need } = require('./_helpers');

const STATUSES = ['planned', 'active', 'on_hold', 'completed', 'cancelled'];
const FIELDS = ['name', 'description', 'total_amount', 'status', 'start_date', 'end_date'];

function readForm(body) {
  return {
    name: str(body.name), description: str(body.description), total_amount: parseMoney(body.total_amount || '0'),
    status: str(body.status) || 'active', start_date: str(body.start_date), end_date: str(body.end_date),
  };
}

function validate(f) {
  need(f.name, 'Project name is required.');
  need(f.total_amount !== null && f.total_amount >= 0, 'Enter a valid project total.');
  need(STATUSES.includes(f.status), 'Invalid status.');
  need(!f.start_date || isISODate(f.start_date), 'Invalid start date.');
  need(!f.end_date || isISODate(f.end_date), 'Invalid end date.');
  need(!f.start_date || !f.end_date || f.end_date >= f.start_date, 'End date must be after the start date.');
}

// Installment rows arrive as parallel arrays inst_description[], inst_amount[], inst_due[]
function readInstallments(body) {
  const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const d = arr(body.inst_description), a = arr(body.inst_amount), due = arr(body.inst_due);
  const rows = [];
  for (let i = 0; i < d.length; i++) {
    if (!str(d[i]) && !str(a[i])) continue;
    const amount = parseMoney(a[i]);
    need(str(d[i]), `Installment ${i + 1}: description is required.`);
    need(amount !== null && amount > 0, `Installment ${i + 1}: enter a positive amount.`);
    need(!str(due[i]) || isISODate(due[i]), `Installment ${i + 1}: invalid due date.`);
    rows.push({ description: str(d[i]), amount, due_date: str(due[i]) });
  }
  return rows;
}

module.exports = (db) => {
  const r = express.Router();
  const getProject = (id) => db.prepare(`SELECT p.*, c.name client_name, c.currency FROM projects p
    JOIN clients c ON c.id = p.client_id WHERE p.id = ?`).get(id);

  r.get('/new', (req, res, next) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.query.client_id);
    if (!client) return next();
    res.render('projects/form', { title: 'New project', client, project: { status: 'active' }, isNew: true });
  });

  r.post('/', action((req, res, next) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.body.client_id);
    if (!client) return next();
    const f = readForm(req.body);
    validate(f);
    const installments = readInstallments(req.body);
    const id = db.transaction(() => {
      const now = nowISO();
      const info = db.prepare(`INSERT INTO projects (client_id, name, description, total_amount, status, start_date, end_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(client.id, f.name, f.description, f.total_amount, f.status, f.start_date, f.end_date, now, now);
      const pid = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO installments (project_id, seq, description, amount, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      installments.forEach((it, i) => ins.run(pid, i + 1, it.description, it.amount, it.due_date, now));
      audit.record(db, { ...who(req), action: 'project.create', entity: 'project', entityId: pid,
        details: { client: client.name, ...f, installments } });
      return pid;
    })();
    const sum = installments.reduce((s, i) => s + i.amount, 0);
    req.flash('success', `Project "${f.name}" created.`);
    if (installments.length && sum !== f.total_amount) req.flash('warning', 'Note: the installments do not add up to the project total.');
    res.redirect(`/projects/${id}`);
  }));

  r.get('/:id', (req, res, next) => {
    const project = getProject(req.params.id);
    if (!project) return next();
    const installments = db.prepare('SELECT * FROM installments WHERE project_id = ? ORDER BY seq, id').all(project.id)
      .map((i) => ({ ...i, billedOn: installmentBilledOn(db, i.id) }));
    const invoices = db.prepare(`${INVOICE_WITH_PAID} WHERE i.id IN (SELECT invoice_id FROM invoice_items WHERE project_id = ?)
      ORDER BY i.issue_date DESC`).all(project.id).map(decorate);
    for (const inv of invoices) {
      inv.project_amount = db.prepare('SELECT SUM(amount) s FROM invoice_items WHERE invoice_id = ? AND project_id = ?').get(inv.id, project.id).s;
    }
    const live = invoices.filter((i) => i.status === 'issued');
    // Payments on invoices covering several projects are attributed pro rata.
    const received = live.reduce((s, i) => s + Math.round(Math.min(Math.max(i.paid, 0), i.total) * i.project_amount / i.total), 0);
    const totals = {
      planned: installments.reduce((s, i) => s + i.amount, 0),
      invoiced: live.reduce((s, i) => s + i.project_amount, 0),
      received,
    };
    const contracts = db.prepare('SELECT * FROM contracts WHERE project_id = ?').all(project.id);
    res.render('projects/show', { title: project.name, project, installments, invoices, totals, contracts });
  });

  r.get('/:id/edit', (req, res, next) => {
    const project = getProject(req.params.id);
    if (!project) return next();
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(project.client_id);
    res.render('projects/form', { title: `Edit ${project.name}`, client, project, isNew: false });
  });

  r.post('/:id', action((req, res, next) => {
    const before = getProject(req.params.id);
    if (!before) return next();
    const f = readForm(req.body);
    validate(f);
    const changes = diff(before, f, FIELDS);
    db.transaction(() => {
      db.prepare(`UPDATE projects SET name=?, description=?, total_amount=?, status=?, start_date=?, end_date=?, updated_at=? WHERE id=?`)
        .run(f.name, f.description, f.total_amount, f.status, f.start_date, f.end_date, nowISO(), before.id);
      if (Object.keys(changes).length) audit.record(db, { ...who(req), action: 'project.update', entity: 'project', entityId: before.id, details: changes });
    })();
    req.flash('success', 'Project updated.');
    res.redirect(`/projects/${before.id}`);
  }));

  // ---- Installments -------------------------------------------------------

  r.post('/:id/installments', action((req, res, next) => {
    const project = getProject(req.params.id);
    if (!project) return next();
    const description = str(req.body.description);
    const amount = parseMoney(req.body.amount);
    const due = str(req.body.due_date);
    need(description, 'Installment description is required.');
    need(amount !== null && amount > 0, 'Enter a positive installment amount.');
    need(!due || isISODate(due), 'Invalid due date.');
    db.transaction(() => {
      const seq = (db.prepare('SELECT MAX(seq) m FROM installments WHERE project_id = ?').get(project.id).m || 0) + 1;
      const info = db.prepare('INSERT INTO installments (project_id, seq, description, amount, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(project.id, seq, description, amount, due, nowISO());
      audit.record(db, { ...who(req), action: 'installment.create', entity: 'project', entityId: project.id,
        details: { installmentId: Number(info.lastInsertRowid), description, amount, due_date: due } });
    })();
    req.flash('success', 'Installment added.');
    res.redirect(`/projects/${project.id}`);
  }));

  r.post('/:id/installments/:iid', action((req, res, next) => {
    const inst = db.prepare('SELECT * FROM installments WHERE id = ? AND project_id = ?').get(req.params.iid, req.params.id);
    if (!inst) return next();
    const billed = installmentBilledOn(db, inst.id);
    need(!billed, `This installment is billed on ${billed && billed.uid} and can no longer be changed.`);
    if (req.body.op === 'delete') {
      db.transaction(() => {
        const used = db.prepare('SELECT 1 FROM invoice_items WHERE installment_id = ?').get(inst.id);
        need(!used, 'This installment appears on a (void) invoice and is kept for the record.');
        db.prepare('DELETE FROM installments WHERE id = ?').run(inst.id);
        audit.record(db, { ...who(req), action: 'installment.delete', entity: 'project', entityId: inst.project_id,
          details: { installmentId: inst.id, description: inst.description, amount: inst.amount } });
      })();
      req.flash('success', 'Installment removed.');
    } else {
      const f = { description: str(req.body.description), amount: parseMoney(req.body.amount), due_date: str(req.body.due_date) };
      need(f.description, 'Installment description is required.');
      need(f.amount !== null && f.amount > 0, 'Enter a positive installment amount.');
      need(!f.due_date || isISODate(f.due_date), 'Invalid due date.');
      const changes = diff(inst, f, ['description', 'amount', 'due_date']);
      db.transaction(() => {
        db.prepare('UPDATE installments SET description=?, amount=?, due_date=? WHERE id=?').run(f.description, f.amount, f.due_date, inst.id);
        if (Object.keys(changes).length) audit.record(db, { ...who(req), action: 'installment.update', entity: 'project',
          entityId: inst.project_id, details: { installmentId: inst.id, ...changes } });
      })();
      req.flash('success', 'Installment updated.');
    }
    res.redirect(`/projects/${req.params.id}`);
  }));

  return r;
};
