/**
 * Make a safe copy of the database.
 *   node src/backup.js                 -> data/backups/clsbiz-YYYY-MM-DD-HHmm.db
 *   node src/backup.js --out /tmp/x.db -> custom destination
 *
 * Uses SQLite's VACUUM INTO so the copy is consistent even while the
 * server is running, and prunes free pages from the file.
 */
import { mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { db, DATA_DIR } from './db.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);

let dest;
if (outIdx >= 0 && args[outIdx + 1]) {
  dest = resolve(args[outIdx + 1]);
} else {
  const dir = join(DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  dest = join(dir, `clsbiz-${stamp}.db`);
}

try {
  db.exec('VACUUM INTO ?', dest);
} catch (e) {
  // Older builds without VACUUM INTO parameter binding: fall back to a file copy.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  const src = join(DATA_DIR, 'clsbiz.db');
  if (!existsSync(src)) { console.error(`\n  No database found at ${src}\n`); process.exit(1); }
  copyFileSync(src, dest);
}

const size = statSync(dest).size;
console.log(`\n  Backup written: ${isAbsolute(dest) ? dest : dest}`);
console.log(`  Size: ${(size / 1024).toFixed(1)} KB\n`);
