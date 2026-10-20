/**
 * Smoke test - checks that a running instance is healthy.
 *
 *   node scripts/smoke.mjs                        # against http://localhost:3000
 *   node scripts/smoke.mjs https://test.prostudio.my
 *
 * Exits non-zero on the first failure. It only reads, so it is safe to run
 * against a live deployment.
 */
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');

const PUBLIC_PATHS = ['/login', '/app.css'];

let failures = 0;

function pass(msg) { console.log(`  ok    ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures += 1; }

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return res;
}

console.log(`Smoke testing ${base}\n`);

// --- the app is up at all ---
console.log('Reachability');
try {
  const res = await get('/login');
  if (res.status === 200) pass('GET /login -> 200');
  else fail(`GET /login -> ${res.status} (expected 200)`);

  const build = res.headers.get('x-app-build');
  if (build) pass(`X-App-Build: ${build}`);
  else fail('X-App-Build header missing - old code that has not been restarted?');
} catch (err) {
  fail(`cannot reach ${base}: ${err.message}`);
  console.log('\nThe app is not responding. Check it is running, then retry.');
  process.exit(1);
}

// --- static assets ---
console.log('\nStatic assets');
for (const p of PUBLIC_PATHS) {
  try {
    const res = await get(p);
    if (res.status === 200) pass(`GET ${p} -> 200`);
    else fail(`GET ${p} -> ${res.status}`);
  } catch (err) {
    fail(`GET ${p} -> ${err.message}`);
  }
}

// --- protected pages must redirect when signed out, never 200 or 500 ---
console.log('\nAccess control');
for (const p of ['/dashboard', '/modules', '/admin/users']) {
  try {
    const res = await get(p);
    if (res.status === 303 || res.status === 302) pass(`GET ${p} -> redirect (signed out)`);
    else if (res.status === 200) fail(`GET ${p} -> 200 while signed out (should redirect)`);
    else fail(`GET ${p} -> ${res.status}`);
  } catch (err) {
    fail(`GET ${p} -> ${err.message}`);
  }
}

// --- traversal: a request for source must never be served ---
console.log('\nPath traversal');
for (const p of ['/../server.js', '/..%2fserver.js', '/../package.json']) {
  try {
    const res = await get(p);
    if (res.status === 200) fail(`GET ${p} -> 200 (source leaked!)`);
    else pass(`GET ${p} -> ${res.status} (not served)`);
  } catch (err) {
    pass(`GET ${p} -> rejected`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
