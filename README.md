# Kotamix Concrete — Concrete Lorry Operations System

A web application for running a ready-mix concrete lorry business in Sabah: sales
orders, delivery trips, cash/bank/online payments, fleet, fuel, inventory
(materials + fuel + spare parts), staff, attendance and payroll.

Runs in any modern browser on a phone, tablet or PC. **No external packages to
install** — it uses only Node's built-in modules, so it will keep running years
from now without dependency rot.

Bilingual throughout: **Bahasa Malaysia / English**, switchable with the `BM | EN`
button in the top bar. The language choice is remembered per user.

---

## 1. Requirements

- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module). Check with
  `node -v`.
- A modern browser.

That is the whole list. There is nothing to `npm install`.

---

## 2. Getting started

```bash
cd ConcreteLorrySabah

# 1. Load the demo data (settings, staff, lorries, stock, customers, orders...)
npm run seed

# 2. Start the server
npm start
```

Open <http://localhost:3000> and sign in.

### Demo logins

| Username | Password | Role   | What they can do |
|----------|----------|--------|------------------|
| `admin`  | `admin123`  | admin  | Everything, including settings, users, backup and reset |
| `office` | `office123` | office | Day-to-day operations: orders, deliveries, invoicing, payments, purchasing |
| `driver` | `driver123` | driver | Deliveries and trip actions only |

Two more driver accounts exist for scheduling demos: `driver2` / `driver2` and
`driver3` / `driver3`.

> **Change these before going live.** Sign in as `admin` → **Settings → Users**.

### Configuration

Set via environment variables when starting the server:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` lets phones on the same Wi-Fi connect |
| `CLS_DATA_DIR` | `./data` | Where the SQLite database file lives |

```bash
PORT=8080 npm start                      # different port
HOST=127.0.0.1 npm start                 # this machine only
```

**Using it on a phone:** run `npm start` on a computer, then browse to
`http://<that-computer's-LAN-IP>:3000` (e.g. `http://192.168.1.50:3000`).
Find the IP with `ipconfig getifaddr en0` on macOS or `hostname -I` on Linux.
Both the computer and phone must be on the same network.

---

## 3. The daily workflow

This is the intended order of operations. Steps 1–4 are done in the office,
steps 5–7 by the driver in the yard.

### 1. Take the order — `/orders`

`New Order` captures the customer, site, mix design, volume in m³ and the price.
The system:

