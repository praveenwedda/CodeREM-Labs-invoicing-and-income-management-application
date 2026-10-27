'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crl-e2e-'));

const test = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { verifyChain } = require('../src/lib/audit');

test('full admin workflow over HTTP', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';

  async function req(method, url, form) {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? encode({ _csrf: csrf, ...form }) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const body = res.headers.get('content-type')?.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    if (typeof body === 'string') { const m = body.match(/name="_csrf" value="([^"]+)"/); if (m) csrf = m[1]; }
    return { status: res.status, location: res.headers.get('location'), body, type: res.headers.get('content-type') };
  }
  function encode(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) for (const x of [].concat(v)) p.append(k, x);
    return p.toString();
  }
  const get = (u) => req('GET', u);
  const post = (u, f) => req('POST', u, f);

  try {
    assert.strictEqual((await get('/')).location, '/login');
    assert.strictEqual((await get('/login')).location, '/setup');
    await get('/setup');
    let r = await post('/setup', { name: 'Praveen', email: 'admin@coderemlabs.com', password: 'supersecret1', password2: 'supersecret1' });
    assert.strictEqual(r.location, '/login');
    assert.strictEqual((await get('/setup')).location, '/login', 'setup is closed once a user exists');

    await get('/login');
    r = await post('/login', { email: 'admin@coderemlabs.com', password: 'wrong' });
    assert.strictEqual(r.status, 401);
    r = await post('/login', { email: 'admin@coderemlabs.com', password: 'supersecret1' });
    assert.strictEqual(r.location, '/');
    await get('/');

    // CSRF protection
    const saved = csrf; csrf = 'bad';
    assert.strictEqual((await post('/clients', { name: 'X' })).status, 403);
    csrf = saved;

    r = await post('/clients', { name: 'Lanka Health', contact_person: 'Dr. Perera', email: 'ops@lh.lk', phone: '0112', address: 'Colombo 07', currency: 'LKR' });
    assert.match(r.location, /^\/clients\/1$/);

    r = await post('/projects', { client_id: '1', name: 'Patient Portal', total_amount: '1,000,000', status: 'active',
      inst_description: ['Advance 40%', 'Delivery 60%'], inst_amount: ['400000', '600000'], inst_due: ['2026-11-01', ''] });
    assert.strictEqual(r.location, '/projects/1');

    r = await post('/invoices', { client_id: '1', installment_ids: '1', issue_date: '2026-10-27', due_date: '2026-11-10',
      item_description: 'Domain & hosting setup', item_amount: '15000', item_project: '1', notes: 'Thank you' });
    assert.strictEqual(r.location, '/invoices/1');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = 1').get();
    assert.strictEqual(inv.total, 41500000);
    assert.match(inv.uid, /^CRL-2026-00001$/);

    const pdf1 = await get('/invoices/1/pdf');
    assert.strictEqual(pdf1.type, 'application/pdf');
    assert.strictEqual(pdf1.body.subarray(0, 5).toString(), '%PDF-');

    r = await post('/invoices/1/payments', { amount: '200000', payment_date: '2026-10-28', method: 'Bank transfer', reference: 'TT123' });
    r = await post('/invoices/1/payments', { amount: '300000', payment_date: '2026-10-29', method: 'Cheque', reference: 'CHQ9' });
    const paid = db.prepare('SELECT SUM(amount) s FROM payments WHERE invoice_id = 1').get().s;
    assert.strictEqual(paid, 50000000, 'overpayment accepted');

    r = await post('/contracts', { client_id: '1', project_id: '1', title: 'Monthly support', monthly_amount: '50000',
      start_date: '2026-11-01', invoice_day: '1', payment_terms: '14', issue_now: 'on' });
    assert.strictEqual(r.location, '/contracts/1');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM invoices WHERE contract_id = 1').get().n, 1);

    r = await post('/cashflow', { direction: 'out', entry_date: '2026-10-27', currency: 'LKR', amount: '25000', category: 'Rent', description: 'Office rent' });
    r = await post('/users', { name: 'Second Admin', email: 'two@coderemlabs.com', password: 'anotherpass1' });
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((s) => [s.key, s.value]));
    await post('/settings', { ...settings, bank_details: 'Bank of Ceylon — 123456' });

    // Every page renders
    for (const u of ['/', '/clients', '/clients/1', '/clients/1/edit', '/clients/new', '/projects/1', '/projects/1/edit', '/projects/new?client_id=1',
      '/contracts', '/contracts/new', '/contracts/new?client_id=1', '/contracts/1', '/contracts/1/edit', '/invoices', '/invoices?status=overpaid',
      '/invoices/new', '/invoices/new?client_id=1', '/invoices/1', '/invoices/2', '/payments', '/cashflow', '/cashflow?currency=LKR&from=2026-01-01',
      '/users', '/users/me', '/audit', '/audit?verify=1', '/settings']) {
      const p = await get(u);
      assert.strictEqual(p.status, 200, `${u} -> ${p.status}`);
      assert.doesNotMatch(p.body, /Something went wrong/, u);
    }
    assert.match((await get('/audit?verify=1')).body, /Integrity verified/);
    assert.strictEqual((await get('/cashflow/export.csv')).status, 200);
    assert.strictEqual((await get('/audit/export.csv')).status, 200);

    // Download again: identical document
    const pdf2 = await get('/invoices/1/pdf');
    assert.strictEqual(pdf2.body.length, pdf1.body.length);

    const actions = db.prepare('SELECT action FROM audit_log').all().map((a) => a.action);
    for (const a of ['system.setup', 'auth.login_failed', 'auth.login', 'client.create', 'project.create', 'invoice.issue',
      'invoice.download', 'payment.record', 'contract.create', 'cash.record', 'user.create', 'settings.update']) {
      assert.ok(actions.includes(a), `audit has ${a}`);
    }
    assert.ok(verifyChain(db).ok);
    await post('/logout', {});
    assert.strictEqual((await get('/')).location, '/login');
  } finally {
    server.close();
  }
});
