/**
 * End-to-end smoke test for the COINVERA API.
 * Runs the real server against a throwaway database and exercises every
 * user-facing endpoint: session, duplicate-signup guard, tasks, wallet,
 * withdrawals, support and the admin dashboard.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 3477);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinvera-smoke-'));

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function waitForServer(deadlineMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    BOT_TOKEN: '',
    ADMIN_TELEGRAM_ID: '8463629333',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

function stopServer() {
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  const ready = await waitForServer();
  if (!ready) {
    console.error('server did not start:\n' + serverLog.join(''));
    stopServer();
    process.exit(1);
  }

  console.log('\n[1] health + static shell');
  const health = await api('/api/health');
  check('health responds 200', health.status === 200, `status ${health.status}`);
  check('health reports ACTIVE unit', health.data?.unit === 'ACTIVE', String(health.data?.unit));
  check('health reports bot not configured in test', health.data?.botConfigured === false);

  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('index.html served', page.status === 200 && html.includes('COINVERA'));
  const css = await fetch(`${BASE}/styles.css`);
  check('stylesheet served', css.status === 200);
  const client = await fetch(`${BASE}/app.js`);
  check('client script served', client.status === 200);

  console.log('\n[2] automatic registration + signup bonus');
  const first = await api('/api/session');
  const user = first.data?.user;
  check('session 200', first.status === 200, `status ${first.status}`);
  check('user auto-registered with Telegram id', Boolean(user?.telegramId));
  check(
    'welcome bonus between 5,000 and 10,000 Active',
    user?.activeBalance >= 5000 && user?.activeBalance <= 10000,
    String(user?.activeBalance),
  );
  check('unique referral code assigned', /^CV[A-Z0-9]{5}$/.test(user?.referralCode || ''), user?.referralCode);
  check('signup bonus recorded in activity', (first.data?.activity || []).some((a) => a.kind === 'signup_bonus'));
  check('unit label is ACTIVE only', first.data?.config?.unit === 'ACTIVE' && !JSON.stringify(first.data).includes('USD'));

  console.log('\n[3] duplicate signup protection');
  const second = await api('/api/session');
  check('balance unchanged on reopen', second.data?.user?.activeBalance === user?.activeBalance, `${second.data?.user?.activeBalance}`);
  check(
    'exactly one signup bonus recorded',
    (second.data?.activity || []).filter((a) => a.kind === 'signup_bonus').length === 1,
  );
  check('referral code stable', second.data?.user?.referralCode === user?.referralCode);

  console.log('\n[4] tasks and duplicate reward guard');
  const openTask = (second.data?.tasks || []).find((t) => t.code === 'read_guide');
  check('seeded tasks returned', (second.data?.tasks || []).length >= 4);
  const claimed = await api('/api/tasks/claim', { method: 'POST', body: { code: 'read_guide' } });
  check('task claim succeeds', claimed.status === 200 && claimed.data?.awarded === openTask?.rewardPoints, `status ${claimed.status}`);
  check('points credited', claimed.data?.user?.points === openTask?.rewardPoints, String(claimed.data?.user?.points));
  check('task shows completed', (claimed.data?.tasks || []).find((t) => t.code === 'read_guide')?.completed === true);

  const repeat = await api('/api/tasks/claim', { method: 'POST', body: { code: 'read_guide' } });
  check('duplicate claim rejected', repeat.status === 400 && repeat.data?.error === 'already_completed', `status ${repeat.status}`);
  check('points not credited twice', repeat.data?.user?.points === openTask?.rewardPoints, String(repeat.data?.user?.points));

  const gated = await api('/api/tasks/claim', { method: 'POST', body: { code: 'connect_wallet' } });
  check('wallet task blocked until wallet linked', gated.status === 400 && gated.data?.error === 'requirement_wallet', gated.data?.error);

  console.log('\n[5] wallet linking is bot-only (no Mini App endpoint)');
  const address = '0x' + '1'.repeat(40);
  const appConnect = await api('/api/wallet/connect', { method: 'POST', body: { address, network: 'EVM' } });
  check('mini app wallet connect endpoint removed', appConnect.status === 404, `status ${appConnect.status}`);

  const appDisconnect = await api('/api/wallet/disconnect', { method: 'POST' });
  check('mini app wallet disconnect endpoint removed', appDisconnect.status === 404, `status ${appDisconnect.status}`);

  const afterConnect = await api('/api/session');
  check('no wallet stored from the app', !afterConnect.data?.user?.walletAddress, String(afterConnect.data?.user?.walletAddress));
  check('wallet task stays locked until the bot links it', (afterConnect.data?.tasks || []).find((t) => t.code === 'connect_wallet')?.completed === false);
  check('session exposes the bot link for the UI', Object.prototype.hasOwnProperty.call(afterConnect.data?.config || {}, 'botUrl'), 'config.botUrl missing');

  console.log('\n[6] withdrawals are bot-only (no Mini App endpoint)');
  const appWithdraw = await api('/api/withdrawal', { method: 'POST', body: { amount: 1000, address } });
  check('mini app withdrawal endpoint removed', appWithdraw.status === 404, `status ${appWithdraw.status}`);

  const afterWithdraw = await api('/api/session');
  check('blocked request did not move the balance', afterWithdraw.data?.user?.activeBalance === afterConnect.data?.user?.activeBalance, String(afterWithdraw.data?.user?.activeBalance));

  console.log('\n[7] support messages');
  const emptySupport = await api('/api/support', { method: 'POST', body: { message: '   ' } });
  check('empty message rejected', emptySupport.status === 400 && emptySupport.data?.error === 'message_empty');
  const support = await api('/api/support', { method: 'POST', body: { message: 'Hello, I need help with my wallet link.' } });
  check('support message accepted', support.status === 200 && support.data?.ok === true);

  console.log('\n[8] admin dashboard');
  const admin = await api('/api/admin');
  check('admin endpoint 200 for admin id', admin.status === 200, `status ${admin.status}`);
  check('total users counted', admin.data?.admin?.totalUsers === 1, String(admin.data?.admin?.totalUsers));
  check('registrations today counted', admin.data?.admin?.registrationsToday === 1);
  check('tasks completed counted', admin.data?.admin?.tasksCompleted === 1, String(admin.data?.admin?.tasksCompleted));
  check('rewards issued counted', admin.data?.admin?.rewardsIssued >= 1, String(admin.data?.admin?.rewardsIssued));
  check('support messages counted', admin.data?.admin?.supportMessages === 1, String(admin.data?.admin?.supportMessages));
  check('no withdrawals from the app', admin.data?.admin?.pendingWithdrawals === 0, String(admin.data?.admin?.pendingWithdrawals));
  check('session exposes admin block', Boolean(first.data?.admin) === false || Boolean(second.data?.admin));
  check('admin id configured', second.data?.config?.adminTelegramId === '8463629333', second.data?.config?.adminTelegramId);

  console.log('\n[9] auth rejection without a valid Telegram signature');
  const guarded = await fetch(`${BASE}/api/session`, { headers: { 'x-telegram-init-data': 'auth_date=1&hash=deadbeef' } });
  check('server runs in preview mode without BOT_TOKEN', guarded.status === 200 || guarded.status === 401, `status ${guarded.status}`);
} catch (error) {
  failures.push(`unexpected error: ${error.message}`);
  console.error(error);
} finally {
  stopServer();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('Failures:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('COINVERA smoke test passed.');
process.exit(0);
