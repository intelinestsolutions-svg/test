/**
 * Reset the database.
 *   node src/reset.js            -> wipe all transactional + master data, keep users/settings
 *   node src/reset.js --reseed   -> wipe everything and re-run the demo seed
 *   node src/reset.js --all      -> also delete the database file itself (full clean start)
 */
import { existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DATA_DIR, db, get, run, tx } from './db.js';

const args = process.argv.slice(2);
const reseed = args.includes('--reseed');
const hard = args.includes('--all');
const yes = args.includes('--yes') || args.includes('-y');

const TABLES = [
  'stock_movements', 'fuel_logs', 'payments', 'online_payments', 'invoices',
  'trips', 'orders', 'purchase_items', 'purchases', 'attendance',
  'sites', 'customers', 'suppliers', 'items', 'mix_designs', 'lorries', 'staff',
];

async function ask(question) {
  if (yes) return 'y';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

if (hard) {
  console.log('\n  Full reset: the database file will be deleted.');
  if (await ask('  Type y to confirm') !== 'y') { console.log('  Cancelled.\n'); process.exit(0); }
  try { db.close(); } catch {}
  for (const f of ['clsbiz.db', 'clsbiz.db-wal', 'clsbiz.db-shm']) {
    const p = join(DATA_DIR, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  console.log('  Database removed.\n');
  if (reseed) {
    const { execSync } = await import('node:child_process');
    execSync('node src/seed.js', { stdio: 'inherit' });
  } else {
    console.log('  Run `npm run seed` next to add demo data.\n');
  }
  process.exit(0);
}

console.log('\n  This will delete all demo data:');
console.log('    orders, trips, invoices, payments, stock movements, fuel logs,');
console.log('    purchases, attendance, customers, sites, suppliers, items,');
console.log('    mix designs, lorries and staff records.');
console.log('    User accounts and settings are kept.\n');
if (await ask('  Type y to confirm') !== 'y') { console.log('  Cancelled.\n'); process.exit(0); }

const before = get('SELECT COUNT(*) AS n FROM orders').n;
tx(() => {
  for (const t of TABLES) run(`DELETE FROM ${t}`);
  run('DELETE FROM counters');
  run('DELETE FROM sessions');
});
// restart AUTOINCREMENT counters so reseeded demo data starts from 1 again
try {
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(',')})`);
} catch { /* sqlite_sequence only exists once an AUTOINCREMENT row is present */ }

console.log(`  Cleared ${before} order(s) and all related records.`);
if (reseed) {
  const { execSync } = await import('node:child_process');
  execSync('node src/seed.js', { stdio: 'inherit' });
} else {
  console.log('  Run `npm run seed` to load demo data again.\n');
}
