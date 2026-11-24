import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHudFrame,
  truncateLine,
  HUD_MAX_CHARS_PER_LINE,
  HUD_MAX_LINES,
  type HudPayload,
} from './hud.js';

describe('formatHudFrame & truncateLine', () => {
  it('truncates lines cleanly at word boundaries and never exceeds 28 chars', () => {
    const short = truncateLine('10% rev-share');
    assert.equal(short, '10% rev-share');

    const exact28 = '1234567890123456789012345678';
    assert.equal(truncateLine(exact28), exact28);
    assert.equal(truncateLine(exact28).length, 28);

    const longSentence = 'Send updated Q3 financial model and deck by Friday noon';
    const truncated = truncateLine(longSentence, 28);
    assert.ok(truncated.length <= 28, `Expected <= 28 chars, got ${truncated.length}: "${truncated}"`);
    assert.ok(truncated.endsWith('…'));
  });

  it('formats State 1: DARK_IDLE correctly', () => {
    const frame = formatHudFrame({ state: 'DARK_IDLE' });
    assert.equal(frame.state, 'DARK_IDLE');
    assert.equal(frame.isDim, true);
    assert.deepEqual(frame.lines, ['PACT · ACTIVE', '', '']);
    assert.equal(frame.text, 'PACT · ACTIVE\n\n');
  });

  it('formats State 2: CONFLICT within 3x28 limits', () => {
    const frame = formatHudFrame({
      state: 'CONFLICT',
      docTitle: 'SOW',
      docFact: '10% rev-share',
      spokenClaim: '15% rev-share',
    });
    assert.equal(frame.isDim, false);
    assert.deepEqual(frame.lines, [
      '! CONFLICT · SOW',
      'Doc: 10% rev-share',
      'Said: 15% rev-share',
    ]);
    for (const line of frame.lines) {
      assert.ok(line.length <= HUD_MAX_CHARS_PER_LINE);
    }
  });

  it('formats State 3: PACT_DRAFT within 3x28 limits', () => {
    const frame = formatHudFrame({
      state: 'PACT_DRAFT',
      title: 'Send revised cap table PDF',
      owner: 'Me',
      dueText: 'Fri 5pm',
    });
    assert.deepEqual(frame.lines, [
      'PACT? [TAP: LOCK]',
      'Send revised cap table PDF',
      'Me · Fri 5pm',
    ]);
    for (const line of frame.lines) {
      assert.ok(line.length <= HUD_MAX_CHARS_PER_LINE);
    }
  });

  it('formats State 4: SENT_PENDING within 3x28 limits', () => {
    const frame = formatHudFrame({
      state: 'SENT_PENDING',
      title: 'Send revised cap table PDF',
    });
    assert.deepEqual(frame.lines, [
      'SENT TO TG + NOTION',
      'Awaiting TG tap...',
      'Send revised cap table PDF',
    ]);
    for (const line of frame.lines) {
      assert.ok(line.length <= HUD_MAX_CHARS_PER_LINE);
    }
  });

  it('formats State 5: LOCKED_PULSE within 3x28 limits', () => {
    const frame = formatHudFrame({
      state: 'LOCKED_PULSE',
      title: 'Send revised cap table PDF',
      confirmedBy: '@alex_vc',
    });
    assert.deepEqual(frame.lines, [
      '✓ PACT LOCKED',
      'Send revised cap table PDF',
      'By @alex_vc · Saved',
    ]);
    for (const line of frame.lines) {
      assert.ok(line.length <= HUD_MAX_CHARS_PER_LINE);
    }
  });

  it('strictly caps overflowing inputs across all 5 states to 3 lines x 28 chars', () => {
    const payloads: HudPayload[] = [
      {
        state: 'DARK_IDLE',
        subtitle: 'A very long status message that exceeds twenty eight characters easily',
      },
      {
        state: 'CONFLICT',
        docTitle: 'Master Services Agreement 2026 Enterprise Appendix B',
        docFact: '10% revenue share cap across all enterprise tiers in Q1/Q2',
        spokenClaim: '15% uncapped revenue share starting immediately in Q1',
      },
      {
        state: 'PACT_DRAFT',
        title: 'Deliver complete audited security penetration test report to client',
        owner: 'CounterpartyRepresentative',
        dueText: 'Next Wednesday EOD',
      },
      {
        state: 'SENT_PENDING',
        title: 'Deliver complete audited security penetration test report to client',
      },
      {
        state: 'LOCKED_PULSE',
        title: 'Deliver complete audited security penetration test report to client',
        confirmedBy: '@very_long_telegram_username_12345',
      },
    ];

    for (const payload of payloads) {
      const frame = formatHudFrame(payload);
      const splitLines = frame.text.split('\n');
      assert.equal(splitLines.length, HUD_MAX_LINES, `State ${payload.state} must have 3 lines`);
      for (let i = 0; i < frame.lines.length; i++) {
        const line = frame.lines[i]!;
        assert.ok(
          line.length <= HUD_MAX_CHARS_PER_LINE,
          `State ${payload.state} line ${i + 1} exceeded 28 chars (${line.length}): "${line}"`
        );
      }
    }
  });
});
