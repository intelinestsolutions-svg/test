/**
 * Business logic shared by routes.
 */
import { all, get, run, tx, nextNo, setting, setSetting, nowLocal, today } from '../db.js';
import { num, today as tdate, addDays, daysBetween } from './http.js';

/* ---------------- catalogue helpers ---------------- */
export const mixByCode = (code) => (code ? get('SELECT * FROM mix_designs WHERE code = ?', code) : null);
export const activeMixes = () => all('SELECT * FROM mix_designs WHERE active = 1 ORDER BY code');
export const activeItems = (cat = null) =>
  all(`SELECT * FROM items WHERE active = 1 ${cat ? 'AND category = ?' : ''} ORDER BY category, name`, ...(cat ? [cat] : []));

/**
 * Cari (atau cipta) item dalam satu cawangan sahaja.
 * Stok adalah KHAS CAWANGAN, jadi nama yang sama wujud sekali dalam setiap
 * cawangan. Tanpa branch_id di sini, satu cawangan akan mengambil stok
 * cawangan lain.
 */
export function ensureItem(name, unit, category = 'material', branchId = null) {
  const bid = branchId === 'all' ? null : (branchId ?? null);
  const found = get('SELECT * FROM items WHERE name = ? AND category = ? AND branch_id IS ?', name, category, bid);
  if (found) return found;
  // SKU mesti unik dalam cawangan, jadi masukkan kod cawangan.
  const bcode = bid ? (get('SELECT code FROM branches WHERE id = ?', bid)?.code || bid) : 'HQ';
  const sku = `AUTO-${bcode}-${Date.now().toString(36).toUpperCase()}`;
  const r = run('INSERT INTO items (sku, name, category, unit, branch_id, created_at) VALUES (?,?,?,?,?,?)',
    sku, name, category, unit, bid, new Date().toISOString());
  return get('SELECT * FROM items WHERE id = ?', r.id);
}

/* ---------------- order pricing ---------------- */
/**
 * Compute order money fields.
 * subtotal = volume*unit_price - discount + delivery_charge
 * sst = subtotal * sst_rate/100
 * amount  = subtotal + sst
 */
export function calcOrder(o) {
  const volume = num(o.volume_m3);
  const unit = num(o.unit_price);
  const disc = num(o.discount);
  const del = num(o.delivery_charge);
  const rate = num(o.sst_rate, 0);
  let subtotal = volume * unit - disc + del;
  if (subtotal < 0) subtotal = 0;
  const sst = round2(subtotal * rate / 100);
  return { volume_m3: volume, unit_price: unit, discount: disc, delivery_charge: del, sst_rate: rate, subtotal: round2(subtotal), amount: round2(subtotal + sst) };
}
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/** Suggested number of trips given volume and chosen lorry capacities. */
export function suggestTrips(volumeM3, lorryIds = []) {
  const caps = lorryIds.length
    ? all(`SELECT capacity_m3 FROM lorries WHERE id IN (${lorryIds.map(() => '?').join(',')})`, ...lorryIds)
    : all('SELECT capacity_m3 FROM lorries WHERE active = 1');
  const cap = caps.length ? Math.min(...caps.map((c) => num(c.capacity_m3, 8))) : 8;
  if (cap <= 0) return 0;
  return Math.max(1, Math.ceil(num(volumeM3) / cap));
}

export function orderProgress(orderId) {
  const o = get('SELECT volume_m3 FROM orders WHERE id = ?', orderId);
  const trips = all(`SELECT batch_m3, delivered_m3, returned_m3, status FROM trips WHERE order_id = ? AND status != 'void'`, orderId);
  const done = trips.filter((x) => x.status === 'delivered' || x.status === 'returned');
  const delivered = done.reduce((s, x) => s + num(x.delivered_m3), 0);
  const loaded = trips.reduce((s, x) => s + num(x.batch_m3), 0);
  return {
    volume: num(o?.volume_m3),
    tripsTotal: trips.length,
    tripsDone: done.length,
    delivered: round2(delivered),
    loaded: round2(loaded),
    remaining: round2(Math.max(0, num(o?.volume_m3) - delivered)),
  };
}

