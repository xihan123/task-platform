import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chatApi } from '../lib/chat-api';
import { mergeMessages } from '../lib/chat-state';

const originalUrl = process.env.NEXT_PUBLIC_API_URL;
before(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test/api/';
});
after(() => {
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalUrl;
});

test('chat fetches history/catchup through HTTP with cookies and serializes explicit cursors', async (t) => {
  const calls: { url: URL; options: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls.push({ url, options });
    return Response.json({
      items: [],
      conversationId: 'conversation',
      olderCursor: null,
      newerCursor: null,
    });
  });
  const signal = new AbortController().signal;
  await chatApi.messages(
    'task-id',
    { after: 'message-id', limit: 100 },
    signal,
  );
  await chatApi.messages('task-id', { before: 'older-message' });
  await chatApi.send('task-id', { id: 'retry-id', content: 'Hello' });
  assert.equal(calls[0]!.url.pathname, '/api/tasks/task-id/messages');
  assert.equal(calls[0]!.url.searchParams.get('after'), 'message-id');
  assert.equal(calls[0]!.url.searchParams.get('limit'), '100');
  assert.equal(calls[0]!.options.signal, signal);
  assert.equal(calls[1]!.url.searchParams.get('before'), 'older-message');
  assert.equal(calls[2]!.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2]!.options.body)), {
    id: 'retry-id',
    content: 'Hello',
  });
  assert.equal(
    new Headers(calls[2]!.options.headers).get('X-CSRF-Protection'),
    '1',
  );
  for (const { options } of calls) {
    assert.equal(options.credentials, 'include');
    assert.equal(options.cache, 'no-store');
  }
});

test('HTTP reconciliation deduplicates retransmissions and preserves chronological order', () => {
  const earlier = {
    id: 'first',
    conversationId: 'conversation',
    senderId: 'sender',
    attachments: [],
    content: 'Older',
    createdAt: '2026-09-09T00:00:00.000Z',
  };
  const later = {
    ...earlier,
    id: 'second',
    content: 'Newer',
    createdAt: '2026-09-09T00:00:00.001Z',
  };
  assert.deepEqual(mergeMessages([later], [earlier, later]), [earlier, later]);
  assert.deepEqual(
    mergeMessages([earlier], [{ ...earlier, content: 'Confirmed response' }]),
    [{ ...earlier, content: 'Confirmed response' }],
  );
});
