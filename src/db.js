/**
 * Database layer - uses Node.js built-in node:sqlite (no external packages).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

/* Re-exported so every module can pull date helpers from one place. */
export { today, nowLocal, addDays, daysBetween, monthStart } from './lib/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA_DIR = process.env.CLS_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'clsbiz.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* ------------------------------------------------------------------ *
 * Cap build
 *
 * Memberitahu commit mana yang sedang berjalan. Ini penting kerana
 * Node membaca modul sekali sahaja semasa permulaan: selepas fail
 * dimuat naik melalui FTP, proses masih memegang kod lama sehingga ia
 * dimulakan semula. Tanpa cap ini mustahil membezaskan "deploy sudah
 * sampai" daripada "proses basi masih hidup" - kedua-duanya balas
 * HTTP 200 dengan halaman yang kelihatan normal.
 *
 * Workflow deploy menulis build.json semasa muat naik. Fail itu tidak
 * disimpan dalam git, jadi setiap pemasangan membina capnya sendiri
 * dan nilai 'dev' digunakan semasa pembangunan tempatan.
 * ------------------------------------------------------------------ */
function readBuildStamp() {
  try {
    const raw = readFileSync(join(ROOT, 'build.json'), 'utf8');
    const sha = String(JSON.parse(raw).sha || '').trim();
    // Hanya terima bentuk hash git supaya fail rosak tidak menyebabkan
    // nilai palsu yang disalahbaca sebagai versi yang lain.
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch {
    // Tiada build.json - ini pemasangan biasa, ini bukan ralat.
  }
  return 'dev';
}
export const APP_BUILD = readBuildStamp();

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */
db.exec(`
-- ===== system ======================================================
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ===== branches / cawangan =========================================
-- Setiap senarai (pesanan, pelanggan, stok, lori, kakitangan) dimiliki
-- oleh satu cawangan. Stok dan pelanggan diasingkan ikut cawangan.
CREATE TABLE IF NOT EXISTS branches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,                 -- papar|putatan|tuaran|sikuati|membakut
  name       TEXT NOT NULL,
  address    TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

-- ===== users / login ===============================================
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'office',   -- admin | office | driver | lab
  staff_id      INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  lang          TEXT DEFAULT 'bm',
  last_login    TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ===== staff =======================================================
CREATE TABLE IF NOT EXISTS staff (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no          TEXT UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'driver',  -- driver|dispatcher|lab|mechanic|admin
  phone           TEXT,
  ic_no           TEXT,
  licence_class   TEXT,                            -- e.g. D / DA / G1 / G1A
  licence_expiry  TEXT,
  address         TEXT,
  salary          REAL DEFAULT 0,
  join_date       TEXT,
  status          TEXT DEFAULT 'active',           -- active | leave | resigned
  note            TEXT,
  created_at      TEXT
);
-- Overtime rates per staff (RM/hour). 0 = auto-derive from salary/26/8.
CREATE TABLE IF NOT EXISTS staff_ot_rates (
  staff_id    INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  normal_rate REAL DEFAULT 0,   -- 1.5x base hourly
  rest_rate   REAL DEFAULT 0,   -- 2.0x base hourly
  ph_rate     REAL DEFAULT 0,   -- 3.0x base hourly
  updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date  TEXT NOT NULL,
  in_time    TEXT, out_time TEXT,
  status     TEXT DEFAULT 'present',               -- present|late|absent|leave|rest
  ot_normal  REAL DEFAULT 0,                       -- jam lembur biasa (1.5x)
  ot_rest    REAL DEFAULT 0,                       -- jam lembur hari rehat (2.0x)
  ot_ph      REAL DEFAULT 0,                       -- jam lembur cuti am (3.0x)
  note       TEXT,
  UNIQUE(staff_id, work_date)
);

-- ===== fleet =======================================================
CREATE TABLE IF NOT EXISTS lorries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,          -- L01
  reg_no            TEXT NOT NULL,                 -- WA1234T
  make              TEXT, model TEXT, year INTEGER,
  capacity_m3       REAL NOT NULL DEFAULT 8,
  fuel_litres       REAL DEFAULT 0,
  odometer          REAL DEFAULT 0,
  status            TEXT DEFAULT 'available',      -- available|loading|on_delivery|maintenance|off
  next_service_km   REAL,
  next_service_date TEXT,
  note              TEXT,
  active            INTEGER NOT NULL DEFAULT 1
);

-- ===== customers / sites ===========================================
CREATE TABLE IF NOT EXISTS customers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT UNIQUE,
  name                TEXT NOT NULL,
  company             TEXT,
  phone               TEXT, phone2 TEXT, email TEXT,
  area                TEXT,                          -- Kota Kinabalu, Sandakan, Tawau...
  billing_address     TEXT,
  payment_terms_days  INTEGER NOT NULL DEFAULT 0,
  credit_limit        REAL NOT NULL DEFAULT 0,
  note                TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT
);
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        TEXT, address TEXT, area TEXT,
  access_note TEXT,          -- gate, road, tipping area, working hours
  lat REAL, lng REAL
);

-- ===== products ====================================================
CREATE TABLE IF NOT EXISTS mix_designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,                 -- K1 / C25
  name        TEXT,
  grade_mpa   REAL,
  slump_mm    INTEGER,
  max_agg_mm  INTEGER,
  -- bill of materials, per 1 m3
  cement_bags REAL DEFAULT 0,
  sand_m3     REAL DEFAULT 0,
  agg_m3      REAL DEFAULT 0,
  admix_l     REAL DEFAULT 0,
  price_per_m3 REAL NOT NULL DEFAULT 0,
  min_charge_m3 REAL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);

-- ===== orders ======================================================
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT NOT NULL UNIQUE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  site_id         INTEGER REFERENCES sites(id),
  order_date      TEXT NOT NULL,
  delivery_date   TEXT NOT NULL,
  delivery_slot   TEXT DEFAULT 'am',                -- am | pm | night
  mix_code        TEXT,
  volume_m3       REAL NOT NULL DEFAULT 0,
  unit_price      REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  delivery_charge REAL NOT NULL DEFAULT 0,
  sst_rate        REAL NOT NULL DEFAULT 0,
  subtotal        REAL NOT NULL DEFAULT 0,
  amount          REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft|confirmed|loading|dispatched|delivered|completed|cancelled
  po_ref          TEXT,
  requested_by    TEXT,
  note            TEXT,
  cancel_reason   TEXT,
  created_by      INTEGER,
  created_at      TEXT,
  updated_at      TEXT
);

-- ===== delivery trips (one lorry load = one trip) ==================
CREATE TABLE IF NOT EXISTS trips (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_no         TEXT NOT NULL UNIQUE,
  dn_no           TEXT UNIQUE,                      -- delivery note number
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lorry_id        INTEGER REFERENCES lorries(id),
  driver_id       INTEGER REFERENCES staff(id),
  run_no          INTEGER NOT NULL DEFAULT 1,      -- which load of the order
  batch_m3        REAL NOT NULL DEFAULT 0,         -- loaded m3
  delivered_m3    REAL DEFAULT 0,                  -- pumped at site
  returned_m3     REAL DEFAULT 0,                  -- leftover brought back
  load_time       TEXT, depart_time TEXT, arrive_time TEXT, return_time TEXT,
  slump_measured INTEGER,                          -- mm, site test
  odo_start       REAL, odo_end REAL, fuel_used_l REAL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'planned', -- planned|loading|dispatched|delivered|returned|void
  receiver_name   TEXT, receiver_sign TEXT, time_started TEXT, time_finished TEXT,
  remark          TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

-- ===== invoices / payments =========================================
CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no  TEXT NOT NULL UNIQUE,
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  issue_date  TEXT NOT NULL,
  due_date    TEXT,
  amount      REAL NOT NULL DEFAULT 0,
  sst_amount  REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid|partial|paid|cancelled
  note        TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no  TEXT NOT NULL UNIQUE,
  receipt_no  TEXT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id  INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  amount      REAL NOT NULL,
  method      TEXT NOT NULL,                       -- cash|bank|online
  method_detail TEXT,                              -- DuitNow / Maybank / cash
  ref_no      TEXT,
  paid_at     TEXT NOT NULL,
  received_by INTEGER,
  status      TEXT NOT NULL DEFAULT 'confirmed',   -- pending|confirmed|failed|void
  note        TEXT
);
CREATE TABLE IF NOT EXISTS online_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  provider   TEXT NOT NULL DEFAULT 'paylink',      -- paylink|toyyifi|skpay|mpay|stripe
  ref        TEXT NOT NULL UNIQUE,
  amount     REAL NOT NULL,
  pay_url    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',      -- pending|paid|expired|failed
  created_at TEXT, paid_at TEXT, raw TEXT
);

-- ===== suppliers / purchasing ======================================
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE, name TEXT NOT NULL, phone TEXT, email TEXT,
  area TEXT, address TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL UNIQUE, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  order_date TEXT NOT NULL, delivery_date TEXT,
  amount REAL NOT NULL DEFAULT 0, status TEXT DEFAULT 'received', -- ordered|received|cancelled
  note TEXT
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL
);

-- ===== inventory ===================================================
CREATE TABLE IF NOT EXISTS items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sku       TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL DEFAULT 'material',      -- material|fuel|part
  unit      TEXT NOT NULL DEFAULT 'pcs',           -- bag|m3|litre|pcs|kg|pail|tyre
  min_qty   REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  location  TEXT,
  note      TEXT,
  active    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  move_date  TEXT NOT NULL,
  type       TEXT NOT NULL,                        -- in|out|waste|adjust
  qty        REAL NOT NULL,                        -- always positive
  unit_cost  REAL NOT NULL DEFAULT 0,
  ref_type   TEXT,                                 -- purchase|trip|order|manual|opening
  ref_id     INTEGER,
  ref_no     TEXT,
  lorry_id   INTEGER REFERENCES lorries(id),
  note       TEXT,
  created_by INTEGER,
  created_at TEXT
);

-- ===== fuel ========================================================
CREATE TABLE IF NOT EXISTS fuel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL REFERENCES lorries(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  litres   REAL NOT NULL,
  price_per_litre REAL NOT NULL,
  total    REAL NOT NULL,
  odometer REAL, station TEXT, receipt_no TEXT,
  ref_type TEXT, ref_id INTEGER,                   -- trip_id when filled on trip
  note     TEXT, created_by INTEGER, created_at TEXT
);
`);

/* helper: drop the stray helper table from very early dev databases */
try { db.exec('DROP TABLE IF EXISTS lorries_old'); } catch {}

/* ------------------------------------------------------------------ *
 * Small query helpers
 * ------------------------------------------------------------------ */
/** node:sqlite refuses `undefined`; normalise it to SQL NULL. */
const bind = (p) => (p === undefined ? null : p);
export const all = (sql, ...p) => db.prepare(sql).all(...p.map(bind));
export const get = (sql, ...p) => db.prepare(sql).get(...p.map(bind));
export const run = (sql, ...p) => {
  const r = db.prepare(sql).run(...p.map(bind));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};
export const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

/* ------------------------------------------------------------------ *
 * Lightweight column migrations - so an older database file keeps
 * working after new fields are added to the schema above.
 * ------------------------------------------------------------------ */
function addColumn(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.length || cols.includes(column)) return;
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch {}
}
addColumn('users', 'lang', "lang TEXT DEFAULT 'bm'");
addColumn('users', 'last_login', 'last_login TEXT');
addColumn('lorries', 'note', 'note TEXT');
addColumn('trips', 'remark', 'remark TEXT');
addColumn('items', 'location', 'location TEXT');
addColumn('staff', 'annual_leave', 'annual_leave REAL DEFAULT 0');
// Lembur: kolum jam OT ditambah lewat (attendance lama tidak ada) -
// migrasi supaya DB sedia ada boleh guna payroll OT tanpa bina semula.
addColumn('attendance', 'ot_normal', 'ot_normal REAL DEFAULT 0');
addColumn('attendance', 'ot_rest', 'ot_rest REAL DEFAULT 0');
addColumn('attendance', 'ot_ph', 'ot_ph REAL DEFAULT 0');
// Baiki tetapan berkanun yang kosong/NULL (DB pra-2026): kadar & had
// SOCSO/EIS/EPF terkini dipakai walaupun tanpa edit manual di Tetapan.
for (const [k, v] of Object.entries({
  socso_ceiling: '6000', socso_employer_rate: '0.0175', socso_employee_rate: '0.005',
  eis_ceiling: '6000', eis_employer_rate: '0.002', eis_employee_rate: '0.002',
  epf_ceiling: '0',
})) {
  run(`UPDATE settings SET value = ? WHERE key = ? AND (value IS NULL OR value = '')`, v, k);
}
// Polisi data: backup hanya melalui aplikasi ini, disimpan ke server pemilik.
// Buang sebarang repositori/token GitHub lama yang pernah disimpan - ia adalah
// laluan data keluar ke pihak ketiga yang tidak lagi dibenarkan.
run(`DELETE FROM settings WHERE key LIKE 'github_%'`);

