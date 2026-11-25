import type { PactRecord } from '@pact/shared';

export interface VirtualNotionLedgerRow {
  pageId: string;
  pactId: string;
  title: string;
  owner: string;
  due: string;
  status: 'Pending' | 'Locked' | 'Declined';
  sourceQuote: string;
  sessionId: string;
  confirmedBy?: string;
  updatedAt: string;
}

const virtualLedgerRows = new Map<string, VirtualNotionLedgerRow>();

export function getVirtualLedgerRows(): VirtualNotionLedgerRow[] {
  return [...virtualLedgerRows.values()];
}

function getNotionBaseUrl(): string {
  return (process.env.NOTION_API_BASE_URL || 'https://api.notion.com').replace(/\/+$/, '');
}

/**
 * Creates a Notion Pact Ledger database row (`POST /v1/pages`) with:
 * Title, Owner, Due, Status: "Pending", Source Quote, and Session ID.
 * Falls back cleanly to an in-memory ledger row if Notion keys are not configured.
 */
export async function createNotionPactLedgerRow(
  pact: PactRecord
): Promise<{ notionPageId: string; simulated: boolean }> {
  const notionKey = process.env.NOTION_API_KEY?.trim();
  const databaseId = process.env.NOTION_PACT_LEDGER_DB_ID?.trim();

  if (notionKey && databaseId) {
    const res = await fetch(`${getNotionBaseUrl()}/v1/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          Title: {
            title: [{ text: { content: pact.title } }],
          },
          Owner: {
            rich_text: [{ text: { content: pact.owner } }],
          },
          Due: {
            rich_text: [{ text: { content: pact.dueText } }],
          },
          Status: {
            select: { name: 'Pending' },
          },
          'Source Quote': {
            rich_text: [{ text: { content: pact.sourceQuote.slice(0, 1900) } }],
          },
          'Session ID': {
            rich_text: [{ text: { content: pact.sessionId } }],
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion create row failed (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id: string };
    const pageId = String(data.id);

    virtualLedgerRows.set(pageId, {
      pageId,
      pactId: pact.id,
      title: pact.title,
      owner: pact.owner,
      due: pact.dueText,
      status: 'Pending',
      sourceQuote: pact.sourceQuote,
      sessionId: pact.sessionId,
      updatedAt: new Date().toISOString(),
    });

    return { notionPageId: pageId, simulated: false };
  }

  const simulatedId = `notion-ledger-${pact.id.slice(0, 8)}`;
  virtualLedgerRows.set(simulatedId, {
    pageId: simulatedId,
    pactId: pact.id,
    title: pact.title,
    owner: pact.owner,
    due: pact.dueText,
    status: 'Pending',
    sourceQuote: pact.sourceQuote,
    sessionId: pact.sessionId,
    updatedAt: new Date().toISOString(),
  });

  return { notionPageId: simulatedId, simulated: true };
}

/**
 * Patches an existing Notion Pact Ledger row (`PATCH /v1/pages/{pageId}`)
 * to Status = "Locked" or "Declined", along with Confirmed By handle + timestamp.
 */
export async function patchNotionPactLedgerStatus(params: {
  notionPageId: string;
  status: 'Locked' | 'Declined';
  confirmedBy: string;
}): Promise<boolean> {
  const { notionPageId, status, confirmedBy } = params;
  const formattedHandle = confirmedBy.startsWith('@') ? confirmedBy : `@${confirmedBy}`;
  const nowIso = new Date().toISOString();

  const existingVirtual = virtualLedgerRows.get(notionPageId);
  if (existingVirtual) {
    existingVirtual.status = status;
    existingVirtual.confirmedBy = formattedHandle;
    existingVirtual.updatedAt = nowIso;
  }

  const notionKey = process.env.NOTION_API_KEY?.trim();
  const databaseId = process.env.NOTION_PACT_LEDGER_DB_ID?.trim();

  if (!notionKey || !databaseId || notionPageId.startsWith('notion-ledger-')) {
    return true;
  }

  const res = await fetch(`${getNotionBaseUrl()}/v1/pages/${notionPageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${notionKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        Status: {
          select: { name: status },
        },
        'Confirmed By': {
          rich_text: [{ text: { content: `${formattedHandle} (${nowIso})` } }],
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[Notion Ledger] PATCH ${notionPageId} warning (${res.status}): ${errText}`);
    return false;
  }

  return true;
}
