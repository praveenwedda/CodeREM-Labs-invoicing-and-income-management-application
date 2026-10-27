'use strict';
const config = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { runDueContracts } = require('./lib/billing');

const db = openDatabase(config.dbFile);
const app = createApp(db);

function runScheduler() {
  try {
    const issued = runDueContracts(db);
    if (issued.length) console.log(`[scheduler] issued ${issued.length} contract invoice(s): ${issued.join(', ')}`);
  } catch (e) {
    console.error('[scheduler] failed:', e);
  }
}

runScheduler();
setInterval(runScheduler, config.schedulerIntervalMs).unref();

app.listen(config.port, () => {
  console.log(`CodeREM Labs Income Manager running on http://localhost:${config.port}`);
  console.log(`Database: ${config.dbFile}`);
});