/* ---------------- trip -> stock ---------------- */
/**
 * Deduct bill of materials for a trip when it is loaded.
 * Cement bags, sand, aggregate, admixture are pulled from stock as `out` movements.
 */
export function deductTripMaterials(tripId, userId) {
  const tr = get('SELECT * FROM trips WHERE id = ?', tripId);
  if (!tr) return { ok: false, msg: 'Trip not found' };
  const o = get('SELECT * FROM orders WHERE id = ?', tr.order_id);
  const mix = mixByCode(o.mix_code);
  if (!mix) return { ok: false, msg: 'No mix design for order' };
  const m3 = num(tr.batch_m3);
  if (m3 <= 0) return { ok: false, msg: 'Load volume is 0' };

  const comps = [
    ['Cement', 'bag', num(mix.cement_bags) * m3],
    ['Sand', 'm3', num(mix.sand_m3) * m3],
    ['Aggregate', 'm3', num(mix.agg_m3) * m3],
    ['Admixture', 'litre', num(mix.admix_l) * m3],
  ].filter(([, , q]) => q > 0);

  // Trip sentiasa milik satu cawangan; stok ditolak dari cawangan itu sahaja.
  const bid = tr.branch_id ?? o.branch_id ?? null;
  const shortages = [];
  for (const [name, unit, q] of comps) {
    const item = ensureItem(name, unit, 'material', bid);
    const have = stockQty(item.id);
    if (have < q - 0.001) {
      shortages.push({ name, need: round2(q), have: round2(have), unit, itemId: item.id });
    }
  }
  if (shortages.length) return { ok: false, shortages, msg: 'Insufficient stock' };

  for (const [name, unit, q] of comps) {
    const item = ensureItem(name, unit, 'material', bid);
    run(`INSERT INTO stock_movements (item_id, move_date, type, qty, unit_cost, ref_type, ref_id, ref_no, lorry_id, note, branch_id, created_by, created_at)
         VALUES (?,?,?,?,?,'trip',?,?,?,?,?,?,?)`,
      item.id, tdate(), 'out', round3(q), num(item.unit_cost), tripId, tr.trip_no, tr.lorry_id,
      `${o.order_no} ${mix.code} ${m3}m3`, bid, userId, new Date().toISOString());
  }
  return { ok: true, comps };
}

