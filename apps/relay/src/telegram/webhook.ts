import type http from 'node:http';
import { updatePactRecord } from '../db/supabase.js';
import { patchNotionPactLedgerStatus } from '../notion/ledger.js';
import { answerTelegramCallbackQuery, editTelegramPactCard } from './bot.js';
import { getSessionStateMachines } from '../hud/stateMachine.js';

export interface TelegramCallbackQueryPayload {
  update_id?: number;
  callback_query?: {
    id: string;
    from?: {
      id?: number;
      username?: string;
      first_name?: string;
    };
    message?: {
      message_id: number;
      chat?: {
        id: number | string;
      };
    };
    data?: string;
  };
}

export interface WebhookResult {
  statusCode: number;
  body: Record<string, unknown>;
}

/**
 * Handles `POST /webhooks/telegram`:
 * 1. Validates `X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is configured.
 * 2. Immediately calls `answerCallbackQuery`.
 * 3. On `lock:<pactId>`: updates Supabase (`status='locked'`, `confirmed_by`, `locked_at`),
 *    patches Notion (`Status: "Locked"`, `Confirmed By: @username`), edits Telegram message
 *    (`✓ LOCKED by @username`), and pushes `LOCKED_PULSE` over WebSocket to G2 HUD (3s auto-fade).
 * 4. On `decline:<pactId>`: marks Declined in Supabase + Notion, edits Telegram card, notifies HUD briefly.
 */
export async function processTelegramWebhook(
  headers: http.IncomingHttpHeaders,
  payload: TelegramCallbackQueryPayload
): Promise<WebhookResult> {
  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (configuredSecret) {
    const incomingSecretRaw = headers['x-telegram-bot-api-secret-token'];
    const incomingSecret = Array.isArray(incomingSecretRaw)
      ? incomingSecretRaw[0]
      : incomingSecretRaw;
    if (incomingSecret !== configuredSecret) {
      return {
        statusCode: 401,
        body: { ok: false, error: 'Invalid X-Telegram-Bot-Api-Secret-Token' },
      };
    }
  }

  const cb = payload.callback_query;
  if (!cb || !cb.data) {
    return {
      statusCode: 200,
      body: { ok: true, ignored: true },
    };
  }

  const [action, pactId] = cb.data.split(':');
  if (!pactId || (action !== 'lock' && action !== 'decline')) {
    await answerTelegramCallbackQuery(cb.id, 'Unrecognized action');
    return {
      statusCode: 200,
      body: { ok: true, ignored: true },
    };
  }

  const rawHandle = cb.from?.username || cb.from?.first_name || 'counterparty';
  const cleanHandle = rawHandle.replace(/^@+/, '').trim();
  const formattedHandle = `@${cleanHandle}`;

  // Immediately acknowledge Telegram callback query so inline button spinner stops right away
  void answerTelegramCallbackQuery(
    cb.id,
    action === 'lock' ? `Pact locked by ${formattedHandle}` : `Pact declined by ${formattedHandle}`
  );

  const isLock = action === 'lock';
  const nextStatus = isLock ? 'locked' : 'declined';
  const lockedAt = isLock ? new Date().toISOString() : null;

  const updatedPact = await updatePactRecord(pactId, {
    status: nextStatus,
    confirmedBy: formattedHandle,
    lockedAt,
  });

  if (!updatedPact) {
    return {
      statusCode: 404,
      body: { ok: false, error: `Pact ${pactId} not found` },
    };
  }

  const chatId = String(cb.message?.chat?.id ?? updatedPact.telegramChatId ?? '');
  const messageId = Number(cb.message?.message_id ?? updatedPact.telegramMessageId ?? 0);

  await Promise.all([
    updatedPact.notionPageId
      ? patchNotionPactLedgerStatus({
          notionPageId: updatedPact.notionPageId,
          status: isLock ? 'Locked' : 'Declined',
          confirmedBy: formattedHandle,
        })
      : Promise.resolve(true),
    chatId && messageId
      ? editTelegramPactCard({
          pact: updatedPact,
          chatId,
          messageId,
          status: nextStatus,
          confirmedBy: formattedHandle,
        })
      : Promise.resolve(true),
  ]);

  const machines = getSessionStateMachines(updatedPact.sessionId);
  for (const machine of machines) {
    machine.handleTelegramResolution(updatedPact, nextStatus, formattedHandle);
  }

  console.log(
    `[TELEGRAM WEBHOOK] ${isLock ? '✓ LOCKED' : '✕ DECLINED'} pact=${updatedPact.id} ("${updatedPact.title}") by ${formattedHandle}`
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      pactId: updatedPact.id,
      status: updatedPact.status,
      confirmedBy: formattedHandle,
    },
  };
}
