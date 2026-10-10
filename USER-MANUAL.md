# Kotamix Concrete — User Manual

Complete guide for office staff, drivers, and administrators. Malay UI terms are
shown in parentheses. Works in any modern browser on phone, tablet, or PC.

The system has two parts:

| Part | Address | Login? |
|------|---------|--------|
| Staff system (operations) | `/dashboard` and all menu pages | Yes — staff account required |
| Public portal (customers) | `/` landing, `/prices`, `/track` | No — open to customers |

---

## 1. Signing in

Open the site. If you are not signed in you see the public landing page —
tap **Staff Log In (Log Masuk Staf)**.

- Enter **Username (Nama Pengguna)** and **Password (Kata Laluan)** → **Sign In (Masuk)**.
- Switch language anytime with the **BM | EN** button in the top bar.
- Your session lasts 14 days on the same browser. Always **Log Out (Keluar)**
  (⏻ icon, top right) on shared devices.

### Initial admin account (change the password before going live)

| Username | Password | Role | Sees |
|----------|----------|------|------|
| `admin` | `admin123` | Admin | Everything, including Settings and users |

A fresh installation starts with one admin account and no demo data. Sign in
as `admin`, change the password, and add your own accounts under
**Settings → Users**. Staff can sign in with their employee code (e.g.
`PPR-S01`) once a password is set for them.

Drivers do not see Settings, Payroll, Purchasing, or Mix Designs in the menu,
and Settings pages are admin-only.

---

## 2. Menu map

- **Operations (Operasi):** Dashboard (Papan Pemuka), Orders (Pesanan),
  Daily Schedule (Jadual Harian), Deliveries (Penghantaran)
- **Finance (Kewangan):** Invoices (Invois), Payments (Bayaran),
  Receivables (Tunggakan)
- **Assets (Aset):** Fleet (Armada Lori), Fuel (Diesel),
  Inventory (Stok & Inventori), Mix Designs (Reka Bentuk Campuran),
  Purchasing (Pembelian & Pembekal)
- **People:** Staff (Kakitangan), Attendance (Kehadiran), Payroll (Gaji & Elaun),
  Customers (Pelanggan)
- **System:** Reports (Laporan), Settings (Tetapan)

Every list page has filters at the top (status, date, search box). Learn one
filter bar and you know them all.

---

## 3. Taking an order — Orders (Pesanan)

1. **Orders → New Order.** Pick the **customer** (add them first under
   Customers if new), site, **delivery date** and slot (AM / PM / night).
2. Pick the **mix design** (K0–K5). The price per m³ fills in automatically,
   or type your own rate. Enter **volume (m³)** — the system suggests how
   many lorries/trips you need and shows a live total:
   volume × rate + delivery charge − discount + SST.
3. **Save** (order is now **Draft / Draf**). Check it, then **Confirm
   (Sahkan)**. Confirming auto-creates the planned delivery trips and the
   invoice draft.
4. After confirming, the order tracks its trips by itself: Loading →
   Dispatched → Delivered, and completes when every trip returns.
5. **Void (Batalkan)** cancels an order at any time (planned trips are voided).

Order numbers (SO-2026-0001…) are generated automatically — never type them.

---

## 4. Planning the day — Schedule (Jadual Harian)

Day view of every trip. Assign a **lorry and driver** to each planned trip.
Nothing is deducted here — stock is only consumed at loading (next section).

---

## 5. Loading and delivering — Deliveries (Penghantaran)

Each trip moves through a fixed chain — tap the action on the trip card:

```
planned (Dirancang) → loading (Sedang Muat) → dispatched (Bertolak)
  → delivered (Dihantar) → returned (Sudah Pulang)
```

- **Mark Loading:** tap when the mixer is loaded. The system **automatically
  deducts cement, sand, aggregate, and admixture from stock** per the mix
  design. If stock is short, the trip is refused and the message names the
  missing items — top up in Inventory first.
- **Dispatch:** tap when the lorry leaves the yard.
- **Delivered:** enter the **delivered m³** (pumped at site). Record any
  **leftover m³** brought back — it is logged as waste, never returned to stock.
- **Returned:** tap when the lorry is back in the yard.
- Pump start/stop times feed the driver performance report.

Driver login tip: drivers only need this page — open the trip, tap the one
big button, done.

---

## 6. Invoicing — Invoices (Invois)

- Confirming an order prepares its invoice automatically
  (**Invoice → New from order**, or the button on the order page).
- Amounts follow the order. **Partial payments are supported** — each invoice
  shows paid vs. balance due.
- Status: **Unpaid (Belum Bayar) → Partial (Separa) → Paid (Lunas)**.
- Quick views: **Unpaid (Berbaki)** and **Overdue (Tertunggak)** buttons.

---

## 7. Collecting money — Payments (Bayaran)

Three methods, usable together on one invoice:

| Method | Steps |
|--------|-------|
| **Cash (Tunai)** | New Payment → Cash → amount → Save. Done immediately. |
| **Bank transfer (Pindahan Bank)** | Record the transfer, then **confirm** it once the bank shows the credit. |
| **Online (Bayaran Dalam Talian)** | Generates a **PayLink** you send the customer. They open it on their phone and pay; you mark it received. |

Payments roll onto the invoice balance, the customer account, and
**Receivables (Tunggakan)**, which ages debt as Current / 1–30 / 31–60 / 60+ days.

---

## 8. Lorries and diesel — Fleet & Fuel (Armada Lori & Diesel)

