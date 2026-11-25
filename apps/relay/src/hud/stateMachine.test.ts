import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FormattedHudFrame, HudPayload, PactRecord } from '@pact/shared';
import { SessionHudStateMachine } from './stateMachine.js';
import { processTelegramWebhook } from '../telegram/webhook.js';
import { getVirtualLedgerRows } from '../notion/ledger.js';
import { getVirtualTelegramMessages } from '../telegram/bot.js';

describe('SessionHudStateMachine & Telegram Bilateral Write Loop', () => {
  it('enforces 20s semantic dedupe cooldown, single-tap Notion+Telegram write, webhook secret validation, and 3s LOCKED_PULSE auto-fade', async () => {
    const renderedFrames: FormattedHudFrame[] = [];
    const pactUpdates: PactRecord[] = [];
    const sessionId = `test-bilateral-${Date.now()}`;

    const machine = new SessionHudStateMachine({
      sessionId,
      telegramChatId: '-100123456',
      dedupeCooldownMs: 20_000,
      autoFadeMs: 15_000,
      lockedPulseMs: 60, // fast 60ms pulse for deterministic unit test
      onHudFrame: (_payload: HudPayload, frame: FormattedHudFrame) => {
        renderedFrames.push(frame);
      },
      onPactUpdated: (pact) => {
        pactUpdates.push(pact);
      },
    });

    try {
      // 1. Trigger PACT_DRAFT
      const firstAccepted = await machine.handleDetection(
        {
          type: 'pact',
          confidence: 0.92,
          title: 'Send revised cap table PDF',
          owner: 'Me',
          dueText: 'Fri 5pm',
          sourceQuote: 'I will send the revised cap table PDF by Friday at 5pm.',
        },
        'self'
      );
      assert.equal(firstAccepted, true);
      assert.equal(machine.getState(), 'PACT_DRAFT');
      assert.deepEqual(renderedFrames.at(-1)?.lines, [
        'PACT? [TAP: LOCK]',
        'Send revised cap table PDF',
        'Me · Fri 5pm',
      ]);

      // 2. Duplicate within 20s cooldown is suppressed
      const duplicateAccepted = await machine.handleDetection(
        {
          type: 'pact',
          confidence: 0.93,
          title: 'Send revised cap table PDF',
          owner: 'Me',
          dueText: 'Fri 5pm',
          sourceQuote: 'I will send the revised cap table PDF by Friday 5pm.',
        },
        'self'
      );
      assert.equal(duplicateAccepted, false);

      // 3. Single tap -> immediately pushes SENT_PENDING, creates Notion row (Pending) & Telegram card
      const sentPact = await machine.handleSingleTap();
      assert.ok(sentPact);
      assert.equal(machine.getState(), 'SENT_PENDING');
      assert.equal(sentPact.status, 'pending');
      assert.ok(sentPact.notionPageId);
      assert.ok(sentPact.telegramMessageId);
      assert.deepEqual(renderedFrames.at(-1)?.lines, [
        'SENT TO TG + NOTION',
        'Awaiting TG tap...',
        'Send revised cap table PDF',
      ]);

      const ledgerRowPending = getVirtualLedgerRows().find((r) => r.pactId === sentPact.id);
      assert.equal(ledgerRowPending?.status, 'Pending');

      const tgCardPending = getVirtualTelegramMessages().find((m) => m.pactId === sentPact.id);
      assert.equal(tgCardPending?.buttons.length, 2);
      assert.equal(tgCardPending?.buttons[0]?.callback_data, `lock:${sentPact.id}`);

      // 4. Validate Telegram Webhook Secret Token check
      const prevSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      process.env.TELEGRAM_WEBHOOK_SECRET = 'super-secret-tg-token';

      const unauthorizedRes = await processTelegramWebhook(
        { 'x-telegram-bot-api-secret-token': 'wrong-token' },
        {
          callback_query: {
            id: 'cb-bad',
            data: `lock:${sentPact.id}`,
          },
        }
      );
      assert.equal(unauthorizedRes.statusCode, 401);

      // 5. Authorized lock:<pactId> webhook -> flips Notion & Telegram to Locked + pushes LOCKED_PULSE -> auto-fades to DARK_IDLE
      const lockRes = await processTelegramWebhook(
        { 'x-telegram-bot-api-secret-token': 'super-secret-tg-token' },
        {
          callback_query: {
            id: 'cb-good-1',
            from: { username: 'alex_vc' },
            message: {
              message_id: sentPact.telegramMessageId!,
              chat: { id: sentPact.telegramChatId! },
            },
            data: `lock:${sentPact.id}`,
          },
        }
      );
      process.env.TELEGRAM_WEBHOOK_SECRET = prevSecret;

      assert.equal(lockRes.statusCode, 200);
      assert.equal(machine.getState(), 'LOCKED_PULSE');
      assert.deepEqual(renderedFrames.at(-1)?.lines, [
        '✓ PACT LOCKED',
        'Send revised cap table PDF',
        'By @alex_vc · Saved',
      ]);

      const ledgerRowLocked = getVirtualLedgerRows().find((r) => r.pactId === sentPact.id);
      assert.equal(ledgerRowLocked?.status, 'Locked');
      assert.equal(ledgerRowLocked?.confirmedBy, '@alex_vc');

      const tgCardLocked = getVirtualTelegramMessages().find((m) => m.pactId === sentPact.id);
      assert.ok(tgCardLocked?.text.includes('✓ LOCKED by @alex_vc'));
      assert.equal(tgCardLocked?.buttons.length, 0);

      // Wait for 60ms LOCKED_PULSE auto-fade back to DARK_IDLE
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(machine.getState(), 'DARK_IDLE');
      assert.deepEqual(renderedFrames.at(-1)?.lines, ['PACT · ACTIVE', '', '']);
    } finally {
      machine.dispose();
    }
  });
});
