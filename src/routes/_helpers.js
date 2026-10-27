'use strict';
const { BillingError } = require('../lib/billing');

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const who = (req) => ({ actor: req.user, ip: req.ip });

// Field-level diff for audit details.
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    if ((before ? before[f] : null) !== after[f]) out[f] = { from: before ? before[f] : null, to: after[f] };
  }
  return out;
}

// Wrap a POST handler: BillingError / ValidationError -> flash + redirect back.
class ValidationError extends Error {}
function action(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) {
      if (e instanceof BillingError || e instanceof ValidationError) {
        req.flash('error', e.message);
        return res.redirect(req.get('referer') || '/');
      }
      next(e);
    }
  };
}

function need(cond, message) { if (!cond) throw new ValidationError(message); }

module.exports = { str, int, who, diff, action, need, ValidationError };
