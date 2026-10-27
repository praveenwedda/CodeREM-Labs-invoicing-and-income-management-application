# CodeREM Labs — Income Manager

Income, invoicing and cashflow management for **CodeREM Labs Pvt. Ltd.**
*Medical Grade Precision, F1 Grade Performance*

Tracks clients, projects and their installment plans. It issues invoices with permanent UIDs, runs monthly maintenance and support contracts on a schedule, and records payments (partial or over). It also keeps a cashflow ledger and an audit trail that cannot be altered.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

On first launch, open the app and you'll be taken to **/setup** to create the first administrator.
After that, the setup page is closed, and further administrators are added under **Administrators**.

Requirements: Node.js 20+. Everything is stored in a single SQLite file (`data/coderem.db`), and no other services are needed.

```bash
npm test             # unit + end-to-end tests
npm run dev          # auto-restart on code changes
```

Configuration is optional (see `.env.example`): `PORT`, `DATA_DIR`, `SESSION_SECRET`, `AUDIT_SECRET`, `SECURE_COOKIES`, `TZ_NAME` (default `Asia/Colombo`).

## What it does

| Area | Features |
|---|---|
| **Clients** | Contact details, billing address, tax ID, and billing currency (LKR, USD, …). Each client shows its projects, contracts, invoices, and balance or credit. |
| **Projects** | Project total, status and dates, plus an **installment plan** (description, amount, expected date). It shows planned, invoiced, received and remaining-to-bill amounts, and warns if the installments don't add up to the total. |
| **Invoices** | Bill **one or more installments across any of a client's projects**, plus custom line items. Each invoice gets a permanent UID (`CRL-2026-00001`), and the PDF can be downloaded at any time. |
| **Contracts** | Monthly maintenance and support. You set the monthly amount, service start and optional end date, the invoice day of the month (1–28), and payment terms. You can also choose to **issue the first invoice right away**. After that, invoices are **issued automatically** on schedule. Contracts can be paused, resumed, ended, or issued early with "issue next invoice now". |
| **Payments** | Record any amount against an invoice. Part payments and **overpayments** (shown as client credit) are both accepted. Mistakes are corrected with a reversal, not an edit. |
| **Cashflow** | Every payment is posted to a ledger automatically. Expenses and other income can be added by hand. The ledger shows running and opening/closing balances per currency, and exports to CSV. |
| **Dashboard** | Receivables, overdue amounts, cash received this month, cash position, a 12-month cashflow chart, upcoming contract invoices, and recent activity. |
| **Administrators** | Any admin can create admins, deactivate or reactivate them, and reset passwords. Admins are never deleted. |
| **Audit trail** | Every action is recorded, including logins, failed logins, downloads, exports and settings changes. The log can be filtered, exported, and **checked for tampering**. |

## Integrity guarantees

The **database itself** enforces these rules through SQLite triggers in `src/schema.sql`, so they don't depend on the application code behaving correctly:

- **Audit log is append-only.** Any `UPDATE` or `DELETE` is rejected, for every user, admins included. Each entry is also HMAC-signed and chained to the previous one. **Audit trail → Verify integrity** detects any edit made by bypassing the app (for example, by editing the DB file directly).
- **Issued invoices are immutable.** An invoice cannot be deleted, and its content can't be changed. The only allowed change is *voiding* it, which requires a reason and is only possible once its payments have been reversed. Voiding frees the invoice's installments to be billed again.
- **Payments and ledger entries are immutable.** Corrections are made with reversing entries, so the history is always complete.
- **An installment can't be billed twice** while it's on an active invoice.

## Lean invoice storage

No PDF files are stored. When an invoice is issued, the system saves a snapshot of:

- the client's details
- the company's details
- the line items

The PDF is then **regenerated from that snapshot on every download**. This means:

- Every download of a given UID shows exactly the same content.
- Later edits to the client or company settings don't change old invoices.
- Each PDF carries a SHA-256 *document fingerprint* that matches the one shown in the system.

## Contract scheduling

A contract's months run from its start date. For example, a contract starting 15 Jan has periods 15 Jan–14 Feb, 15 Feb–14 Mar, and so on. Each period's invoice is dated on the contract's invoice day in the month the period starts.

The scheduler runs when the server starts and then every 15 minutes. It issues any invoice whose date has arrived, exactly once per period. If the server was offline, it catches up on missed periods.

When a paused contract is resumed, months that passed during the pause are skipped by default. Tick "also bill months missed while paused" to invoice them instead.

> The server needs to be running for scheduled invoices to be issued. If it's down on an invoice day, that invoice is issued, with its scheduled date, as soon as the server is back.

## Deployment notes

- **Back up the `data/` folder.** It holds the database and `.secrets.json`. The audit-chain key lives in that file, so losing it means older audit entries can no longer be verified. In production, set `SESSION_SECRET` and `AUDIT_SECRET` explicitly and store them safely.
- Run it behind HTTPS (for example, with nginx or Caddy) and set `SECURE_COOKIES=true`.
- Fill in **Settings → Payment / bank details**, phone, email and website. They're printed on every invoice.

## Project layout

```
src/
  server.js          entry point + scheduler loop
  app.js             Express app (helmet, sessions, CSRF, routes)
  schema.sql         tables + immutability triggers
  db.js, config.js
  lib/billing.js     invoices, payments, reversals, contracts, scheduler
  lib/audit.js       hash-chained audit log + verification
  lib/pdf.js         invoice PDF rendering
  routes/            one router per area
  views/             EJS templates
public/              CSS + small JS
test/                node:test unit + end-to-end tests
```
