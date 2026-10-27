'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const SqliteStore = require('./lib/sessionStore');
const { csrf, flash, requireAuth } = require('./lib/middleware');
const { formatMoney, formatAmount, toInput, CURRENCIES } = require('./lib/money');
const { formatDate, formatDateTime, today } = require('./lib/dates');
const { getSettings } = require('./db');

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'upgrade-insecure-requests': null } } }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(session({
    store: new SqliteStore(db),
    secret: config.sessionSecret,
    name: 'crl.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(flash);
  app.use(csrf);
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      fmtMoney: formatMoney, fmtAmount: formatAmount, toInput, fmtDate: formatDate, fmtDateTime: formatDateTime,
      today: today(), CURRENCIES, path: req.path, user: null, company: getSettings(db),
    });
    next();
  });

  // Public routes (login, first-run setup)
  app.use(require('./routes/auth')(db));

  // Everything below requires an authenticated admin
  app.use(requireAuth(db));
  app.use(require('./routes/dashboard')(db));
  app.use('/clients', require('./routes/clients')(db));
  app.use('/projects', require('./routes/projects')(db));
  app.use('/contracts', require('./routes/contracts')(db));
  app.use('/invoices', require('./routes/invoices')(db));
  app.use('/payments', require('./routes/payments')(db));
  app.use('/cashflow', require('./routes/cashflow')(db));
  app.use('/users', require('./routes/users')(db));
  app.use('/audit', require('./routes/audit')(db));
  app.use('/settings', require('./routes/settings')(db));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. It has been logged.' });
  });
  return app;
}

module.exports = { createApp };