/* ------------------------------------------------------------------ *
 * Nombor pekerja (emp_no)
 *
 * Format: <TINGKAT>-<CAWANGAN><urutan>
 *
 *   1-HQ01   admin, headquarters pertama
 *   3-PPR01  penyelia cawangan Papar yang pertama
 *   4-PPR01  kerani umum Papar yang pertama
 *   6-PPR01  pemandu Papar yang pertama
 *
 * ANGKA PERTAMA ialah tahap hierarki - jadi senarai kakitangan yang
 * disusun mengikut emp_no sudah tersusun dari paling tinggi ke paling
 * rendah, dan mana-mana orang boleh baca pangkat tanpa melihat
 * pangkalan data. Bahagian selepas itu ialah cawangan, supaya nama yang
 * sama di dua cawangan tidak boleh tersalah campur.
 *
 * emp_no dicetak pada slip gaji, nota penghantaran dan ia juga menjadi
 * ID login kakitangan.
 * ------------------------------------------------------------------ */
const BRANCH_ABBR = {
  papar: 'PPR', putatan: 'PUT', tuaran: 'TUA', sikuati: 'SIK', membakut: 'MEM',
};

/* Tahap hierarki kakitangan - angka pertama emp_no.
 *
 * Disimpan dalam pangkalan data (bukan konstanta kod) supaya admin boleh
 * mengubahnya dari Tetapan -> Peranan tanpa menyentuh kod dan tanpa
 * membina semula aplikasi. Nombor kecil = pangkat lebih tinggi.
 * 'dispatcher' purposely ada di antara kerani dan pemandu. */