/** Stock out for a non-trip reason (site wastage, loader use, etc.) */
export function recordMovement({ itemId, type, qty, unitCost = null, refType = 'manual', refId = null, refNo = '', lorryId = null, note = '', userId = null, date = null }) {
  const item = get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) throw new Error('Item not found');
  const cost = unitCost === null ? num(item.unit_cost) : num(unitCost);
  // Movement mewarisi cawangan item - jika tidak, rekod jadi "tiada cawangan".
  run(`INSERT INTO stock_movements (item_id, move_date, type, qty, unit_cost, ref_type, ref_id, ref_no, lorry_id, note, branch_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    itemId, date || tdate(), type, Math.abs(num(qty)), cost, refType, refId, refNo, lorryId, note,
    item.branch_id ?? null, userId, new Date().toISOString());
  return true;
}

export function stockQty(itemId) {
  const r = get(`SELECT COALESCE(SUM(CASE WHEN type IN ('in','adjust') THEN qty ELSE -qty END),0) AS q
                 FROM stock_movements WHERE item_id = ?`, itemId);
  return num(r?.q);
}
export function stockLevel(itemId) {
  const r = get(`SELECT
      COALESCE(SUM(CASE WHEN type IN ('in','adjust') THEN qty ELSE 0 END),0) AS tin,
      COALESCE(SUM(CASE WHEN type='out' THEN qty ELSE 0 END),0) AS tout,
      COALESCE(SUM(CASE WHEN type='waste' THEN qty ELSE 0 END),0) AS twaste,
      COALESCE(SUM(CASE WHEN type IN ('in','adjust') THEN qty ELSE -qty END),0) AS bal
    FROM stock_movements WHERE item_id = ?`, itemId);
  return { in: num(r?.tin), out: num(r?.tout), waste: num(r?.twaste), bal: num(r?.bal) };
}

/* ---------------- fleet status ---------------- */
export function setLorryStatus(lorryId, status) {
  if (lorryId) run('UPDATE lorries SET status = ? WHERE id = ?', status, lorryId);
}
export function syncLorryFromTrip(tripId) {
  const tr = get('SELECT * FROM trips WHERE id = ?', tripId);
  if (!tr) return;
  const map = { planned: 'available', loading: 'loading', dispatched: 'on_delivery', delivered: 'on_delivery', returned: 'available', void: 'available' };
  if (tr.lorry_id) setLorryStatus(tr.lorry_id, map[tr.status] || 'available');
}

/** Keep order status in step with its trips. */
export function syncOrderFromTrips(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.status === 'cancelled' || o.status === 'draft') return;
  const trips = all(`SELECT status, delivered_m3 FROM trips WHERE order_id = ? AND status != 'void'`, orderId);
  if (!trips.length) return;
  const active = trips.filter((x) => x.status !== 'returned');
  const allReturned = trips.every((x) => x.status === 'returned');
  const anyDispatched = trips.some((x) => ['dispatched', 'delivered'].includes(x.status));
  const anyLoading = trips.some((x) => x.status === 'loading');

  let status = o.status;
  if (allReturned) status = 'delivered';
  else if (anyDispatched) status = 'dispatched';
  else if (anyLoading) status = 'loading';
  if (status !== o.status) {
    run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), orderId);
    if (status === 'delivered') completeOrder(orderId);
  }
}

/** All trips returned -> mark order completed. */
export function completeOrder(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return;
  run(`UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?`, new Date().toISOString(), orderId);
  ensureInvoiceForOrder(orderId);
}

/* ---------------- invoices ---------------- */
export function ensureInvoiceForOrder(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const exist = get('SELECT * FROM invoices WHERE order_id = ?', orderId);
  if (exist) {
    run(`UPDATE invoices SET amount = ?, due_date = ? WHERE id = ?`,
      num(o.amount), addDays(o.delivery_date, num(setting('default_payment_terms'), 0)), exist.id);
    return exist;
  }
  if (num(o.amount) <= 0) return null;
  const s = get('SELECT payment_terms_days FROM customers WHERE id = ?', o.customer_id);
  const terms = s ? num(s.payment_terms_days) : 0;
  const inv = run(`INSERT INTO invoices (invoice_no, order_id, customer_id, issue_date, due_date, amount, sst_amount, amount_paid, status)
                   VALUES (?,?,?,?,?,?,?,0,'unpaid')`,
    nextNo('invoice', setting('invoice_prefix', 'INV')), orderId, o.customer_id, tdate(),
    addDays(o.delivery_date, terms), num(o.amount), num(o.amount) - num(o.subtotal), );
  return get('SELECT * FROM invoices WHERE id = ?', inv.id);
}

export function recalcInvoice(invoiceId) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) return;
  const paid = get(`SELECT COALESCE(SUM(amount),0) AS s FROM payments
                    WHERE invoice_id = ? AND status = 'confirmed'`, invoiceId);
  const amountPaid = round2(paid.s);
  let status = 'unpaid';
  if (inv.status === 'cancelled') status = 'cancelled';
  else if (amountPaid <= 0) status = 'unpaid';
  else if (amountPaid + 0.009 < num(inv.amount)) status = 'partial';
  else status = 'paid';
  run('UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?', amountPaid, status, invoiceId);
}

export function customerBalance(customerId) {
  const r = get(`SELECT COALESCE(SUM(i.amount - i.amount_paid),0) AS bal
                 FROM invoices i WHERE i.customer_id = ? AND i.status != 'cancelled'`, customerId);
  return round2(r?.bal);
}

export function agingBuckets(asOf = tdate()) {
  const rows = all(`SELECT i.id, i.invoice_no, i.due_date, (i.amount - i.amount_paid) AS bal,
                           c.id AS cid, c.name AS cname, c.code AS ccode
                    FROM invoices i JOIN customers c ON c.id = i.customer_id
                    WHERE i.status != 'cancelled' AND (i.amount - i.amount_paid) > 0.009`);
  const b = { current: [], d1: [], d2: [], d3: [], d4: [] };
  for (const r of rows) {
    const overdue = daysBetween(r.due_date || asOf, asOf);
    const row = { ...r, bal: round2(r.bal), overdue };
    if (overdue <= 0) b.current.push(row);
    else if (overdue <= 30) b.d1.push(row);
    else if (overdue <= 60) b.d2.push(row);
    else if (overdue <= 90) b.d3.push(row);
    else b.d4.push(row);
  }
  const sum = (a) => round2(a.reduce((s, x) => s + x.bal, 0));
  return {
    buckets: b,
    totals: { current: sum(b.current), d1: sum(b.d1), d2: sum(b.d2), d3: sum(b.d3), d4: sum(b.d4) },
    grand: round2(sum(b.current) + sum(b.d1) + sum(b.d2) + sum(b.d3) + sum(b.d4)),
  };
}

/* ---------------- fuel ---------------- */
export function addFuel({ lorryId, litres, pricePerLitre, odometer = null, station = '', receiptNo = '', refType = 'manual', refId = null, note = '', userId = null, date = null }) {
  const L = num(litres), P = num(pricePerLitre);
  const r = run(`INSERT INTO fuel_logs (lorry_id, log_date, litres, price_per_litre, total, odometer, station, receipt_no, ref_type, ref_id, note, created_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    lorryId, date || tdate(), L, P, round2(L * P), odometer ? num(odometer) : null,
    station, receiptNo, refType, refId, note, userId, new Date().toISOString());
  // top up lorry tank + move stock out of fuel store
  const lorry = get('SELECT * FROM lorries WHERE id = ?', lorryId);
  if (lorry) {
    run('UPDATE lorries SET fuel_litres = ?, odometer = COALESCE(?, odometer) WHERE id = ?',
      round2(num(lorry.fuel_litres) + L), odometer ? num(odometer) : null, lorryId);
  }
  const diesel = get(`SELECT * FROM items WHERE name = 'Diesel' AND category = 'fuel'`);
  if (diesel) {
    recordMovement({ itemId: diesel.id, type: 'out', qty: L, unitCost: P, refType: 'fuel', refId: r.id, lorryId, note: `Fuel ${lorry?.code || ''}`, userId, date: date || tdate() });
  }
  return r.id;
}
export function removeFuelLog(id) {
  const f = get('SELECT * FROM fuel_logs WHERE id = ?', id);
  if (!f) return;
  run('DELETE FROM fuel_logs WHERE id = ?', id);
  const lorry = get('SELECT * FROM lorries WHERE id = ?', f.lorry_id);
  if (lorry) run('UPDATE lorries SET fuel_litres = MAX(0, fuel_litres - ?) WHERE id = ?', num(f.litres), f.lorry_id);
  const mv = get(`SELECT * FROM stock_movements WHERE ref_type = 'fuel' AND ref_id = ?`, id);
  if (mv) run('DELETE FROM stock_movements WHERE id = ?', mv.id);
}

