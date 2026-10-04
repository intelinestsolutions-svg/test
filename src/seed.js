/**
 * Demo / bootstrap data for a Sabah concrete-lorry business.
 * Safe to re-run: existing rows are left alone.
 *   node src/seed.js          -> add missing demo data
 *   node src/seed.js --force  -> wipe operational data first
 */
import {
  all, get, run, tx, nextNo, setting, setSetting, hashPassword, getStaffLevels,
} from './db.js';
import { addDays, today, monthStart } from './lib/http.js';
import {
  calcOrder, recordMovement, stockQty, addFuel, ensureInvoiceForOrder, recalcInvoice, round2,
} from './lib/biz.js';

const force = process.argv.includes('--force');

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
/* Kata laluan yang DIJANA oleh seed, disimpan supaya ringkasan login boleh
 * menunjuk tepat. Akaun yang sudah wujud tidak disentuh, jadi kata laluannya
 * tidak diketahui di sini - ia tidak boleh dicetak (hanya hash disimpan). */
const seedPasswords = new Map();
function noteSeedPassword(username, password) { seedPasswords.set(username.toLowerCase(), password); }

function upsertUser(username, password, name, role, branchId = null, canFinance = null) {
  const existing = get('SELECT * FROM users WHERE lower(username) = ?', username.toLowerCase());
  if (existing) {
    if (existing.branch_id !== branchId && branchId !== null) {
      run('UPDATE users SET branch_id = ? WHERE id = ?', branchId, existing.id);
    }
    if (canFinance !== null && existing.can_finance !== canFinance) {
      run('UPDATE users SET can_finance = ? WHERE id = ?', canFinance ? 1 : 0, existing.id);
    }
    return existing.id;
  }
  const r = run(`INSERT INTO users (username, password_hash, name, role, branch_id, can_finance, active, created_at)
                 VALUES (?,?,?,?,?,?,1,?)`,
    username.toLowerCase(), hashPassword(password), name, role, branchId,
    canFinance ? 1 : 0, new Date().toISOString());
  noteSeedPassword(username, password);
  return r.id;
}

