import type { PactRecord } from '@pact/shared';

export interface VirtualTelegramMessage {
  chatId: string;
  messageId: number;
  pactId: string;
  text: string;
  buttons: Array<{ text: string; callback_data: string }>;
  updatedAt: string;
}

let virtualMessageCounter = 1000;
const virtualTelegramMessages = new Map<string, VirtualTelegramMessage>();

export function getVirtualTelegramMessages(): VirtualTelegramMessage[] {
  return [...virtualTelegramMessages.values()];
}

function getTelegramApiBase(): string {
  const base = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '');
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  return `${base}/bot${token}`;
}

function hasTelegramToken(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function formatPactTelegramCardText(
  pact: PactRecord,
  resolution?: { status: 'locked' | 'declined'; confirmedBy: string }
): string {
  const handle = resolution?.confirmedBy
    ? resolution.confirmedBy.startsWith('@')
      ? resolution.confirmedBy
      : `@${resolution.confirmedBy}`
    : '';

  const statusLine = !resolution
    ? '⏳ Status: Pending Bilateral Confirmation'
    : resolution.status === 'locked'
      ? `✓ LOCKED by ${handle}`
      : `✕ DECLINED by ${handle}`;

  return [
    '🤝 PACT — Live Bilateral Commitment',
    '',
    `• Deliverable: ${pact.title}`,
    `• Owner: ${pact.owner}`,
    `• Due: ${pact.dueText}`,
    `• Quote: "${pact.sourceQuote}"`,
    '',
    statusLine,
  ].join('\n');
}

/**
 * Sends an interactive verification card (`POST /sendMessage`) to the linked Telegram group
 * with `[✓ Lock Pact]` (`lock:<pactId>`) and `[✕ Decline]` (`decline:<pactId>`) inline buttons.
 */
export async function sendTelegramPactCard(
  pact: PactRecord,
  overrideChatId?: string | null
): Promise<{ chatId: string; messageId: number; simulated: boolean }> {
  const chatId = (
    overrideChatId ||
    pact.telegramChatId ||
    process.env.TELEGRAM_DEFAULT_CHAT_ID ||
    '-100999888777'
  ).trim();

  const text = formatPactTelegramCardText(pact);
  const inlineRow = [
    { text: '✓ Lock Pact', callback_data: `lock:${pact.id}` },
    { text: '✕ Decline', callback_data: `decline:${pact.id}` },
  ];

  if (hasTelegramToken()) {
    const res = await fetch(`${getTelegramApiBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [inlineRow],
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Telegram sendMessage failed (HTTP ${res.status}): ${errBody}`);
    }

    const json = (await res.json()) as {
      ok: boolean;
      result?: { message_id: number };
    };
    const messageId = Number(json.result?.message_id ?? ++virtualMessageCounter);

    virtualTelegramMessages.set(`${chatId}:${messageId}`, {
      chatId,
      messageId,
      pactId: pact.id,
      text,
      buttons: inlineRow,
      updatedAt: new Date().toISOString(),
    });

    return { chatId, messageId, simulated: false };
  }

  const messageId = ++virtualMessageCounter;
  virtualTelegramMessages.set(`${chatId}:${messageId}`, {
    chatId,
    messageId,
    pactId: pact.id,
    text,
    buttons: inlineRow,
    updatedAt: new Date().toISOString(),
  });

  return { chatId, messageId, simulated: true };
}

/**
 * Immediately acknowledges a Telegram inline button press (`POST /answerCallbackQuery`).
 */
export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text: string
): Promise<void> {
  if (!hasTelegramToken() || !callbackQueryId) return;
  try {
    await fetch(`${getTelegramApiBase()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
  } catch (err) {
    console.warn('[Telegram] Non-fatal answerCallbackQuery warning:', err);
  }
}

/**
 * Edits an existing Telegram Pact verification card (`POST /editMessageText`)
 * to reflect `✓ LOCKED by @username` or `✕ DECLINED by @username` and clears inline buttons.
 */
export async function editTelegramPactCard(params: {
  pact: PactRecord;
  chatId: string;
  messageId: number;
  status: 'locked' | 'declined';
  confirmedBy: string;
}): Promise<boolean> {
  const { pact, chatId, messageId, status, confirmedBy } = params;
  const updatedText = formatPactTelegramCardText(pact, { status, confirmedBy });

  const key = `${chatId}:${messageId}`;
  const virtualMsg = virtualTelegramMessages.get(key);
  if (virtualMsg) {
    virtualMsg.text = updatedText;
    virtualMsg.buttons = [];
    virtualMsg.updatedAt = new Date().toISOString();
  }

  if (!hasTelegramToken()) {
    return true;
  }

  const res = await fetch(`${getTelegramApiBase()}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: updatedText,
      reply_markup: {
        inline_keyboard: [],
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[Telegram] editMessageText warning (${res.status}): ${errText}`);
    return false;
  }

  return true;
}

/**
 * Sends a verification ping message to a Telegram group chat ID from the companion setup UI.
 */
export async function sendTelegramTestPing(
  chatId: string
): Promise<{ ok: boolean; simulated: boolean; messageId: number }> {
  const trimmedChat = chatId.trim();
  if (!trimmedChat) {
    throw new Error('chatId is required');
  }

  if (!hasTelegramToken()) {
    return {
      ok: true,
      simulated: true,
      messageId: ++virtualMessageCounter,
    };
  }

  const res = await fetch(`${getTelegramApiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: trimmedChat,
      text: '🟢 PACT HUD linked — live bilateral commitment cards will appear in this chat.',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Telegram ping failed (HTTP ${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as { result?: { message_id?: number } };
  return {
    ok: true,
    simulated: false,
    messageId: Number(json.result?.message_id ?? ++virtualMessageCounter),
  };
}