- **Fleet:** each lorry file holds code (L01…), registration, make/model,
  capacity (m³), odometer, and status
  (Available / Loading / On Delivery / Maintenance / Off Road).
  Opening a lorry shows its trips, delivered m³, fuel, and **cost per m³** —
  the number that says whether a job is worth doing.
- **Fuel:** log diesel per lorry with date, litres, price, odometer, station.
  Filter by lorry and date range.

---

## 9. Stock and purchasing — Inventory (Stok & Inventori)

Three categories in one place: **material** (cement, sand, aggregate,
admixture), **fuel** (diesel), **spare parts** (filters, tyres…).

- Every change is a **stock movement** (in / out / waste / adjust) with a
  reason — full audit trail.
- Loading a trip deducts automatically; use **Stock In / Stock Out / Adjust**
  for purchases, workshop use, and stock takes.
- Items at or below minimum show **Low** and appear on the dashboard.
- Filters: search by name/SKU, category (material / fuel / part), **Low only**.
- **Purchasing:** raise a Purchase Order to a supplier; receiving it adds the
  stock automatically.

---

## 10. Mix designs (Reka Bentuk Campuran)

K0–K5 with grade (MPa), price per m³, and the bill of materials **per 1 m³**
(cement bags, sand m³, aggregate m³, admixture litres). These numbers drive
automatic stock deduction — keep them accurate. Prices here feed the public
price list.

---

## 11. Customers & sites (Pelanggan)

Customer file: name, company, phone, area, credit limit, payment terms.
Add each **delivery site** (name, address, access notes) under the customer —
sites appear in the order form. Set **Active off** (instead of deleting) for
customers you no longer serve: they vanish from new orders but history stays
intact.

---

## 12. People — Staff, Attendance, Payroll

- **Staff:** file per person (role, phone, salary, trip allowance).
- **Attendance:** tap Present / Absent / Leave per person per day, or
  **Mark All Present**. Change the date to record back-days.
- **Payroll:** pick a month → days worked, trips, trip allowance, attendance
  allowance, gross and net per person. Print one **payslip** per person.

---

## 13. Reports (Laporan)

Pick a tab and date range; every tab exports to **CSV** (opens in Excel):

- **Sales** — revenue, m³, order count per day
- **Profit** — revenue vs. material + fuel cost per mix, margin %
- **Stock** — on-hand, minimum, unit cost, stock value
- **Fleet** — trips, m³, fuel cost, cost/m³ per lorry
- **People** — trips, m³ per driver

---

## 14. Printing

Every document has a print page with a **Print** button:

| Document | Opens from |
|----------|-----------|
| Delivery Note (2 per A4 sheet) | Trip card → Print |
| Invoice | Invoice page → Print |
| Payment receipt | Payment (via invoice) → Print |
| Customer statement | Customer file → Print |
| Sales order | Order page → Print |
| Purchase order | Purchasing → Print |
| Payslip | Payroll → Print per person |

Print tips: set browser margins to **None**, enable **Background graphics**,
turn off browser headers/footers.

---

## 15. Settings (Tetapan) — admin only

- **Company:** name, registration, SST no., phone, address, email — printed on
  every document.
- **Finance:** SST rate, default delivery charge, payment terms.
- **Bank:** bank name + account printed on invoices.
- **Allowances:** daily / trip / overtime rates for payroll.
- **Numbering:** prefixes for SO, INV, DN, TRP, PAY, RC series.
- **Users:** add accounts (admin / office / driver), change passwords,
  deactivate leavers, and set each staff member's password so they can sign
  in with their employee code.
- **Data:** download a database backup, or restore from an uploaded backup
  (a safety copy of the current database is kept automatically first).

---

## 16. The customer portal (no login)

- `/` — landing with role cards, price teaser, contact details.
- `/prices` — live price list from your mix designs.
- `/track` — customers enter an order number (e.g. SO-2026-0001) to see
  status, delivery date, and delivered-vs-ordered progress. Prices and
  contact details are never shown here.

---

## 17. Backup, restore, troubleshooting

- **Daily routine:** Settings → Data → *Download database backup* (works from
  any phone). `data/` holds the whole business — copy it to USB/cloud too.
- **Restore:** Settings → Data → *Restore backup file* replaces all current
  data with the uploaded backup. A safety copy of the current database
  (`clsbiz.pre-restore-<timestamp>.db`) is taken automatically first. Restart
  the application after restoring.
- There is **no reset button** in the app. To start completely fresh, restore
  an empty database backup or contact your system administrator.

| Symptom | Fix |
|---|---|
| Wrong username or password | Check caps; username is case-insensitive, password is not |
| Trip refuses Mark Loading | Stock short — message names the items; top up in Inventory |
| Language wrong | BM \| EN button in the top bar |
| Office account opens Settings | Bounced to dashboard — Settings is admin-only |
| Print looks cramped | Margins None + background graphics on |
| Forgot admin password | Restore last backup, or contact your system admin |

---

## 18. Security notes

- Sign out on shared devices; sessions expire after 14 days.
- Settings pages, backup and restore enforce admin at server level (drivers
  additionally have them hidden from the menu) — keep admin accounts to
  owners only.
- The office LAN build uses plain HTTP. Before exposing it to the internet
  (as on the Hostinger deployment), it runs behind Hostinger's HTTPS —
  never share the plain-HTTP LAN address publicly.
- Backups contain customer and bank data — store them securely.