/* ---------------- costing for reports ---------------- */
export function materialCostForMix(mix, m3) {
  const rows = [
    [num(mix.cement_bags) * m3, 'Cement'],
    [num(mix.sand_m3) * m3, 'Sand'],
    [num(mix.agg_m3) * m3, 'Aggregate'],
    [num(mix.admix_l) * m3, 'Admixture'],
  ].filter(([q]) => q > 0);
  let total = 0;
  const detail = [];
  for (const [q, name] of rows) {
    const item = get(`SELECT * FROM items WHERE name = ? AND category = 'material'`, name);
    const cost = num(item?.unit_cost) * q;
    total += cost;
    detail.push({ name, qty: round3(q), unitCost: num(item?.unit_cost), cost: round2(cost) });
  }
  return { total: round2(total), detail };
}

export function fuelCostForTrip(tripId) {
  const r = get(`SELECT COALESCE(SUM(total),0) AS t, COALESCE(SUM(litres),0) AS l
                 FROM fuel_logs WHERE ref_type = 'trip' AND ref_id = ?`, tripId);
  return { total: round2(r.t), litres: round2(r.l) };
}

export function deliveredRevenue(from, to) {
  const r = get(`SELECT COALESCE(SUM(t.delivered_m3),0) AS m3 FROM trips t
                 WHERE t.status IN ('delivered','returned') AND t.arrive_time IS NOT NULL
                 AND date(t.arrive_time) BETWEEN ? AND ?`, from, to);
  return round2(r.m3);
}

