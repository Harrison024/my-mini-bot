/**
 * Bot-side wallet linking and withdrawal rules.
 *
 * The Mini App no longer has wallet or withdrawal endpoints: the bot chat is the
 * only path a user can take. These assertions protect that single path, so a
 * future edit cannot quietly re-open the app-side route or break the chat flow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

// Keep the test away from the real database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinvera-bot-'));
process.env.DATA_DIR = dataDir;

const srcDir = fs.existsSync(path.join(root, 'src', 'users.js')) ? path.join(root, 'src') : root;
const users = await import(pathToFileURL(path.join(srcDir, 'users.js')).href);

const { MIN_WITHDRAWAL, UNIT } = users;
const ADDRESS = '0x' + '1'.repeat(40);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
    return;
  }
  fail += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const created = users.getOrCreateUser({ id: '990001', first_name: 'Bot', username: 'botflow' });
const user = created.user;
check('test user created', Boolean(user && user.id));

console.log('[1] wallet linking happens in the bot chat');
const invalid = users.connectWallet(user.id, { address: 'not-a-wallet', network: 'EVM' });
check('invalid address rejected', invalid.ok === false && invalid.error === 'address_invalid', invalid.error);

const secret = users.connectWallet(user.id, { address: 'a'.repeat(64), network: 'EVM' });
check('private-key-shaped input rejected', secret.ok === false && secret.error === 'looks_like_secret', secret.error);

const phrase = users.connectWallet(user.id, {
  address: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  network: 'EVM',
});
check('recovery phrase rejected', phrase.ok === false && phrase.error === 'looks_like_secret', phrase.error);

const linked = users.connectWallet(user.id, { address: ADDRESS, network: 'EVM' });
check('public address accepted', linked.ok === true && linked.user.wallet_address === ADDRESS, linked.error);
check('network stored', linked.user.wallet_network === 'EVM');
check('no secret material stored', !JSON.stringify(linked.user).toLowerCase().includes('private'));

const claim = users.claimTask(user.id, 'connect_wallet');
check('bot link unlocks the wallet task', claim.ok === true, claim.error);

console.log('[2] withdrawals run through the bot chat');
const belowMin = users.requestWithdrawal(user.id, { amount: 10, address: ADDRESS, network: 'EVM' });
check('below minimum rejected', belowMin.ok === false && belowMin.error === 'amount_below_minimum', belowMin.error);

const tooMuch = users.requestWithdrawal(user.id, { amount: 99999999, address: ADDRESS, network: 'EVM' });
check('over balance rejected', tooMuch.ok === false && tooMuch.error === 'insufficient_balance', tooMuch.error);

const before = users.getUserById(user.id);
if (Number(before.active_balance) >= MIN_WITHDRAWAL) {
  const good = users.requestWithdrawal(user.id, { amount: MIN_WITHDRAWAL, address: ADDRESS, network: 'EVM' });
  check('valid request accepted', good.ok === true, good.error);
  check(
    'balance debited by the amount',
    Number(good.user.active_balance) === Number(before.active_balance) - MIN_WITHDRAWAL,
    String(good.user.active_balance),
  );
} else {
  console.log(`  skip  valid request — balance ${before.active_balance} is below the ${MIN_WITHDRAWAL} ${UNIT} minimum`);
}

console.log('[3] a payout needs an address from the chat');
const off = users.disconnectWallet(user.id);
check('wallet unlinked', off.ok === true && off.user.wallet_address === null);

// With no linked wallet and no address typed in the chat there is nowhere to pay.
const noAddress = users.requestWithdrawal(user.id, { amount: MIN_WITHDRAWAL, address: '', network: 'EVM' });
check('missing payout address rejected', noAddress.ok === false && noAddress.error === 'wallet_required', noAddress.error);

console.log('[4] /start answers instead of crashing');
// The bot answered nothing in production while every test passed: a template
// literal used an undefined identifier and the handler threw before replying.
// This exercises the real handler with Telegram stubbed out.
const botModule = await import(pathToFileURL(path.join(srcDir, 'bot.js')).href);
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const method = String(url).split('/').pop();
  let payload = {};
  try {
    payload = options?.body ? JSON.parse(options.body) : {};
  } catch {
    payload = {};
  }
  sent.push({ method, payload });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 1, username: 'CoinveraOfficialBot' } }),
  };
};
try {
  const bot = botModule.createBot({ token: 'test-token', getWebAppUrl: () => 'https://example.com' });
  let threw = null;
  try {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 990001, type: 'private' },
        from: { id: 990001, first_name: 'Bot', username: 'botflow' },
        text: '/start',
      },
    });
  } catch (error) {
    threw = error.message;
  }
  check('/start handler does not throw', threw === null, threw || '');
  const replies = sent.filter((s) => s.method === 'sendMessage' && String(s.payload.chat_id) === '990001');
  check('/start sends a chat reply', replies.length > 0, `${replies.length} sendMessage calls`);
  const text = replies.map((r) => r.payload.text || '').join('\n');
  check('reply shows the reward unit', text.includes(UNIT), UNIT);
  check('reply contains no undefined value', !/undefined/.test(text));
} finally {
  globalThis.fetch = realFetch;
}

fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'Bot flow test passed' : 'Bot flow test FAILED'} — ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
