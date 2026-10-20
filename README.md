# Studio Pro CRM

A full CRM suite that runs on plain Node.js with **no dependencies and no build step**.

```bash
node server.js
```

Then open <http://localhost:3000> and sign in with `admin` / `admin123`.

## Why it is built this way

This app targets shared Node hosting that **cannot run `npm install` and cannot run a
build step**. A normal Next.js/Express stack fails there: native modules such as
`better-sqlite3` need a compiler, and `next build` needs a toolchain that the host
does not provide.

So the entire stack is built from Node's own standard library:

| Normally            | Here                                       |
| ------------------- | ------------------------------------------ |
| Express             | hand-rolled router on `node:http`          |
| better-sqlite3      | `node:sqlite` (`DatabaseSync`)             |
| bcryptjs            | `scrypt` from `node:crypto`                |
| express-session     | a `sessions` table                        |
| Next.js / React     | server-rendered HTML                       |

Nothing is compiled and nothing is downloaded. Deploying means copying files.

## Requirements

- **Node.js 22.5 or newer** — `node:sqlite` was added in 22.5. On older versions the
  app will not start.

## Configuration

All optional. The defaults suit a standard deploy.

| Variable         | Default            | Purpose                              |
| ---------------- | ------------------ | ------------------------------------ |
| `PORT`           | `3000`             | Port to listen on                    |
| `HOST`           | `0.0.0.0`          | Interface to bind                    |
| `CRM_DATA_DIR`   | `./data`           | Where `crm.db` is kept               |
| `COOKIE_SECURE`  | off                | Set to `1` when serving over HTTPS   |

## Modules

Five modules ship with the app and are installed automatically on first boot:

- **Human Resources** — departments, employees, leave requests
- **Payroll** — salary structures, pay runs, payslips
- **Accounting** — accounts, invoices, payments
- **CRM** — customers, leads, deals
- **Rental** — assets, rentals

A module is **data, not code**. Each one is a `manifest.json` describing its resources
and fields, and the generic CRUD engine serves all of them. To add a module, add a
folder:

```
src/modules/<your-module>/manifest.json
```

Its tables are created the next time the app starts, and it appears under **Modules**
ready to install. No routes to write.

### Field types

`text`, `textarea`, `select` (needs `options`), `date`, `number`, `money`, `bool`.

Set `required: true` to make a field mandatory, and `default` to set a starting value.

## Roles

| Role      | Can do                                              |
| --------- | --------------------------------------------------- |
| `admin`   | Everything, plus users, audit log, module management |
| `manager` | Create, edit and delete records                      |
| `staff`   | Read only                                            |

Access control is enforced on the server for every request, not just hidden in the UI.

## Accounts

Three accounts are created on first boot. **They are public knowledge — change the
passwords immediately** under **Profile**, or from **Users** if you are an admin.

| Username  | Password     | Role    |
| --------- | ------------ | ------- |
| `admin`   | `admin123`   | admin   |
| `manager` | `manager123` | manager |
| `staff`   | `staff123`   | staff   |

## Data

Everything lives in a single SQLite file at `CRM_DATA_DIR/crm.db`. Back that file up
and you have backed up the whole system.

The app initialises itself on boot: tables are created if missing and the default
accounts are added **only when the users table is empty**. Restarting never duplicates
data, and never overwrites what is already there.

## Deploying

1. Copy the project to the server (FTP, git, or a file manager).
2. Do **not** copy `data/` — it holds the live database. Leave an existing one alone.
3. Make sure Node 22.5+ is selected for the application.
4. Set the startup file to `server.js` and restart.

The app answers every response with an `X-App-Build` header, so you can confirm which
version is actually running:

```bash
curl -sI https://your-host/ | grep -i x-app-build
```

If that shows an old value, the process has not restarted yet — old code keeps being
served until it does.

### Health check

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/login
```

`200` means the app is up. `503` means no process is listening — the app is not
running, regardless of what the files look like.

## Licence

Proprietary. © Studio Pro.
