'use strict';

const CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'INR', 'AED'];

// "1,250.50" -> 125050 (minor units). Returns null for invalid input.
function parseMoney(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

function formatAmount(cents) {
  const n = Number(cents || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function formatMoney(cents, currency) {
  return `${currency || ''} ${formatAmount(cents)}`.trim();
}

// For pre-filling form inputs: 125050 -> "1250.50"
function toInput(cents) {
  if (cents === null || cents === undefined) return '';
  return (Number(cents) / 100).toFixed(2);
}

module.exports = { CURRENCIES, parseMoney, formatAmount, formatMoney, toInput };