function upsertItem({ sku, name, category, unit, min_qty = 0, unit_cost = 0, location = '', note = '', branch_id = null }) {
  const found = get('SELECT * FROM items WHERE sku = ? AND (branch_id IS ? OR branch_id = ?)', sku, branch_id, branch_id);
  if (found) return found.id;
  const r = run(`INSERT INTO items (sku, name, category, unit, min_qty, unit_cost, location, note, branch_id, active, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
    sku, name, category, unit, min_qty, unit_cost, location, note, branch_id, new Date().toISOString());
  return r.id;
}

/** Opening stock movement, only if the item has never been given stock. */
function openStock(itemId, qty, cost, note = 'Opening stock') {
  if (stockQty(itemId) !== 0) return;
  recordMovement({ itemId, type: 'in', qty, unitCost: cost, refType: 'opening', note });
}

function upsertCustomer({ code, name, company, phone, email, area, billing_address, payment_terms_days = 0, credit_limit = 0, note = '', branch_id = null }) {
  // Cari dalam cawangan yang sama sahaja - nama yang sama boleh wujud
  // di cawangan lain (pelanggan adalah KHAS CAWANGAN).
  const found = get(`SELECT * FROM customers
                     WHERE (code = ? OR name = ?) AND branch_id IS ?`, code, name, branch_id);
  if (found) return found.id;
  const r = run(`INSERT INTO customers (code, name, company, phone, email, area, billing_address,
                 payment_terms_days, credit_limit, note, branch_id, active, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    code, name, company, phone, email, area, billing_address, payment_terms_days, credit_limit, note,
    branch_id, new Date().toISOString());
  return r.id;
}
function addSite(customerId, { name, address, area, access_note = '', branch_id = null }) {
  const found = get('SELECT id FROM sites WHERE customer_id = ? AND name = ?', customerId, name);
  if (found) return found.id;
  return run('INSERT INTO sites (customer_id, name, address, area, access_note, branch_id) VALUES (?,?,?,?,?,?)',
    customerId, name, address, area, access_note, branch_id).id;
}

function upsertMix(m) {
  const found = get('SELECT * FROM mix_designs WHERE code = ?', m.code);
  if (found) return found.id;
  return run(`INSERT INTO mix_designs (code, name, grade_mpa, slump_mm, max_agg_mm, cement_bags, sand_m3,
              agg_m3, admix_l, price_per_m3, min_charge_m3, branch_id, active)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    m.code, m.name, m.grade, m.slump, m.agg, m.cement, m.sand, m.agg_m3, m.admix, m.price, m.min || 1,
    m.branch_id ?? null).id;
}

function upsertLorry(l) {
  const found = get('SELECT id FROM lorries WHERE code = ?', l.code);
  if (found) return found.id;
  return run(`INSERT INTO lorries (code, reg_no, make, model, year, capacity_m3, fuel_litres, odometer,
                status, next_service_km, next_service_date, note, branch_id, active)
              VALUES (?,?,?,?,?,?,?,?,'available',?,?,?,?,1)`,
    l.code, l.reg_no, l.make, l.model, l.year, l.cap, l.fuel, l.odo,
    l.nextKm ?? null, l.nextDate ?? null, l.note || '', l.branch_id ?? null).id;
}

function upsertStaff(s) {
  // Cari ikut emp_no SAHAJA. Kalau ikut nama jugak, cawangan lain yang
  // guna nama sama akan "tumpukan" kepada baris cawangan pertama - jadi
  // setiap pemandu di cawangan lain hilang sepenuhnya.
  const found = get('SELECT id FROM staff WHERE emp_no = ?', s.emp_no);
  if (found) return found.id;
  return run(`INSERT INTO staff (emp_no, name, role, phone, ic_no, licence_class, licence_expiry, address, salary, join_date, status, branch_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)`,
    s.emp_no, s.name, s.role, s.phone || '', s.ic || '', s.licence || '', s.licence_exp || '',
    s.address || '', s.salary, s.join || '2023-01-01', s.branch_id ?? null, new Date().toISOString()).id;
}

function upsertSupplier({ code, name, phone, area, address = '', note = '', branch_id = null }) {
  // Sentiasa ikut branch_id: pembekal adalah KHAS CAWANGAN, jadi jangan
  // cari berdasarkan nama sahaja - cawangan lain akan "tumpukan" ke baris ini.
  const found = get('SELECT id FROM suppliers WHERE code = ? AND branch_id IS ?', code, branch_id);
  if (found) return found.id;
  return run('INSERT INTO suppliers (code, name, phone, area, address, note, branch_id, active) VALUES (?,?,?,?,?,?,?,1)',
    code, name, phone, area, address, note, branch_id).id;
}

/* ------------------------------------------------------------------ *
 * seed
 * ------------------------------------------------------------------ */
console.log(force ? '\n  Resetting operational data, then seeding...\n' : '\n  Seeding demo data...\n');

/* ---------- 0. cawangan (wajib - data disimpan ikut cawangan) ---------- */
const BRANCHES = [
  { code: 'papar', name: 'Papar', address: 'Jalan Papar, 89500 Papar, Sabah' },
  { code: 'putatan', name: 'Putatan', address: 'Jalan Putatan, 88400 Putatan, Sabah' },
  { code: 'tuaran', name: 'Tuaran', address: 'Jalan Tuaran, 89200 Tuaran, Sabah' },
  { code: 'sikuati', name: 'Sikuati', address: 'Jalan Sikuati, 89200 Tuaran, Sabah' },
  { code: 'membakut', name: 'Membakut', address: 'Jalan Membakut, 89200 Kota Marudu, Sabah' },
];
const bIds = {};
for (const b of BRANCHES) {
  const found = get('SELECT id FROM branches WHERE code = ?', b.code);
  bIds[b.code] = found ? found.id : run(
    'INSERT INTO branches (code, name, address, active, created_at) VALUES (?,?,?,1,?)',
    b.code, b.name, b.address, new Date().toISOString(),
  ).id;
}
const BR = Object.keys(bIds);
const branchOf = (code) => bIds[code] ?? null;
/** Kata cawangan dalam senarai; data diagihkan ke semua cawangan. */
const BR_CODES = BR;

if (force) {
  const wipe = ['stock_movements', 'fuel_logs', 'payments', 'online_payments', 'invoices', 'trips',
    'orders', 'purchase_items', 'purchases', 'attendance', 'sites', 'customers', 'counters'];
  tx(() => { for (const t of wipe) run(`DELETE FROM ${t}`); });
}

/* ---------- 1. settings ---------- */
const SETTINGS = {
  company_name: 'Kotamix Concrete',
  company_reg_no: '202301012345 (1234567-X)',
  company_sst_no: 'W-21-1234567',
  company_phone: '088-312 000 / 012-345 6789',
  company_address: 'Lot 88, Jalan Penampang, 89500 Kota Kinabalu, Sabah',
  company_email: 'admin@kotamix.com.my',
  bank_name: 'Maybank Malaysia Berhad',
  bank_account: '558012-34-5678-90',
  sst_rate: '6',
  default_delivery_charge: '180',
  default_payment_terms: '30',
  base_url: 'http://localhost:3000',
  invoice_prefix: 'INV',
  order_prefix: 'SO',
  dn_prefix: 'DN',
  trip_prefix: 'TRP',
  payment_prefix: 'PAY',
  receipt_prefix: 'RC',
  driver_daily_allowance: '60',
  driver_trip_allowance: '30',
  loader_trip_allowance: '15',
};
for (const [k, v] of Object.entries(SETTINGS)) {
  const cur = get('SELECT value FROM settings WHERE key = ?', k);
  if (!cur || !cur.value) setSetting(k, v);
}

/* ---------- 2. users ---------- */
/* Admin tidak terikat cawangan (lihat semua). Pejabat & pemandu ada cawangan
 * rumah, dan akaun mereka dicipta selepas staff (bahagian 6) kerana username
 * mereka ialah nombor pekerja sendiri.
 *
 * actorId = "siapa yang cipta" bagi baris yang dijana seed. Seed bukan
 * tindakan seorang manusia, jadi ia dikira sebagai kerja admin - bukan
 * dipinjam kepada supervisor mana-mana cawangan, yang akan jadi tidak tepat. */
const adminId = upsertUser('admin', 'admin123', 'Pengurus Siri', 'admin', null);
const actorId = adminId;
setSetting(`lang_${adminId}`, 'bm');

/* ---------- 3. mix designs (Sabah ready-mix grades) ---------- */
const MIXES = [
  { code: 'K1', name: 'Konkrit Struktur Biasa', grade: 20, slump: 100, agg: 20, cement: 6.0, sand: 0.42, agg_m3: 0.80, admix: 1.8, price: 285 },
  { code: 'K2', name: 'Konkrit Struktur 25 MPa', grade: 25, slump: 100, agg: 20, cement: 6.8, sand: 0.40, agg_m3: 0.78, admix: 2.0, price: 310 },
  { code: 'K3', name: 'Konkrit Struktur 30 MPa', grade: 30, slump: 75, agg: 20, cement: 7.6, sand: 0.38, agg_m3: 0.76, admix: 2.3, price: 340 },
  { code: 'K4', name: 'Konkrit Prestek 40 MPa', grade: 40, slump: 60, agg: 20, cement: 8.4, sand: 0.35, agg_m3: 0.74, admix: 2.8, price: 385 },
  { code: 'K5', name: 'Konkrit Pra-cast 50 MPa', grade: 50, slump: 50, agg: 20, cement: 9.2, sand: 0.33, agg_m3: 0.72, admix: 3.2, price: 430 },
  { code: 'K0', name: 'Konkrit Kering (DAS / Non-Shrink)', grade: 15, slump: 25, agg: 10, cement: 8.0, sand: 0.30, agg_m3: 0.70, admix: 0.8, price: 480, min: 1 },
];
for (const m of MIXES) upsertMix(m);

/* ---------- 4. inventory items ---------- */
const ITEMS = [
  // materials
  { sku: 'MAT-CEM-50', name: 'Cement', category: 'material', unit: 'bag', min_qty: 400, unit_cost: 33.5, location: 'Simen A' },
  { sku: 'MAT-SAND', name: 'Sand', category: 'material', unit: 'm3', min_qty: 40, unit_cost: 42.0, location: 'Kuari Pasir' },
  { sku: 'MAT-AGG', name: 'Aggregate', category: 'material', unit: 'm3', min_qty: 40, unit_cost: 38.0, location: 'Kuari Batu' },
  { sku: 'MAT-ADMIX', name: 'Admixture', category: 'material', unit: 'litre', min_qty: 200, unit_cost: 2.8, location: 'Stor Kimia' },
  { sku: 'MAT-PCM', name: 'Polycarboxylate', category: 'material', unit: 'litre', min_qty: 100, unit_cost: 9.5, location: 'Stor Kimia' },
  { sku: 'MAT-FA', name: 'Fly Ash', category: 'material', unit: 'kg', min_qty: 500, unit_cost: 1.1, location: 'Simen A' },
  // fuel
  { sku: 'FUE-DSL', name: 'Diesel', category: 'fuel', unit: 'litre', min_qty: 800, unit_cost: 2.05, location: 'Tangki Stok' },
  { sku: 'FUE-PET', name: 'Petrol (M95)', category: 'fuel', unit: 'litre', min_qty: 40, unit_cost: 2.42, location: 'Tangki Stok' },
  // spare parts
  { sku: 'PRT-FLT-AIR', name: 'Air Filter (L01)', category: 'part', unit: 'pcs', min_qty: 2, unit_cost: 85, location: 'Rak A' },
  { sku: 'PRT-FLT-OIL', name: 'Oil Filter (L01)', category: 'part', unit: 'pcs', min_qty: 2, unit_cost: 42, location: 'Rak A' },
  { sku: 'PRT-OIL-15W40', name: 'Engine Oil 15W-40 (20L)', category: 'part', unit: 'pail', min_qty: 2, unit_cost: 175, location: 'Rak B' },
  { sku: 'PRT-BRK', name: 'Brake Pad Set', category: 'part', unit: 'pcs', min_qty: 2, unit_cost: 220, location: 'Rak A' },
  { sku: 'PRT-STR', name: 'Starter Motor', category: 'part', unit: 'pcs', min_qty: 1, unit_cost: 950, location: 'Rak C' },
  { sku: 'PRT-BELT', name: 'Fan Belt', category: 'part', unit: 'pcs', min_qty: 2, unit_cost: 65, location: 'Rak A' },
  // tyres
  { sku: 'TRY-315-80R22.5', name: 'Tyre 315/80R22.5 (Lorry)', category: 'part', unit: 'tyre', min_qty: 2, unit_cost: 1450, location: 'T Continental' },
  { sku: 'TRY-SPK-275', name: 'Spare Wheel 275/70R22.5', category: 'part', unit: 'tyre', min_qty: 1, unit_cost: 980, location: 'T Continental' },
  { sku: 'TYR-12R22.5', name: 'Tube 12R22.5', category: 'part', unit: 'pcs', min_qty: 4, unit_cost: 120, location: 'Rak D' },
];
/* Stok adalah KHAS CAWANGAN: setiap cawangan ada salinan sendiri bagi
 * setiap SKU, dengan baki awal yang berbeza. */
const itemIds = {};   // itemIds[branch][sku] = item id
for (const bcode of BR_CODES) {
  itemIds[bcode] = {};
  for (const it of ITEMS) itemIds[bcode][it.sku] = upsertItem({ ...it, branch_id: branchOf(bcode) });
}

const OPENING = {
  'MAT-CEM-50': 1200, 'MAT-SAND': 120, 'MAT-AGG': 120, 'MAT-ADMIX': 400, 'MAT-PCM': 200, 'MAT-FA': 2000,
  'FUE-DSL': 2000, 'FUE-PET': 60,
  'PRT-FLT-AIR': 4, 'PRT-FLT-OIL': 5, 'PRT-OIL-15W40': 4, 'PRT-BRK': 3, 'PRT-STR': 1, 'PRT-BELT': 4,
  'TRY-315-80R22.5': 4, 'TRY-SPK-275': 2, 'TYR-12R22.5': 6,
};
/* Baki awal berbeza mengikut cawangan supaya carta tidak rata. */
const OPENING_SCALE = { papar: 1.0, putatan: 0.8, tuaran: 0.6, sikuati: 0.45, membakut: 0.3 };
for (const [sku, qty] of Object.entries(OPENING)) {
  const it = ITEMS.find((x) => x.sku === sku);
  for (const bcode of BR_CODES) {
    const scaled = Math.max(1, Math.round(qty * (OPENING_SCALE[bcode] ?? 1)));
    openStock(itemIds[bcode][sku], scaled, it.unit_cost, 'Opening stock (demo)');
  }
}

/* ---------- 5. fleet ---------- */
/* Setiap cawangan ada lori sendiri. */
const LORRY_TEMPLATES = [
  { make: 'Hino', model: 'FM 260', year: 2019, cap: 8, fuel: 220, odo: 184300, nextKm: 190000, nextDate: addDays(today(), 24) },
  { make: 'Isuzu', model: 'FVR 34', year: 2020, cap: 8, fuel: 180, odo: 132800, nextKm: 138000, nextDate: addDays(today(), 12) },
  { make: 'Hino', model: 'FM 280', year: 2021, cap: 10, fuel: 240, odo: 96400, nextKm: 100000, nextDate: addDays(today(), 60) },
  { make: 'Hino', model: 'FM 320', year: 2022, cap: 12, fuel: 260, odo: 61200, nextKm: 70000, nextDate: addDays(today(), 95) },
  { make: 'Mitsubishi', model: 'Fuso FM 517', year: 2018, cap: 8, fuel: 90, odo: 241500, nextKm: 243000, nextDate: addDays(today(), -6), note: 'Overdue service' },
];
const PLATES = ['WA', 'WB', 'WC', 'WD', 'WE', 'WF', 'WG', 'WH', 'WJ', 'WK', 'WL', 'WM', 'WN', 'WP', 'WQ'];
const LORRIES = [];
let plateN = 0;
for (const bcode of BR_CODES) {
  // Cawangan besar (Papar) ada lebih banyak lori.
  const count = { papar: 4, putatan: 3, tuaran: 2, sikuati: 1, membakut: 1 }[bcode] ?? 1;
  for (let i = 0; i < count; i++) {
    const t = LORRY_TEMPLATES[i % LORRY_TEMPLATES.length];
    const seq = plateN++;
    LORRIES.push({
      code: `${bcode.slice(0, 2).toUpperCase()}${String(i + 1).padStart(2, '0')}`,
      reg_no: `${PLATES[seq % PLATES.length]}${1000 + seq * 1111}${['T', 'U', 'V', 'W', 'X'][seq % 5]}`,
      make: t.make, model: t.model, year: t.year, cap: t.cap, fuel: t.fuel,
      odo: t.odo, nextKm: t.nextKm, nextDate: t.nextDate, note: t.note || '',
      branch_id: branchOf(bcode),
    });
  }
}
const lorryIds = LORRIES.map(upsertLorry);

/* ---------- 6. staff ---------- */
/* Kakitangan diagihkan ke cawangan mengikut peranan:
 * semua cawangan ada pemandu + dispatcher; workshop/lab hanya di headquarters. */
const STAFF_BASE = [
  { role: 'driver', name: 'Awang bin Sulong', phone: '013-880 1122', lic: 'DA', lic_exp: '2027-04-30', salary: 2200, join: '2021-03-01' },
  { role: 'driver', name: 'Bilik bin Gading', phone: '014-220 3344', lic: 'DA', lic_exp: '2026-11-30', salary: 2200, join: '2021-07-15' },
  { role: 'driver', name: 'Christopher Rosing', phone: '016-775 6699', lic: 'DA', lic_exp: '2028-02-28', salary: 2400, join: '2022-01-10' },
  { role: 'driver', name: 'Junaidi bin Rahim', phone: '017-331 0088', lic: 'D', lic_exp: '2026-08-15', salary: 2000, join: '2023-05-02' },
  { role: 'driver', name: 'Rusli bin Osman', phone: '013-992 3344', lic: 'DA', lic_exp: '2027-09-12', salary: 2100, join: '2022-02-14' },
  { role: 'driver', name: 'Freddy anak Gumpit', phone: '016-338 7712', lic: 'D', lic_exp: '2027-01-20', salary: 2050, join: '2023-08-07' },
  { role: 'driver', name: 'Zulkifli bin Hamid', phone: '019-224 5566', lic: 'DA', lic_exp: '2026-12-05', salary: 2150, join: '2022-10-03' },
  { role: 'driver', name: 'Jackson Rimin', phone: '011-556 2299', lic: 'DA', lic_exp: '2028-05-30', salary: 2250, join: '2021-12-20' },
  { role: 'dispatcher', name: 'Siti Hajar', phone: '011-2233 4455', salary: 2400, join: '2021-11-01' },
  { role: 'dispatcher', name: 'Nurul Azizah', phone: '013-887 1122', salary: 2350, join: '2022-06-13' },
];

/* ==========================================================================
 * Supervisor & general clerk - satu pasang bagi SETIAP cawangan.
 *
 * Supervisor    : memegang akaun login pejabat dan diberi kebenaran
 *                 kewangan - dia pengesyor cawangan.
 * General clerk : menguruskan invois, pesanan & dokumen harian; TIDAK diberi
 *                 kebenaran kewangan sehingga admin memberikannya.
 *
 * Nama diberi akhiran cawangan supaya setiap orang unik dalam sistem.
 * ======================================================================== */
const SUPERVISORS = [
  { role: 'supervisor', name: 'Hj. Ramli bin Zainal', phone: '013-880 1001', salary: 3200, join: '2019-06-03' },
  { role: 'supervisor', name: 'Pn. Salmah binti Osman', phone: '013-880 1002', salary: 3150, join: '2020-02-17' },
  { role: 'supervisor', name: 'Hj. Yusof bin Ahdan', phone: '013-880 1003', salary: 3100, join: '2020-09-14' },
  { role: 'supervisor', name: 'Pn. Rosnah binti Ismail', phone: '013-880 1004', salary: 3050, join: '2021-01-25' },
  { role: 'supervisor', name: 'En. Dominic anak Gading', phone: '013-880 1005', salary: 3000, join: '2021-08-09' },
];
const CLERKS = [
  { role: 'clerk', name: 'Norhayati binti Matin', phone: '013-880 2001', salary: 2300, join: '2022-01-10' },
  { role: 'clerk', name: 'Fauziah binti Abdullah', phone: '013-880 2002', salary: 2250, join: '2022-05-16' },
  { role: 'clerk', name: 'Rohaida binti Suhaimi', phone: '013-880 2003', salary: 2250, join: '2022-10-03' },
  { role: 'clerk', name: 'Shahrina binti Hamid', phone: '013-880 2004', salary: 2200, join: '2023-03-06' },
  { role: 'clerk', name: 'Wong Vui Choon', phone: '013-880 2005', salary: 2200, join: '2023-07-24' },
];
/* Kakitangan shared (headquarters) - tidak terikat satu cawangan. */
const STAFF_SHARED = [
  { role: 'mechanic', name: 'Kumar Muthu', phone: '019-556 2211', salary: 2600, join: '2020-09-01' },
  { role: 'lab', name: 'Nurul Izzati', phone: '012-887 4455', salary: 2800, join: '2023-02-14' },
];

const STAFF = [];
/* Nombor pekerja: <TINGKAT>-<CAWANGAN><urutan>
 *
 *   1-HQ01   admin, headquarters pertama
 *   2-HQ01   jurutera / teknikal
 *   3-PPR01  penyelia cawangan Papar
 *   4-PPR01  kerani umum Papar
 *   6-PPR01  pemandu Papar
 *
 * Angka pertama ialah tahap hierarki (lihat STAFF_LEVEL dalam db.js),
 * jadi susunan mengikut nombor sudah tersusun dari atas ke bawah. */
const BR_ABBR = { papar: 'PPR', putatan: 'PUT', tuaran: 'TUA', sikuati: 'SIK', membakut: 'MEM' };
const seqByLevelBranch = new Map();
function empNo(role, bcode = null) {
  const level = getStaffLevels()[role] ?? 8;
  const prefix = bcode ? (BR_ABBR[bcode] || bcode.slice(0, 3).toUpperCase()) : 'HQ';
  const key = `${level}-${prefix}`;
  const n = (seqByLevelBranch.get(key) || 0) + 1;
  seqByLevelBranch.set(key, n);
  return `${key}${String(n).padStart(2, '0')}`;
}
for (const bcode of BR_CODES) {
  // Pemandu: setiap cawangan perlukan 2 atau lebih (seorang lagi sebagai
  // backup). Cawangan utama (Papar) mendapat 3.
  const perBranch = bcode === 'papar' ? 3 : 2;
  let added = 0;
  for (const s of STAFF_BASE) {
    if (added >= perBranch) break;
    if (s.role === 'driver') {
      // Nama diberi akhiran cawangan supaya setiap pemandu unik - nama yang
      // sama di cawangan lain akan kelihatan seperti satu orang sahaja.
      STAFF.push({ ...s, emp_no: empNo(s.role, bcode), name: `${s.name} (${bcode})`, branch_id: branchOf(bcode) });
      added++;
    }
  }
  // Setiap cawangan mesti ada dispatcher sendiri.
  const disp = STAFF_BASE.find((x) => x.role === 'dispatcher');
  if (!STAFF.some((s) => s.role === 'dispatcher' && s.branch_id === branchOf(bcode))) {
    STAFF.push({ ...disp, emp_no: empNo('dispatcher', bcode), name: `${disp.name} (${bcode})`, branch_id: branchOf(bcode) });
  }

  // Supervisor + general clerk: satu bagi setiap cawangan. Indeks ikut
  // senarai cawangan supaya setiap orang dapat nama & nombor yang betul.
  const bi = BR_CODES.indexOf(bcode);
  const sup = SUPERVISORS[bi];
  const clk = CLERKS[bi];
  STAFF.push({ ...sup, emp_no: empNo('supervisor', bcode), name: `${sup.name} (${bcode})`, branch_id: branchOf(bcode) });
  STAFF.push({ ...clk, emp_no: empNo('clerk', bcode), name: `${clk.name} (${bcode})`, branch_id: branchOf(bcode) });
}
for (const s of STAFF_SHARED) STAFF.push({ ...s, emp_no: empNo(s.role), branch_id: null });

const staffIds = {};
for (const s of STAFF) staffIds[s.emp_no] = upsertStaff(s);

/* Akaun login kakitangan cawangan.
 *
 * USERNAME ialah NOMBOR PEKERJA itu sendiri - 6-PPR01, 3-PPR01, dan
 * seterusnya. Ini deliberate: nombor yang sama tercetak pada slip gaji,
 * nota penghantaran dan papan tanda, jadi tiada perlu hafal username lain.
 * Kata laluan data contoh ialah nombor yang sama huruf kecil (ppr-d01);
 * admin menetapkan kata laluan sebenar.
 *
 * Setiap akaun mesti terikat kepada baris staff NYATA. Kalau ada yang hilang,
 * seed gagal dengan jelas - bukan senyap berkongsi staff_id dengan orang lain,
 * yang akan menyebabkan satu pemandu nampak melihat semua trip pemandu lain. */
const loginFor = (s) => [s.emp_no, s.emp_no.toLowerCase()];

const drivers = STAFF.filter((s) => s.role === 'driver');
BR_CODES.forEach((bcode) => {
  const d = drivers.find((x) => x.branch_id === branchOf(bcode));
  if (!d) throw new Error(`Seed: tiada pemandu bagi cawangan ${bcode}`);
  const sid = staffIds[d.emp_no];
  if (!sid) throw new Error(`Seed: staff ${d.emp_no} tidak dijumpai dalam pangkalan data`);
  const u = upsertUser(...loginFor(d), d.name, 'driver', branchOf(bcode), 0);
  run('UPDATE users SET staff_id = ? WHERE id = ?', sid, u);
});

// Teknikal / jurutera - satu-satunya peranan di luar admin yang boleh
// mengurus reka bentuk konkrit. Headquarters (tanpa cawangan) kerana
// reka bentuk adalah standard syarikat.
const labStaff = STAFF.find((s) => s.role === 'lab');
const labCreds = labStaff ? loginFor(labStaff) : ['lab', 'lab123'];
const labUser = upsertUser(...labCreds, labStaff ? labStaff.name : 'Nurul Izzati', 'lab', null, 0);
if (labStaff) run('UPDATE users SET staff_id = ? WHERE id = ?', staffIds[labStaff.emp_no], labUser);

/* Supervisor & general clerk bagi setiap cawangan.
 *
 *   papar   -> 3-PPR01 (penyelia)  4-PPR01 (kerani)
 *   putatan -> 3-PUT01             4-PUT01   dan seterusnya
 *
 * Supervisor DIBERI kebenaran kewangan (dia mengesahkan bayaran), clerk TIDAK -
 * admin perlu memberikannya secara manual dari Tetapan -> Pengguna. */
const sups = STAFF.filter((s) => s.role === 'supervisor');
const clks = STAFF.filter((s) => s.role === 'clerk');
BR_CODES.forEach((bcode) => {
  const bid = branchOf(bcode);
  const sup = sups.find((x) => x.branch_id === bid);
  const clk = clks.find((x) => x.branch_id === bid);
  if (!sup || !clk) throw new Error(`Seed: supervisor/clerk tiada bagi cawangan ${bcode}`);
  const su = upsertUser(...loginFor(sup), sup.name, 'office', bid, 1);
  const cu = upsertUser(...loginFor(clk), clk.name, 'office', bid, 0);
  run('UPDATE users SET staff_id = ? WHERE id = ?', staffIds[sup.emp_no], su);
  run('UPDATE users SET staff_id = ? WHERE id = ?', staffIds[clk.emp_no], cu);
});

/* ---------- 7. customers + sites ---------- */
const CUSTOMERS = [
  {
    code: 'C001', name: 'Sabah Construction Sdn Bhd', company: 'Sabah Construction Sdn Bhd',
    phone: '088-311 220', email: 'procurement@sabahconstruction.my', area: 'Kota Kinabalu',
    billing_address: 'Lot 12, Jalan Tuaran, 89500 Kota Kinabalu', terms: 30, credit: 80000,
    note: 'Main contractor. Requires 30-day terms.',
    sites: [
      { name: 'Tukang Tapak Inanam', address: 'Jalan Kinarut, Inanam, 88400 Kota Kinabalu', area: 'Kota Kinabalu', access_note: 'Gate 3; tipping area behind site office. Working hours 7am-6pm.' },
      { name: 'Projek Apartmen Suria', address: 'Jalan Penampang, 89500 Kota Kinabalu', area: 'Penampang', access_note: 'Narrow road - no reversing. Pump truck only.' },
    ],
  },
  {
    code: 'C002', name: 'Borneo Infra Works', company: 'Borneo Infra Works Sdn Bhd',
    phone: '089-221 908', email: 'admin@borneoinfra.my', area: 'Sandakan',
    billing_address: 'Jalan Tiga, 90000 Sandakan', terms: 45, credit: 120000,
    sites: [{ name: 'Benteng Jalan Sibuga', address: 'Jalan Sibuga, 90000 Sandakan', area: 'Sandakan', access_note: 'Soft shoulder - use low gear.' }],
  },
  {
    code: 'C003', name: 'Tawau Concrete Depot', company: 'Tawau Concrete Depot Sdn Bhd',
    phone: '089-622 145', email: '', area: 'Tawau', billing_address: 'Jalan Tungku, 91000 Tawau',
    terms: 0, credit: 0, note: 'Cash / on-delivery only.',
    sites: [{ name: 'Kuari Batu Tawau', address: 'Jalan Airport, 91000 Tawau', area: 'Tawau', access_note: 'Batching plant yard - 24h operation.' }],
  },
  {
    code: 'C004', name: 'Hock Soon Building', company: 'Hock Soon Building & Development',
    phone: '085-221 660', email: 'hsb@hockssoon.my', area: 'Sibu', billing_address: 'Jalan Market, 96000 Sibu',
    terms: 30, credit: 40000,
    sites: [{ name: 'Taman Astaka Miri', address: 'Jalan Bundalan, 98000 Miri', area: 'Miri', access_note: 'Boom gate at main entrance. Call 2 hours ahead.' }],
  },
  {
    code: 'C005', name: 'Jaya Maju Konkrit', company: 'Jaya Maju Konkrit Sdn Bhd',
    phone: '087-333 700', email: 'order@jayamaju.kena', area: 'Keningau', billing_address: 'Jalan Pullai, 85000 Keningau',
    terms: 14, credit: 25000,
    sites: [{ name: 'Taman Kasih Indah', address: 'Jalan Kasih, 85000 Keningau', area: 'Keningau', access_note: '' }],
  },
  {
    code: 'C006', name: 'Sabah Polytechnic', company: 'Jabatan Politeknik Sabah',
    phone: '088-218 200', email: 'admin@polysabah.edu.my', area: 'Kota Kinabalu',
    billing_address: 'Jalan Sinkat, 88400 Kota Kinabalu', terms: 30, credit: 30000, note: 'Government - PO required before delivery.',
    sites: [{ name: 'Politeknik Campus', address: 'Jalan Sinkat, 88400 Kota Kinabalu', area: 'Kota Kinabalu', access_note: 'Deliveries before 10am only.' }],
  },
  {
    code: 'C007', name: 'Kota Belud Jalan', company: 'Majlis Daerah Kota Belud',
    phone: '088-977 213', email: '', area: 'Kota Belud', billing_address: 'Pejabat Majlis, 89000 Kota Belud',
    terms: 60, credit: 60000,
    sites: [{ name: 'Projek Jalan Kampung', address: 'Kampung serviced, 89000 Kota Belud', area: 'Kota Belud', access_note: 'Remote - confirm 3 days ahead.' }],
  },
  {
    code: 'C008', name: 'Pan Borneo Holdings', company: 'Pan Borneo Holdings Sdn Bhd',
    phone: '082-331 999', email: 'purchasing@panborneo.my', area: 'Bintulu', billing_address: 'Jalan Tanjung Kidur, 97000 Bintulu',
    terms: 30, credit: 150000, note: 'Largest customer - volume discount negotiated.',
    sites: [
      { name: 'Bintulu Smart City', address: 'KM 12 Jalan Bintulu, 97000 Bintulu', area: 'Bintulu', access_note: 'Gate 1. Site lab will do slump test.' },
      { name: 'Bintulu Port Berth', address: 'Jalan Quay, 97000 Bintulu', area: 'Bintulu', access_note: 'Security clearance needed at gate 3.' },
    ],
  },
];
/* Pelanggan adalah KHAS CAWANGAN. Setiap cawangan_registerai pelanggan
 * sendiri; kod diberi akhiran branch supaya kekal unik. */
const custIds = {};   // custIds[branch][code] = id
const B_SUFFIX = { papar: '', putatan: 'P', tuaran: 'T', sikuati: 'S', membakut: 'M' };
// Pelanggan diagihkan: setiap cawangan ada subset berbeza.
const CUST_PER_BRANCH = {
  papar: ['C001', 'C006', 'C007', 'C008', 'C002'],
  putatan: ['C001', 'C006', 'C004', 'C005'],
  tuaran: ['C002', 'C003', 'C007', 'C008'],
  sikuati: ['C005', 'C007', 'C003'],
  membakut: ['C002', 'C003', 'C007'],
};
for (const bcode of BR_CODES) {
  custIds[bcode] = {};
  for (const code of CUST_PER_BRANCH[bcode] || []) {
    const c = CUSTOMERS.find((x) => x.code === code);
    if (!c) continue;
    // Kod unik global: C001, C001P, C001T ...
    const uniqCode = code + (B_SUFFIX[bcode] || '');
    custIds[bcode][code] = upsertCustomer({
      ...c, code: uniqCode, branch_id: branchOf(bcode),
      name: c.name, company: c.company,
    });
    for (const s of c.sites) addSite(custIds[bcode][code], { ...s, branch_id: branchOf(bcode) });
  }
}

/* ---------- 8. suppliers ---------- */
const SUPPLIERS = [
  { code: 'S001', name: 'Semen Sabah Sdn Bhd', phone: '088-327 100', area: 'Kota Kinabalu', address: 'Kawasan Perindustrian Mile 10' },
  { code: 'S002', name: 'Borneo Aggregates Sdn Bhd', phone: '089-218 700', area: 'Sandakan', address: 'Jalan Pobunturan, Mile 5' },
  { code: 'S003', name: 'Petronas Diesel Sabah', phone: '1300-22-0000', area: 'Kota Kinabalu', address: 'Stesen Bekalan Petra' },
  { code: 'S004', name: 'Kota Kinabalu Truck Parts', phone: '088-211 500', area: 'Kota Kinabalu', address: 'Jalan Penampang, Mile 4' },
  { code: 'S005', name: 'Sabah Tyre Centre', phone: '088-312 090', area: 'Kota Kinabalu', address: 'Asia City, Kota Kinabalu' },
  { code: 'S006', name: 'KK Chemical Supply', phone: '088-265 330', area: 'Kota Kinabalu', address: 'Jalan Sulaman, Kota Kinabalu' },
];
const supIds = {};
for (const s of SUPPLIERS) supIds[s.code] = upsertSupplier({ ...s, branch_id: null });

/* ---------- 9. historical orders / trips / invoices ---------- */
const hasOrders = num(get('SELECT COUNT(*) AS n FROM orders').n) > 0;
if (!hasOrders) {
  const todayIso = today();
  const priceOf = (code) => num(get('SELECT price_per_m3 FROM mix_designs WHERE code = ?', code)?.price_per_m3, 300);

  function makeOrder({ cust, site, mix, volume, dateOffset, status, discount = 0, po_ref = '', branchId = null }) {
    const oDate = addDays(todayIso, dateOffset - 2);
    const dDate = addDays(todayIso, dateOffset);
    const mixRow = get('SELECT * FROM mix_designs WHERE code = ?', mix);
    const m = calcOrder({
      volume_m3: volume, unit_price: priceOf(mix), discount,
      delivery_charge: Number(setting('default_delivery_charge', '180')), sst_rate: Number(setting('sst_rate', '6')),
    });
    const r = run(`INSERT INTO orders (order_no, customer_id, site_id, order_date, delivery_date, delivery_slot,
                    mix_code, volume_m3, unit_price, discount, delivery_charge, sst_rate, subtotal, amount,
                    status, po_ref, branch_id, created_by, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      nextNo('order', setting('order_prefix', 'SO')), cust, site, oDate, dDate, 'am', mix,
      m.volume_m3, m.unit_price, m.discount, m.delivery_charge, m.sst_rate, m.subtotal, m.amount,
      'confirmed', po_ref, branchId, actorId, new Date().toISOString(), new Date().toISOString());
    return get('SELECT * FROM orders WHERE id = ?', r.id);
  }

  const mkTrip = (order, { runNo, lorry, driver, batch, status, delivered, returned = 0, dayOffset = 0, receiver = 'Site Foreman' }) => {
    const base = `${addDays(order.delivery_date, dayOffset)}`;
    const ts = (h, m) => `${base}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const t = status === 'planned' ? {} : status === 'loading' ? { load_time: ts(7, 0) } :
      status === 'dispatched' ? { load_time: ts(7, 0), depart_time: ts(8, 0), odo_start: 1000 } :
      status === 'delivered' ? { load_time: ts(7, 0), depart_time: ts(8, 0), odo_start: 1000, arrive_time: ts(10, 30), time_started: ts(10, 45), delivered_m3: delivered, receiver_name: receiver, slump_measured: 90 } :
        { load_time: ts(7, 0), depart_time: ts(8, 0), odo_start: 1000, arrive_time: ts(10, 30), time_started: ts(10, 45), time_finished: ts(12, 0), delivered_m3: delivered, returned_m3: returned, odo_end: 1080, return_time: ts(14, 0), receiver_name: receiver, slump_measured: 90 };
    const r = run(`INSERT INTO trips (trip_no, dn_no, order_id, lorry_id, driver_id, run_no, batch_m3, delivered_m3,
                    returned_m3, load_time, depart_time, arrive_time, return_time, odo_start, odo_end,
                    fuel_used_l, status, receiver_name, time_started, time_finished, branch_id, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      nextNo('trip', setting('trip_prefix', 'TRP')), nextNo('dn', setting('dn_prefix', 'DN')),
      order.id, lorry, driver, runNo, batch, delivered || 0, returned, t.load_time, t.depart_time, t.arrive_time,
      t.return_time, t.odo_start, t.odo_end, 18, status, t.receiver_name, t.time_started, t.time_finished,
      order.branch_id, new Date().toISOString(), new Date().toISOString());
    return get('SELECT * FROM trips WHERE id = ?', r.id);
  };

  /* consume materials for delivered trips so stock looks realistic */
  function consume(tripId) {
    const tr = get('SELECT * FROM trips WHERE id = ?', tripId);
    const o = get('SELECT * FROM orders WHERE id = ?', tr.order_id);
    const mix = get('SELECT * FROM mix_designs WHERE code = ?', o.mix_code);
    if (!mix) return;
    const m3 = Number(tr.batch_m3);
    const comps = [
      ['Cement', 'bag', Number(mix.cement_bags) * m3],
      ['Sand', 'm3', Number(mix.sand_m3) * m3],
      ['Aggregate', 'm3', Number(mix.agg_m3) * m3],
      ['Admixture', 'litre', Number(mix.admix_l) * m3],
    ].filter((c) => c[2] > 0);
    // Stok ditolak daripada cawangan yang melakukan trip sahaja.
    for (const [name, unit, q] of comps) {
      const item = get(`SELECT * FROM items WHERE name = ? AND category = 'material' AND (branch_id IS ? OR branch_id = ?)`,
        name, o.branch_id, o.branch_id);
      if (!item) continue;
      run(`INSERT INTO stock_movements (item_id, move_date, type, qty, unit_cost, ref_type, ref_id, ref_no,
                lorry_id, note, branch_id, created_by, created_at)
            VALUES (?,?,?,?,?,'trip',?,?,?,?,?,?,?)`,
        item.id, (tr.load_time || `${tr.created_at}`).slice(0, 10), 'out', Math.round(q * 1000) / 1000,
        item.unit_cost, tripId, tr.trip_no, tr.lorry_id, `${o.order_no} ${o.mix_code}`,
        o.branch_id, actorId, new Date().toISOString());
    }
  }

  const siteOf = (bcode, custCode, idx = 0) => {
    const cid = custIds[bcode]?.[custCode];
    if (!cid) return null;
    const rows = all('SELECT id FROM sites WHERE customer_id = ? ORDER BY id', cid);
    return rows[idx]?.id || null;
  };

  /* --- past orders, fully delivered + invoiced --- */
  const past = [
    { cust: 'C001', mix: 'K3', volume: 24, dateOffset: -24, po: 'SC/2026/014' },
    { cust: 'C008', mix: 'K4', volume: 30, dateOffset: -20, po: 'PBH-8821' },
    { cust: 'C006', mix: 'K2', volume: 12, dateOffset: -16, po: 'JPS/SB/2026/091' },
    { cust: 'C002', mix: 'K3', volume: 20, dateOffset: -12, po: 'BIW-2201' },
    { cust: 'C004', mix: 'K2', volume: 16, dateOffset: -9, po: 'HSB-551' },
    { cust: 'C008', mix: 'K5', volume: 18, dateOffset: -6, po: 'PBH-8900' },
    { cust: 'C001', mix: 'K2', volume: 28, dateOffset: -3, po: 'SC/2026/022' },
  ];
  /* Pesanan sejarah diagihkan ke semua cawangan; setiap pesanan hanya
 * menggunakan lori, pemandu dan tapak milik cawagan tersebut. */
  const pastPlan = [
    { b: 'papar', cust: 'C001', mix: 'K3', volume: 24, dateOffset: -24, po: 'SC/2026/014' },
    { b: 'papar', cust: 'C008', mix: 'K4', volume: 30, dateOffset: -20, po: 'PBH-8821' },
    { b: 'putatan', cust: 'C006', mix: 'K2', volume: 12, dateOffset: -16, po: 'JPS/SB/2026/091' },
    { b: 'tuaran', cust: 'C002', mix: 'K3', volume: 20, dateOffset: -12, po: 'BIW-2201' },
    { b: 'sikuati', cust: 'C005', mix: 'K2', volume: 16, dateOffset: -9, po: 'HSB-551' },
    { b: 'membakut', cust: 'C003', mix: 'K5', volume: 18, dateOffset: -6, po: 'PBH-8900' },
    { b: 'papar', cust: 'C001', mix: 'K2', volume: 28, dateOffset: -3, po: 'SC/2026/022' },
    { b: 'putatan', cust: 'C004', mix: 'K3', volume: 14, dateOffset: -18, po: 'HSB-556' },
    { b: 'tuaran', cust: 'C008', mix: 'K4', volume: 22, dateOffset: -14, po: 'PBH-8877' },
    { b: 'sikuati', cust: 'C007', mix: 'K1', volume: 10, dateOffset: -10, po: 'MDKB/2026/44' },
    { b: 'membakut', cust: 'C002', mix: 'K2', volume: 8, dateOffset: -5, po: 'BIW-2233' },
    { b: 'papar', cust: 'C007', mix: 'K1', volume: 12, dateOffset: -7, po: 'MDKB/2026/51' },
  ];
  // Kumpulan lori & pemandu mengikut cawangan.
  const lorriesByBranch = {};
  const driversByBranch = {};
  for (const bcode of BR_CODES) {
    lorriesByBranch[bcode] = all('SELECT id FROM lorries WHERE branch_id = ? ORDER BY id', branchOf(bcode)).map((r) => r.id);
    driversByBranch[bcode] = all("SELECT id FROM staff WHERE branch_id = ? AND role = 'driver' ORDER BY id", branchOf(bcode)).map((r) => r.id);
  }
  const stationOf = { papar: 'Shell Jalan Penampang', putatan: 'Petronas Putatan', tuaran: 'Shell Tuaran', sikuati: 'Petronas Sikuati', membakut: 'Shell Membakut' };

  for (const p of pastPlan) {
    const site = siteOf(p.b, p.cust);
    const cid = custIds[p.b]?.[p.cust];
    if (!cid) continue;
    const o = makeOrder({
      ...p, cust: cid, site, status: 'completed', branchId: branchOf(p.b),
    });
    const cap = 8;
    const runs = Math.ceil(p.volume / cap);
    let remaining = p.volume;
    const fl = lorriesByBranch[p.b] || [];
    const fd = driversByBranch[p.b] || [];
    for (let r = 1; r <= runs; r++) {
      const batch = Math.min(cap, remaining);
      remaining -= batch;
      const delivered = batch === cap && r === runs ? batch - 0.3 : batch;
      const t = mkTrip(o, {
        runNo: r, lorry: fl.length ? fl[(r - 1) % fl.length] : lorryIds[0],
        driver: fd.length ? fd[(r - 1) % fd.length] : null,
        batch, status: 'returned', delivered: round2(delivered), returned: round2(batch - delivered),
        dayOffset: r > 2 ? 1 : 0,
      });
      consume(t.id);
      addFuel({ lorryId: t.lorry_id, litres: 22, pricePerLitre: 2.05, odometer: 1000 + r * 90, station: stationOf[p.b] || 'Shell', refType: 'trip', refId: t.id, userId: actorId, date: (t.load_time || '').slice(0, 10) || o.delivery_date });
    }
    run(`UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?`, new Date().toISOString(), o.id);
    ensureInvoiceForOrder(o.id);
  }

  /* --- payments against some of those invoices --- */
  const payPlan = [
    { idx: 0, method: 'bank', detail: 'Maybank', ref: 'RCD-99812' },
    { idx: 1, method: 'bank', detail: 'DuitNow', ref: 'DN-4471' },
    { idx: 2, method: 'online', detail: 'PayLink', ref: 'PL-7781' },
    { idx: 3, method: 'cash', detail: 'Cawangan KK', ref: '' },
  ];
  const invs = all(`SELECT * FROM invoices ORDER BY id`);
  for (const p of payPlan) {
    const inv = invs[p.idx];
    if (!inv) continue;
    const amt = p.idx === 3 ? round2(Number(inv.amount) * 0.5) : Number(inv.amount);
    const r = run(`INSERT INTO payments (payment_no, receipt_no, customer_id, invoice_id, amount, method,
                    method_detail, ref_no, paid_at, received_by, status, note, branch_id)
                  VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed','',?)`,
      nextNo('payment', setting('payment_prefix', 'PAY')), nextNo('receipt', setting('receipt_prefix', 'RC')),
      inv.customer_id, inv.id, amt, p.method, p.detail, p.ref,
      `${addDays(inv.issue_date, 2)}T10:00:00`, actorId, inv.branch_id ?? null);
    if (p.method === 'online') {
      run(`INSERT INTO online_payments (invoice_id, customer_id, provider, ref, amount, pay_url, status, created_at, paid_at, branch_id)
            VALUES (?,?, 'paylink', ?, ?, ?, 'paid', ?, ?, ?)`,
        inv.id, inv.customer_id, `PL${String(r.id).padStart(6, '0')}`, amt,
        `${setting('base_url')}/pay/PL${String(r.id).padStart(6, '0')}`,
        `${addDays(inv.issue_date, 2)}T09:58:00`, `${addDays(inv.issue_date, 2)}T10:00:00`,
        inv.branch_id ?? null);
    }
    recalcInvoice(inv.id);
  }

  /* --- today & tomorrow: live board --- */
  const todayOrders = [
    { b: 'papar', cust: 'C008', mix: 'K4', volume: 16, dateOffset: 0, po: 'PBH-8955', discount: 200 },
    { b: 'putatan', cust: 'C005', mix: 'K2', volume: 8, dateOffset: 0, po: 'JMK-118' },
    { b: 'tuaran', cust: 'C003', mix: 'K1', volume: 8, dateOffset: 0, po: 'TCD-334' },
    { b: 'sikuati', cust: 'C007', mix: 'K1', volume: 6, dateOffset: 0, po: 'MDKB/2026/60' },
    { b: 'membakut', cust: 'C002', mix: 'K2', volume: 8, dateOffset: 0, po: 'BIW-2244' },
  ];
  for (const t of todayOrders) {
    const cid = custIds[t.b]?.[t.cust];
    if (!cid) continue;
    const o = makeOrder({ ...t, cust: cid, site: siteOf(t.b, t.cust), status: 'confirmed', branchId: branchOf(t.b) });
    const runs = Math.ceil(t.volume / 8);
    const fl = lorriesByBranch[t.b] || [];
    const fd = driversByBranch[t.b] || [];
    for (let r = 1; r <= runs; r++) {
      const status = r === 1 ? 'dispatched' : 'planned';
      mkTrip(o, {
        runNo: r, lorry: fl.length ? fl[(r - 1) % fl.length] : lorryIds[0],
        driver: fd.length ? fd[(r - 1) % fd.length] : null,
        batch: Math.min(8, t.volume - (r - 1) * 8), status, delivered: 0,
      });
    }
    run(`UPDATE orders SET status = 'dispatched', updated_at = ? WHERE id = ?`, new Date().toISOString(), o.id);
  }

  const tomorrow = [
    { b: 'papar', cust: 'C001', mix: 'K3', volume: 24, dateOffset: 1, po: 'SC/2026/031' },
    { b: 'tuaran', cust: 'C002', mix: 'K2', volume: 12, dateOffset: 1, po: 'BIW-2260' },
    { b: 'sikuati', cust: 'C007', mix: 'K1', volume: 8, dateOffset: 1, po: 'MDKB/JAL/2026/7' },
    { b: 'membakut', cust: 'C003', mix: 'K3', volume: 10, dateOffset: 1, po: 'TCD-341' },
    { b: 'putatan', cust: 'C006', mix: 'K2', volume: 8, dateOffset: 1, po: 'JPS/SB/2026/110' },
  ];
  for (const t of tomorrow) {
    const cid = custIds[t.b]?.[t.cust];
    if (!cid) continue;
    const o = makeOrder({ ...t, cust: cid, site: siteOf(t.b, t.cust), status: 'confirmed', branchId: branchOf(t.b) });
    const runs = Math.ceil(t.volume / 8);
    const fl = lorriesByBranch[t.b] || [];
    const fd = driversByBranch[t.b] || [];
    for (let r = 1; r <= runs; r++) {
      mkTrip(o, {
        runNo: r, lorry: fl.length ? fl[(r - 1) % fl.length] : lorryIds[0],
        driver: fd.length ? fd[(r - 1) % fd.length] : null,
        batch: Math.min(8, t.volume - (r - 1) * 8), status: 'planned', delivered: 0,
      });
    }
  }

  /* --- draft order (not yet confirmed) --- */
  {
    const cid = custIds.papar?.C001;
    if (cid) {
      const o = makeOrder({
        cust: cid, site: siteOf('papar', 'C001', 1), mix: 'K4', volume: 20,
        dateOffset: 3, status: 'draft', po: 'SC/2026/0xx', branchId: branchOf('papar'),
      });
      run(`UPDATE orders SET status = 'draft' WHERE id = ?`, o.id);
    }
  }

  /* --- attendance for the current month --- */
  const ym = monthStart().slice(0, 8);          /* 'YYYY-MM-' - the day is appended below */
  const days = Number(todayIso.slice(8, 10));
  for (const emp of Object.keys(staffIds)) {
    const sid = staffIds[emp];
    if (!sid) continue;
    for (let d = 1; d <= days; d++) {
      const date = `${ym}${String(d).padStart(2, '0')}`;
      const dow = new Date(`${date}T00:00:00`).getDay();
      const rest = dow === 0;
      const leave = (Number(emp.slice(1)) % 4 === 3 && d === 5);
      const status = rest ? 'rest' : leave ? 'leave' : (d % 7 === 3 ? 'late' : 'present');
      run(`INSERT OR IGNORE INTO attendance (staff_id, work_date, in_time, out_time, status)
            VALUES (?,?,?,?,?)`, sid, date,
        status === 'present' || status === 'late' ? '07:00' : null,
        status === 'present' || status === 'late' ? '18:00' : null, status);
    }
  }

  /* --- a couple of open purchase orders (per branch) --- */
  const pos = [
    { b: 'papar', sup: 'S001', items: [['MAT-CEM-50', 500, 33.5]], dateOffset: -2, status: 'ordered' },
    { b: 'tuaran', sup: 'S002', items: [['MAT-AGG', 60, 38], ['MAT-SAND', 40, 42]], dateOffset: -1, status: 'ordered' },
    { b: 'papar', sup: 'S003', items: [['FUE-DSL', 2000, 2.05]], dateOffset: -3, status: 'received' },
    { b: 'putatan', sup: 'S005', items: [['TRY-315-80R22.5', 4, 1450]], dateOffset: -5, status: 'received' },
  ];
  for (const p of pos) {
    const when = addDays(todayIso, p.dateOffset);
    if (get('SELECT id FROM purchases WHERE po_no IS NOT NULL AND supplier_id = ? AND order_date = ?', supIds[p.sup], when)) continue;
    const amount = p.items.reduce((s, [, q, c]) => s + q * c, 0);
    const r = run(`INSERT INTO purchases (po_no, supplier_id, order_date, delivery_date, amount, status, note, branch_id)
                  VALUES (?,?,?,?,?,?,'',?)`,
      nextNo('purchase', 'PO'), supIds[p.sup], when,
      addDays(todayIso, p.dateOffset + 3), round2(amount), p.status, branchOf(p.b));
    for (const [sku, q, c] of p.items) {
      run('INSERT INTO purchase_items (purchase_id, item_id, qty, unit_cost) VALUES (?,?,?,?)',
        r.id, itemIds[p.b]?.[sku] ?? itemIds.papar[sku], q, c);
    }
  }
}

/* ---------- 10. fleet / stock summary ---------- */
const counts = {
  users: num(get('SELECT COUNT(*) AS n FROM users').n),
  staff: num(get('SELECT COUNT(*) AS n FROM staff').n),
  lorries: num(get('SELECT COUNT(*) AS n FROM lorries').n),
  customers: num(get('SELECT COUNT(*) AS n FROM customers').n),
  sites: num(get('SELECT COUNT(*) AS n FROM sites').n),
  mixes: num(get('SELECT COUNT(*) AS n FROM mix_designs').n),
  items: num(get('SELECT COUNT(*) AS n FROM items').n),
  orders: num(get('SELECT COUNT(*) AS n FROM orders').n),
  trips: num(get('SELECT COUNT(*) AS n FROM trips').n),
  invoices: num(get('SELECT COUNT(*) AS n FROM invoices').n),
  payments: num(get('SELECT COUNT(*) AS n FROM payments').n),
  purchases: num(get('SELECT COUNT(*) AS n FROM purchases').n),
};
console.log('  Seeded:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

/* Ringkasan login - dijana daripada pangkalan data, bukan ditulis tangan.
 * Ringkasan yang ditulis tangan cepat menjadi salah: ia pernah masih
 * menunjuk akaun 'office' yang sudah tidak wujud.
 *
 * Hanya akaun yang DICIADAKAN oleh seed menunjukkan kata laluan. Akaun yang
 * sudah wujud tidak disentuh, jadi kata laluan sebenar tidak diketahui di sini
 * - pangkalan data hanya menyimpan hash. */
const demoLogins = all(`SELECT u.username, s.emp_no, u.role, u.can_finance, b.code AS branch
                       FROM users u
                       LEFT JOIN staff s ON s.id = u.staff_id
                       LEFT JOIN branches b ON b.id = u.branch_id
                       WHERE u.active = 1
                       ORDER BY (u.role = 'admin') DESC, COALESCE(b.code, ''), u.role, u.username`);
console.log('\n  Logins:');
for (const u of demoLogins) {
  const pass = seedPasswords.get(u.username.toLowerCase());
  const who = u.branch ? `- ${u.branch}` : (u.role === 'admin' ? '- semua cawangan' : '- HQ');
  const extra = u.role === 'admin' ? 'access penuh'
    : u.can_finance ? 'kewangan'
    : u.role === 'driver' ? 'lorri sendiri sahaja'
    : 'pejabat sahaja';
  console.log(`    ${u.username.padEnd(10)} / ${(pass || '(kata laluan sedia ada)').padEnd(13)} ${who.padEnd(17)} [${extra}]`);
}
console.log('\n  Akaun kakitangan login dengan NOMBOR PEKERJA (3-PPR01); kata laluan');
console.log('  data contoh ialah nombor yang sama huruf kecil. Tukar semua');
console.log('  kata laluan ini sebelum sistem digunakan sebenar.\n');

function num(v) { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