/* ---------------- staff / payroll ---------------- */
export function allowanceRates() {
  return {
    driverDaily: num(setting('driver_daily_allowance'), 0),
    driverTrip: num(setting('driver_trip_allowance'), 0),
    loaderTrip: num(setting('loader_trip_allowance'), 0),
  };
}

export function payrollForMonth(month) {
  const from = `${month}-01`;
  const to = `${month}-31`;
  const staff = all(`SELECT * FROM staff WHERE status != 'resigned' ORDER BY role, name`);
  const a = allowanceRates();
  const out = [];
  for (const s of staff) {
    const att = get(`SELECT
        SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN status = 'leave' THEN 1 ELSE 0 END) AS leaveDays
      FROM attendance WHERE staff_id = ? AND work_date BETWEEN ? AND ?`, s.id, from, to);
    const daysWorked = num(att?.present) + num(att?.leaveDays);
    const trips = get(`SELECT COUNT(*) AS n, COALESCE(SUM(t.delivered_m3),0) AS m3
      FROM trips t JOIN orders o ON o.id = t.order_id
      WHERE t.driver_id = ? AND t.status IN ('delivered','returned') AND o.delivery_date BETWEEN ? AND ?`,
      s.id, from, to);
    const nTrips = num(trips?.n);
    const m3 = round2(trips?.m3);
    const attAllow = round2(daysWorked * a.driverDaily);
    const tripAllow = round2(nTrips * a.driverTrip);
    const basic = num(s.salary);
    out.push({
      staff: s, basic, daysWorked, trips: nTrips, m3, attAllow, tripAllow,
      loaderAllow: 0, otHours: 0, deduction: 0,
      gross: round2(basic + attAllow + tripAllow),
      net: round2(basic + attAllow + tripAllow),
    });
  }
  return out;
}

/* ---------------- dashboard ---------------- */
export function dashboardKpis(date = tdate()) {
  const tomorrow = addDays(date, 1);
  const ordersToday = get(`SELECT COUNT(*) AS n, COALESCE(SUM(volume_m3),0) AS m3, COALESCE(SUM(amount),0) AS amt
                           FROM orders WHERE delivery_date = ? AND status NOT IN ('cancelled','draft')`, date);
  const deliveredToday = get(`SELECT COALESCE(SUM(delivered_m3),0) AS m3, COUNT(*) AS n
                              FROM trips WHERE status IN ('delivered','returned') AND date(arrive_time) = ?`, date);
  const cashToday = get(`SELECT COALESCE(SUM(amount),0) AS amt FROM payments
                         WHERE status = 'confirmed' AND date(paid_at) = ?`, date);
  const rec = agingBuckets(date);
  const lowStock = all(`SELECT i.*, COALESCE(sm.bal, 0) AS bal FROM items i
                        LEFT JOIN (SELECT item_id, COALESCE(SUM(CASE WHEN type IN ('in','adjust') THEN qty ELSE -qty END),0) AS bal
                                   FROM stock_movements GROUP BY item_id) sm ON sm.item_id = i.id
                        WHERE i.active = 1 AND COALESCE(sm.bal, 0) <= i.min_qty
                        ORDER BY (i.min_qty - COALESCE(sm.bal, 0)) DESC LIMIT 12`);
  const fleet = all(`SELECT status, COUNT(*) AS n FROM lorries WHERE active = 1 GROUP BY status`);
  const tripsToday = get(`SELECT COUNT(*) AS n FROM trips t JOIN orders o ON o.id = t.order_id
                           WHERE o.delivery_date = ? AND t.status != 'void'`, date);
  return {
    date,
    ordersToday: { n: num(ordersToday.n), m3: round2(ordersToday.m3), amt: round2(ordersToday.amt) },
    deliveredToday: { n: num(deliveredToday.n), m3: round2(deliveredToday.m3) },
    cashToday: round2(cashToday.amt),
    receivables: rec.grand,
    overdue: round2(rec.totals.d1 + rec.totals.d2 + rec.totals.d3 + rec.totals.d4),
    aging: rec,
    lowStock, fleet, tripsToday: num(tripsToday.n),
    tomorrow,
  };
}

export { nowLocal };