export const STAFF_LEVEL_DEFAULT = {
  admin: 1, lab: 2, supervisor: 3, clerk: 4, dispatcher: 5, driver: 6, mechanic: 7,
};
const STAFF_LEVELS_KEY = 'staff_levels';

/** Tahap bagi setiap peranan kakitangan, dibaca daripada pangkalan data.
 *  Jika tetapan rosak atau peranan baharu ditambah, nilai lalai digunakan. */
export function getStaffLevels() {
  const fallback = { ...STAFF_LEVEL_DEFAULT };
  try {
    const raw = setting(STAFF_LEVELS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    const out = {};
    for (const [role, lv] of Object.entries(saved)) {
      const n = Number(lv);
      // Nombor tahap mesti 1-99: ia jadi digit pertama emp_no, jadi 0 atau
      // 100+ akan pecahkan format yang dicetak pada slip gaji.
      if (Number.isInteger(n) && n >= 1 && n <= 99) out[role] = n;
    }
    return Object.keys(out).length ? { ...fallback, ...out } : fallback;
  } catch {
    return fallback; // JSON rosak - jangan biarkan aplikasi jatuh
  }
}

/** Simpan tahap kakitangan. Menolak nilai di luar 1-99 supaya emp_no
 *  yang akan dicetak sentiasa boleh dibaca. */
export function setStaffLevels(map) {
  const clean = {};
  for (const [role, lv] of Object.entries(map)) {
    const n = Number(lv);
    if (Number.isInteger(n) && n >= 1 && n <= 99) clean[role] = n;
  }
  return setSetting(STAFF_LEVELS_KEY, JSON.stringify(clean));
}

/** Singkatan cawangan yang digunakan dalam nombor pekerja, contoh PPR. */
export function branchAbbr(branch) {
  if (!branch) return 'HQ';
  const code = String(branch.code ?? branch);
  return BRANCH_ABBR[code.toLowerCase()] || code.slice(0, 3).toUpperCase();
}

/** Cadangan emp_no seterusnya bagi satu peranan + cawangan. */
export function suggestEmpNo(role = 'driver', branchId = null) {
  const prefix = branchAbbr(branchId ? getBranch(branchId) : null);
  const level = getStaffLevels()[role] ?? 8;
  const last = get(`SELECT emp_no FROM staff WHERE emp_no LIKE ? ORDER BY emp_no DESC LIMIT 1`, `${level}-${prefix}%`);
  const n = last ? Number(last.emp_no.slice(-2)) + 1 : 1;
  return `${level}-${prefix}${String(n).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Kebenan kewangan
 *
 * Peranan 'office' sahaja tidak bermaksud bolehurus kewangan. Admin
 * memberi kebenaran satu per satu melalui Tetapan → Pengguna. Admin
 * sendiri tidak perlu kebenaran ini (dia yang memberikannya).
 * ------------------------------------------------------------------ */
addColumn('users', 'can_finance', 'can_finance INTEGER NOT NULL DEFAULT 0');

/* ------------------------------------------------------------------ *
 * Branch scoping (cawangan)
 *
 * Rekod lama akan dapat branch_id NULL. NULL bermaksud "semua cawangan",
 * jadi data sedia ada kekal kelihatan. Rekod BARU mesti sentiasa membawa
 * branch_id - helper branchWrite() yang memastikan perkara itu.
 * ------------------------------------------------------------------ */
const BRANCH_TABLES = [
  'users', 'customers', 'orders', 'items', 'stock_movements', 'lorries',
  'suppliers', 'purchases', 'fuel_logs', 'mix_designs', 'staff', 'attendance',
  'trips', 'invoices', 'payments', 'online_payments', 'sites',
];
for (const t of BRANCH_TABLES) addColumn(t, 'branch_id', 'branch_id INTEGER REFERENCES branches(id)');
/* Cawangan yang sedang dipilih disimpan ikut sesi, jadi seorang pengguna
 * boleh bertukar cawangan tanpa perlu log masuk semula. */
addColumn('sessions', 'branch_id', 'branch_id INTEGER REFERENCES branches(id)');

/* ------------------------------------------------------------------ *
 * Stok adalah KHAS CAWANGAN - setiap cawangan ada barisnya sendiri bagi
 * setiap SKU, jadi `sku` tidak lagi unik global. SQLite tidak boleh
 * membuang constraint UNIQUE dengan ALTER, jadi jadual dibina semula
 * sekali sahaja. Id dikekalkan supaya rujukan stock_movements/purchase_items
 * kekal sah.
 * ------------------------------------------------------------------ */
function scopeItemSkuPerBranch() {
  const idx = all(`PRAGMA index_list(items)`).find((i) => i.unique && i.origin === 'u');
  if (!idx) return;                       // sudah unik kompaun - tiada apa nak dibuat
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE items_b (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sku        TEXT NOT NULL,
        name       TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT 'material',
        unit       TEXT NOT NULL DEFAULT 'pcs',
        min_qty    REAL NOT NULL DEFAULT 0,
        unit_cost  REAL NOT NULL DEFAULT 0,
        location   TEXT,
        note       TEXT,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        branch_id  INTEGER REFERENCES branches(id),
        UNIQUE (sku, branch_id)
      );
      INSERT INTO items_b (id, sku, name, category, unit, min_qty, unit_cost,
                           location, note, active, created_at, branch_id)
        SELECT id, sku, name, category, unit, min_qty, unit_cost,
               location, note, active, created_at, branch_id FROM items;
      DROP TABLE items;
      ALTER TABLE items_b RENAME TO items;
      COMMIT;
    `);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[kotamix] items branch migration failed:', e.message);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
scopeItemSkuPerBranch();

/* ------------------------------------------------------------------ *
 * Branch helpers
 * ------------------------------------------------------------------ */
export function listBranches({ activeOnly = false } = {}) {
  return all(`SELECT * FROM branches ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`);
}
export function getBranch(id) {
  return id ? get('SELECT * FROM branches WHERE id = ?', Number(id)) : null;
}
export function firstBranch() {
  return get('SELECT * FROM branches ORDER BY id LIMIT 1');
}
export function branchName(id) {
  return getBranch(id)?.name || 'Semua Cawangan';
}
/**
 * SQL untuk menapis ikut cawangan.
 * branchId falsy (null / 'all' / 0) => tiada penapis (admin lihat semua).
 *
 * Penapis ini TEGAS: hanya rekod yang branch_id-nya tepat sama. Rekod
 * branch_id NULL tidak dipaparkan kepada kakitangan - jika turut kelihatan,
 * setiap cawangan akan nampak rekod yang bukan miliknya.
 */
export function branchWhere(alias = '', branchId) {
  if (!branchId || branchId === 'all') return { sql: '', params: [] };
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  return { sql: ` AND ${col} = ?`, params: [Number(branchId)] };
}
/** Sama seperti branchWhere, tetapi untuk senarai WHERE yang sedang dibina. */
export function branchCond(alias = '', branchId) {
  if (!branchId || branchId === 'all') return null;
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  return { clause: `${col} = ?`, params: [Number(branchId)] };
}
/** Nilai branch_id untuk INSERT/UPDATE; null bermaksud semua cawangan. */
export function branchVal(branchId) {
  if (!branchId || branchId === 'all') return null;
  return Number(branchId);
}
/** Sama seperti branchWhere tetapi melontar alias (untuk query tanpa alias). */
export function branchScope(branchId, alias = '') {
  return branchWhere(alias, branchId);
}

/* ------------------------------------------------------------------ *
 * Settings & document numbering
 * ------------------------------------------------------------------ */
export const DEFAULT_SETTINGS = {
  company_name: 'Kotamix Concrete',
  company_reg_no: '',
  company_sst_no: '',
  company_phone: '',
  company_address: '',
  company_email: '',
  bank_name: '',
  bank_account: '',
  base_url: 'http://localhost:3000',
  sst_rate: '0',
  default_delivery_charge: '150',
  default_payment_terms: '0',
  payment_link_enabled: '1',
  invoice_prefix: 'INV',
  order_prefix: 'SO',
  dn_prefix: 'DN',
  trip_prefix: 'TRP',
  payment_prefix: 'PAY',
  receipt_prefix: 'RC',
  lorries_count: '0',
  driver_daily_allowance: '60',
  driver_trip_allowance: '25',
  loader_trip_allowance: '15',
  /* Statutory contributions (Malaysia 2025/2026 rates).
   * SOCSO/EIS wage ceiling: RM 6,000/month (raised from RM 5,000,
   * effective 1 Oct 2024). EPF: no ceiling.
   * Kadar EPF dikira automatik dalam biz.js (majikan 13% ≤ RM5,000 /
   * 12% > RM5,000; pekerja 11%) dan tidak boleh disunting di sini.
   * Dibolehkan disunting di Settings → Payroll. */
  socso_ceiling: '6000',
  socso_employer_rate: '0.0175',   // 1.75%
  socso_employee_rate: '0.005',    // 0.5%
  eis_ceiling: '6000',
  eis_employer_rate: '0.002',      // 0.2%
  eis_employee_rate: '0.002',      // 0.2%
  epf_ceiling: '0',                // 0 = no ceiling (EPF has no cap)
};

export function setting(key, fallback = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (row) return row.value;
  run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, String(fallback ?? ''));
  return String(fallback ?? '');
}
export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value ?? ''));
}
export function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

