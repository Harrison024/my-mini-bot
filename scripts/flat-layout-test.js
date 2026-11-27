/**
 * Regression test: the app must start from a flat checkout where the modules
 * sit next to server.js (some hosts and older copies of the repo look like
 * that), not only from the documented src/ + public/ layout.
 *
 * It copies server.js and the modules into a temp directory in the flat shape,
 * boots the real server there and checks the API and the Mini App shell answer.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.FLAT_PORT || 3488);
const BASE = `http://127.0.0.1:${PORT}`;
const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinvera-flat-'));

// Point DATA_DIR outside the checkout before importing the app modules, so
// src/db.js does not create data/ in the repository while the test runs.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coinvera-flat-unit-'));
const { UNIT } = await import(pathToFileURL(path.join(rootDir, 'src', 'users.js')).href);

const files = [
  ['server.js', 'server.js'],
  ['src/auth.js', 'auth.js'],
  ['src/db.js', 'db.js'],
  ['src/users.js', 'users.js'],
  ['src/bot.js', 'bot.js'],
  ['public/index.html', 'index.html'],
  ['public/styles.css', 'styles.css'],
  ['public/app.js', 'app.js'],
];

for (const [from, to] of files) {
  fs.copyFileSync(path.join(rootDir, from), path.join(flatDir, to));
}

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: flatDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(flatDir, 'data'),
    BOT_TOKEN: '',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

async function waitForServer(deadlineMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (server.exitCode !== null) return false;
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function stop() {
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(flatDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  console.log('\n[flat layout] no src/ or public/ directories next to server.js');
  const ready = await waitForServer();
  if (!ready) {
    console.error('server did not start from a flat checkout:\n' + serverLog.join(''));
    stop();
    process.exit(1);
  }
  check('server starts without ERR_MODULE_NOT_FOUND', true);
  check('no module-not-found in the log', !serverLog.join('').includes('ERR_MODULE_NOT_FOUND'));

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  check('health responds 200', health.status === 200, `status ${health.status}`);
  check('health reports the configured unit', healthBody.unit === UNIT, String(healthBody.unit));

  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('Mini App shell served from the flat root', page.status === 200 && html.includes('COINVERA'));

  const session = await fetch(`${BASE}/api/session`);
  const sessionBody = await session.json().catch(() => ({}));
  check('session works in flat mode', session.status === 200 && Boolean(sessionBody.user?.telegramId));
} catch (error) {
  failures.push(`unexpected error: ${error.message}`);
  console.error(error);
} finally {
  stop();
}

if (failures.length) {
  console.error('\nFailures:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nFlat-layout start test passed.');
process.exit(0);
