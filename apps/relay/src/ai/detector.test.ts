import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHudFrame } from '@pact/shared';
import {
  chunkDocumentText,
  syncSessionDocuments,
  queryTopDocChunks,
} from '../notion/indexer.js';
import {
  passesPreFilterGate,
  hasVerifiableTerms,
  detectContradiction,
  analyzeUtterance,
} from './detector.js';

describe('Notion Context Indexer & Contradiction Radar', () => {
  it('chunks documents around 350 chars with overlap on word boundaries', () => {
    const longDoc = Array.from(
      { length: 12 },
      (_, i) => `Clause ${i + 1}: Partner revenue share cap is fixed at 10% across enterprise deals.`
    ).join(' ');
    const chunks = chunkDocumentText(longDoc, 350, 60);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      assert.ok(c.length <= 350, `Expected chunk <= 350 chars, got ${c.length}`);
    }
  });

  it('fast Pre-Filter Gate rejects backchannels, filler, and under-4-word utterances', () => {
    assert.equal(passesPreFilterGate('yeah'), false);
    assert.equal(passesPreFilterGate('right'), false);
    assert.equal(passesPreFilterGate('sounds good'), false);
    assert.equal(passesPreFilterGate('okay got it'), false);
    assert.equal(
      passesPreFilterGate('Since we agreed on a 15% revenue share cap for enterprise'),
      true
    );
  });

  it('syncs a Notion SOW and detects the 15% vs 10% revenue share cap contradiction while ignoring casual banter', async () => {
    const sessionId = 'test-sow-session-01';
    const syncRes = await syncSessionDocuments({
      sessionId,
      customDocs: [
        {
          id: 'sow-page-1',
          title: 'SOW',
          content:
            'Enterprise Statement of Work. Commercial Terms: 10% revenue share cap across all tiers. Schedule: Delivery: Q1.',
        },
      ],
    });

    assert.equal(syncRes.pagesSynced, 1);
    assert.ok(syncRes.chunksStored >= 1);

    // 1. Casual banter triggers zero false alerts
    const banterUtterances = [
      'yeah right totally',
      'We are really excited to partner with your engineering team this quarter.',
      'Let us grab coffee in Dubai after the keynote presentation.',
    ];

    for (const text of banterUtterances) {
      const topChunks = hasVerifiableTerms(text)
        ? await queryTopDocChunks(sessionId, text, 3)
        : [];
      const res = await detectContradiction({
        utterance: {
          id: 'u-banter',
          sessionId,
          text,
          speakerLabel: 'Counterparty (G2)',
          speakerRole: 'other',
          isFinal: true,
          timestamp: Date.now(),
        },
        recentUtterances: [],
        topChunks,
      });
      assert.equal(res.type, 'none', `Expected 'none' for banter "${text}", got ${res.type}`);
    }

    // 2. Spoken contradiction: "Since we agreed on a 15% revenue share cap..."
    const claimText = 'Since we agreed on a 15% revenue share cap for this deal...';
    assert.equal(passesPreFilterGate(claimText), true);
    assert.equal(hasVerifiableTerms(claimText), true);

    const matchedChunks = await queryTopDocChunks(sessionId, claimText, 3);
    assert.ok(matchedChunks.length >= 1);

    const conflictRes = await detectContradiction({
      utterance: {
        id: 'u-conflict',
        sessionId,
        text: claimText,
        speakerLabel: 'Counterparty (G2)',
        speakerRole: 'other',
        isFinal: true,
        timestamp: Date.now(),
      },
      recentUtterances: [],
      topChunks: matchedChunks,
    });

    assert.equal(conflictRes.type, 'conflict');
    assert.ok(conflictRes.confidence >= 0.85);
    assert.equal(conflictRes.docTitle, 'SOW');
    assert.equal(conflictRes.docFact, '10% rev-share');
    assert.equal(conflictRes.spokenClaim, '15% rev-share');

    const hudFrame = formatHudFrame({
      state: 'CONFLICT',
      docTitle: conflictRes.docTitle,
      docFact: conflictRes.docFact,
      spokenClaim: conflictRes.spokenClaim,
    });

    assert.deepEqual(hudFrame.lines, [
      '! CONFLICT · SOW',
      'Doc: 10% rev-share',
      'Said: 15% rev-share',
    ]);
  });

  it('extracts verbal commitments (pact) using G2 speakerRole (self -> Me, other -> Counterparty) while rejecting questions', async () => {
    const selfPact = await analyzeUtterance({
      utterance: {
        id: 'u-pact-self',
        sessionId: 'sess-pact',
        text: 'I will send the revised cap table PDF by Friday 5pm.',
        speakerLabel: 'Self (G2 · S0)',
        speakerRole: 'self',
        isFinal: true,
        timestamp: Date.now(),
      },
      recentUtterances: [],
      topChunks: [],
    });

    assert.equal(selfPact.type, 'pact');
    if (selfPact.type === 'pact') {
      assert.ok(selfPact.confidence >= 0.82);
      assert.equal(selfPact.owner, 'Me');
      assert.ok(selfPact.title.length <= 26);
      assert.ok(selfPact.dueText.length <= 12);
    }

    const otherPact = await analyzeUtterance({
      utterance: {
        id: 'u-pact-other',
        sessionId: 'sess-pact',
        text: 'We will deliver the security audit report by Tuesday.',
        speakerLabel: 'Counterparty (G2 · S1)',
        speakerRole: 'other',
        isFinal: true,
        timestamp: Date.now(),
      },
      recentUtterances: [],
      topChunks: [],
    });

    assert.equal(otherPact.type, 'pact');
    if (otherPact.type === 'pact') {
      assert.equal(otherPact.owner, 'Counterparty');
    }

    const questionRes = await analyzeUtterance({
      utterance: {
        id: 'u-question',
        sessionId: 'sess-pact',
        text: 'Will you send the revised cap table PDF by Friday?',
        speakerLabel: 'Self (G2)',
        speakerRole: 'self',
        isFinal: true,
        timestamp: Date.now(),
      },
      recentUtterances: [],
      topChunks: [],
    });
    assert.equal(questionRes.type, 'none');
  });
});