const pad = (n, len) => String(n).padStart(len, '0');
/** Generate next document number, e.g. nextNo('order', 'SO') -> SO-2026-0001 */
export function nextNo(kind, prefix, year = new Date().getFullYear()) {
  const name = `${kind}_${year}`;
  run('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)', name);
  const r = get('SELECT value FROM counters WHERE name = ?', name);
  const n = r.value + 1;
  run('UPDATE counters SET value = ? WHERE name = ?', n, name);
  return `${prefix}-${year}-${pad(n, 4)}`;
}

/* ------------------------------------------------------------------ *
 * Password + sessions
 * ------------------------------------------------------------------ */
export function hashPassword(pw, salt = randomBytes(16).toString('hex')) {
  const h = scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSession(userId, branchId = null) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
  run('INSERT INTO sessions (token, user_id, branch_id, created_at, expires_at) VALUES (?,?,?,?,?)',
    token, userId, branchVal(branchId), now.toISOString(), exp.toISOString());
  run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  return token;
}
export function userForToken(token) {
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token = ?', token);
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  if (!u) return null;
  u.lang = get('SELECT value FROM settings WHERE key = ?', `lang_${u.id}`)?.value || 'bm';
  // Cawangan aktif ikut sesi; jatuh balik kepada cawangan rumah pengguna.
  u.branch_id = s.branch_id ?? u.branch_id ?? null;
  return u;
}
/** Tukar cawangan aktif untuk sesi ini sahaja. */
export function setSessionBranch(token, branchId) {
  if (!token) return;
  run('UPDATE sessions SET branch_id = ? WHERE token = ?', branchVal(branchId), token);
}
export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

