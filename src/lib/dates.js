'use strict';
const config = require('../config');

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(s) {
  if (!ISO_RE.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Today's date in the business timezone (Asia/Colombo by default).
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function nowISO() { return new Date().toISOString(); }

function parts(iso) { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function fmt(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

// Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29).
function addMonths(iso, n) {
  const { y, m, d } = parts(iso);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Same year/month as `iso`, with the given day of month.
function withDay(iso, day) {
  const { y, m } = parts(iso);
  return fmt(y, m, Math.min(day, daysInMonth(y, m)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso) {
  if (!iso) return '';
  const { y, m, d } = parts(iso.slice(0, 10));
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

function formatDateTime(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts));
}

module.exports = { isISODate, today, nowISO, addMonths, addDays, withDay, formatDate, formatDateTime };