- suggests how many lorries and trips the volume needs (from the selected
  lorries' capacities);
- prices the mix from the mix design, or uses your own rate;
- adds the delivery charge, discount and SST;
- shows a live-running total as you type.

Orders move `Draft → Confirmed` via the **Confirm** button on the order page.
After that the order's status follows its own trips automatically — `Loading`,
`Dispatched`, `Delivered` — and when every trip has returned it completes
itself. An order can be voided at any time via **Void**. `Order No` is generated
automatically, e.g. `SO-2026-0001`.

### 2. Plan the delivery — `/schedule`

A day view of every trip. Assign a lorry and a driver to each planned trip.
Stock is **not** consumed here — only when concrete is actually loaded.

### 3. Load and deliver — `/deliveries`

Each trip advances through a fixed chain by tapping the action on the trip card:

```
planned → loading → dispatched → delivered → returned
```

Tap **Mark Loading** when the mixer is loaded. At that moment the system
**automatically deducts the mix ingredients from stock** per the mix design
(cement, sand, aggregate, admixture) and the trips' m³ roll up into the order.
If stock is short, the trip is refused and the shortages are listed — fix the
stock level first.

Also record the **leftover m³** returned from site. Leftovers are logged as
waste; they are deliberately *not* put back into stock.

Pump start / stop times are captured when available, and feed the driver
performance report.

### 4. Invoice — `/invoices`

An invoice is generated for the order (or create one by hand). Amounts follow
the order: volume × rate, plus delivery, less discount, plus SST. Partial
payments are supported — the invoice shows the balance due.

### 5. Collect the money — `/payments`

Three methods, all supported together:

| Method | How it works |
|--------|--------------|
| **Cash** | Recorded immediately. |
| **Bank transfer** | Record the transfer, then **manually confirm** it once the bank shows the credit. |
| **Online** | Generates a **PayLink** you send to the customer (`/invoices/:id/link`). The customer opens it on their phone, sees the amount, and pays via your gateway. You then mark the payment received. |

Payments roll up onto the invoice, into the customer's account, and into
`/receivables` (with an aging view: Current / 1–30 / 31–60 / 60+ days).

### 6. Stock and fuel — `/inventory`, `/fuel`

Inventory covers all three categories you asked for:

- **Material** — cement, sand, aggregate, admixture
- **Fuel** — diesel
- **Spare parts** — tyres, filters, etc.

Every change is a **stock movement** with a reason, so you always have an audit
trail of what came in and went out. Stock is deducted automatically on loading;
you can also do manual `Stock In` / `Stock Out` and `Adjust` (e.g. for stock
takes). Items at or below their minimum level are highlighted as **Low** and
show up on the dashboard.

`/fuel` logs diesel per lorry with odometer, litres, cost and the resulting
**RM per m³** delivered, which is the number that tells you if a job is worth
doing.

### 7. People — `/staff`, `/attendance`, `/payroll`

Record attendance per day (or mark the whole month in one go). The payroll
sheet for a month calculates: days worked, trips, m³ delivered, trip allowance,
attendance allowance and overtime, against each staff member's rate — with gross,
deductions, tax, EPF/SOCSO and net pay. Payslips print one per person.

---

## 4. Printing

Every printable document has a print-optimised page with a **Print** button
(choose A4 or A5 — the delivery notes are laid out A5 2-up, so one sheet of A4
yields two slips).

| Document | URL |
|----------|-----|
| Delivery Note (original + driver copy) | `/print/dn/:tripId` |
| Invoice | `/print/invoice/:invoiceId` |
| Payment receipt | `/print/receipt/:paymentId` |
| Customer statement | `/print/statement/:customerId` |
| Sales order | `/print/order/:orderId` |
| Purchase order | `/print/po/:poId` |
| Payslip | `/print/payslip/:staffId?month=YYYY-MM` |

**Printing tips**

- In the print dialog set **Margins → None** and enable **Background graphics**,
  otherwise the header colours and signature rules drop out.
- Turn off headers and footers if the browser adds its own date/URL.
- Delivery notes print 2 per A4 sheet by default; scale to 100%.
- Amounts in words are printed on invoices and receipts in both languages.

---

## 5. Reports — `/reports`

Pick a tab and a date range; each one exports to CSV.

- **Sales** — revenue, m³ and order count per day.
- **Profit** — per mix design: revenue, material cost, fuel cost, gross margin %.
- **Stock** — on-hand, minimum, unit cost and stock value per item.
- **Fleet** — trips, m³, fuel cost and **cost per m³** per lorry.
- **People** — trips, m³ and km per driver.

Other useful views: `/receivables` (aging), `/payroll` (monthly cost), `/fuel`
(fuel efficiency), `/dashboard` (today at a glance).

---

## 6. Administration — `/settings`

Tabs:

- **Company** — name, address, phone, logo/letterhead details used on prints.
- **Finance** — SST rate, default delivery charge, currency, invoice terms.
- **Bank** — bank accounts shown on invoices for bank transfers.
- **Allowances** — trip allowance, attendance allowance, overtime rates for payroll.
- **Numbering** — prefixes for each document series (SO, INV, DN, PO, PAY…).
- **Users** — add, deactivate, reset passwords, and issue driver logins.
- **Data** — download a database backup, or reset the system.

---

## 7. Backup, restore and reset

```bash
npm run backup      # writes data/backup-<timestamp>.db (a clean VACUUM INTO copy)
```

**Back up from the UI too:** Settings → Data → *Download database backup*.
This is the normal daily routine — the download works from any phone.

> `data/` holds the entire business. Copy that folder to a USB stick or cloud
> drive, or schedule `npm run backup`.

Other maintenance commands:

```bash
npm run seed        # load demo data into an empty database
npm run reseed      # wipe transactional data, then reload demo data
npm run reset       # interactive reset; asks before deleting anything
npm run smoke       # walk every page and report any that fail
```

`npm run reset` will ask for confirmation. It removes orders, trips, invoices,
payments, stock movements and fuel logs but keeps your settings, users, staff,
lorries, customers, suppliers, items and mix designs. Deleting from
Settings → Data requires typing `RESET`, and is admin-only.

---

## 8. Technical notes

**Stack:** Node's built-in `node:http` and `node:sqlite` (`DatabaseSync`). There
is no build step, no bundler, and **no npm dependencies** — `package.json` has
an empty dependency list on purpose.

```
ConcreteLorrySabah/
├── server.js            # HTTP server, routing table, auth gate, error handling
├── src/
│   ├── db.js            # schema (21 tables), migrations, settings, auth helpers
│   ├── i18n.js          # bilingual dictionary (~570 keys)
│   ├── seed.js          # demo data
│   ├── reset.js         # maintenance reset
│   ├── backup.js        # VACUUM INTO backup
│   ├── lib/
│   │   ├── http.js      # body/cookie parsing, responses, CSV, date helpers
│   │   ├── html.js      # escaping, layout, and UI components
│   │   └── biz.js       # shared business logic (see below)
│   └── routes/          # 20 modules, one per area
├── public/
│   ├── css/app.css      # the whole stylesheet, including print rules
│   └── js/app.js        # sidebar drawer, flashes, form helpers
├── scripts/smoke.mjs    # route-walking test
└── data/app.db          # your database (created on first run)
```

**Everything is computed in `src/lib/biz.js`** so numbers stay consistent no
matter which screen you are on: `calcOrder` (all order money math),
`suggestTrips`, `deductTripMaterials`, `syncOrderFromTrips`, `ensureInvoiceForOrder`,
`recalcInvoice`, `agingBuckets`, `addFuel`, `payrollForMonth`, `dashboardKpis`.

**Server-rendered HTML.** Pages are plain HTML strings assembled by a small
tagged-template layer. `html` auto-escapes interpolations; `raw()` is the escape
hatch for pre-built markup. Because output is a normal string, a page's
appearance can be verified by curling it, and printing is just a stylesheet.

**Document numbering** comes from a `counters` table via `nextNo(kind, prefix)`,
which produces gap-free numbers per year and per series.

**Security notes.** Passwords are hashed (scrypt) before storage. Sessions are
opaque random tokens in an httpOnly cookie, stored server-side in `sessions`, so
signing out genuinely invalidates the session. All user input is escaped on
output. Because this is designed to run on an office LAN rather than the open
internet, put it behind HTTPS (e.g. an nginx or Caddy reverse proxy with
TLS) before exposing it to the internet.

**Adding a page.** Add a route object (`{ method, path, handler(ctx) }`) to the
relevant file in `src/routes/`, register the module in `server.js`, and — if you
add new text — add matching keys to `src/i18n.js` in both `bm` and `en`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Node is older than 22.5. Upgrade Node. |
| `EADDRINUSE` | Another process owns the port: `PORT=3001 npm start`. |
| Phone cannot reach the server | Use the LAN IP, not `localhost`; make sure both are on the same Wi-Fi. |
| A trip will not mark as *Loading* | Stock is short. The flash message names the items — buy or adjust them in `/inventory`. |
| Print looks cramped | Set margins to *None* and enable background graphics. |
| Forgot the admin password | Delete `data/app.db` and re-run `npm run seed` (loses data), or ask the DB admin to update `password_hash`. |

### Before going live

1. Change the admin password and delete the demo accounts.
2. Update **Settings → Company** with your real details — they appear on every printed document.
3. Set your SST rate, bank accounts and allowance rates.
4. Enter your real lorries, staff, mix designs, items and customers (or reset and start fresh).
5. Arrange a daily `npm run backup` (or a weekly tap of Settings → Data).