/* ------------------------------------------------------------------ *
 * Flash messages
 *
 * Mesej "Disimpan" atau ralat hilang jika ia hanya tinggal dalam memori
 * permintaan, sebab kebanyakan route selepas menyimpan redirect ke
 * halaman lain. Jadi ia disimpan pada baris sesi dan dibaca sekali
 * sahaja pada permintaan seterusnya.
 * ------------------------------------------------------------------ */
const FLASH_COL = 'flash_json';
addColumn('sessions', FLASH_COL, 'flash_json TEXT');

/** Simpan mesej untuk dipaparkan pada permintaan seterusnya. */
export function setFlash(token, list) {
  if (!token || !list?.length) return;
  run(`UPDATE sessions SET ${FLASH_COL} = ? WHERE token = ?`, JSON.stringify(list.slice(-5)), token);
}

/** Baca dan buang mesej flash. */
export function takeFlash(token) {
  if (!token) return [];
  const s = get(`SELECT ${FLASH_COL} AS f FROM sessions WHERE token = ?`, token);
  if (!s?.f) return [];
  run(`UPDATE sessions SET ${FLASH_COL} = NULL WHERE token = ?`, token);
  try { return JSON.parse(s.f); } catch { return []; }
}

/* ------------------------------------------------------------------ *
 * First-run safeguard: a fresh database has no users, which would lock
 * everybody out (e.g. on hosts with no SSH to run the seed script).
 * Create the default admin exactly once, when the users table is empty.
 * ------------------------------------------------------------------ */
try {
  const n = get('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  if (Number(n) === 0) {
    run(`INSERT INTO users (username, password_hash, name, role, active, created_at)
         VALUES (?,?,?,?,1,?)`,
      'admin', hashPassword('admin123'), 'Administrator', 'admin', new Date().toISOString());
    console.warn('[kotamix] No users found - created default admin / admin123. Change it now in Settings -> Users.');
  }
} catch (e) { console.error('[kotamix] first-run admin check failed:', e.message); }
