import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { apiEndpoint, ApiClientError } from '../lib/api-client';
import { AuthApiError, authApi } from '../lib/auth-api';
import { tasksApi } from '../lib/tasks-api';
import { adminApi } from '../lib/admin-api';

const originalUrl = process.env.NEXT_PUBLIC_API_URL;
test('email clients send explicit verification/reset inputs and authenticated preferences', async (t) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    calls.push({ path: url.pathname, init });
    return Response.json({});
  });
  const input = {
    email: 'member@example.test',
    password: 'A secure password!',
    code: '123456',
  };
  await authApi.requestCode(input.email, 'register');
  await authApi.register(input);
  await authApi.requestCode(input.email, 'password-reset');
  await authApi.resetPassword(input);
  await authApi.requestVerificationCode();
  await authApi.verifyEmail(input.code);
  await authApi.emailPreferences();
  await authApi.updateEmailPreferences(true);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/auth/register-code',
      '/api/auth/register',
      '/api/auth/password-reset-code',
      '/api/auth/reset-password',
      '/api/auth/email-verification-code',
      '/api/auth/verify-email',
      '/api/notifications/preferences',
      '/api/notifications/preferences',
    ],
  );
  assert.equal(calls[6]!.init!.method, 'GET');
  assert.equal(calls[7]!.init!.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), input);
  assert.deepEqual(JSON.parse(calls[7]!.init!.body as string), {
    messageEmailEnabled: true,
  });
  for (const { init } of calls) {
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
    if (init?.method !== 'GET')
      assert.equal(new Headers(init?.headers).get('X-CSRF-Protection'), '1');
  }
});
before(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api/';
});
after(() => {
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalUrl;
});

test('production defaults to the reverse proxy origin while development keeps port 4000', () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousUrl = process.env.NEXT_PUBLIC_API_URL;
  const previousEnvironment = process.env.NODE_ENV;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete process.env.NEXT_PUBLIC_API_URL;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://tasks.example.com/tasks' } },
    });
    environment.NODE_ENV = 'production';
    assert.equal(
      apiEndpoint('tasks').href,
      'https://tasks.example.com/api/tasks',
    );
    environment.NODE_ENV = 'development';
    assert.equal(
      apiEndpoint('tasks').href,
      'https://tasks.example.com:4000/api/tasks',
    );
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    if (previousEnvironment === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousEnvironment;
    if (previousWindow)
      Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: Window }).window;
  }
});

test('completion clients read without cache and mutate with cookies and CSRF', async (t) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    calls.push({ path: url.pathname, init });
    return Response.json({});
  });
  const signal = new AbortController().signal;
  await tasksApi.completion('task-id', signal);
  await adminApi.requestCompletion('task-id');
  await tasksApi.confirmCompletion('task-id');
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/tasks/task-id/completion',
      '/api/admin/tasks/task-id/complete-request',
      '/api/tasks/task-id/confirm-completion',
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.init?.method),
    ['GET', 'POST', 'POST'],
  );
  assert.equal(calls[0]!.init?.signal, signal);
  for (const { init } of calls) {
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
    if (init?.method === 'POST')
      assert.equal(new Headers(init.headers).get('X-CSRF-Protection'), '1');
  }
});

test('workbench writes use guarded API paths, PATCH and CSRF without accepting role edits', async (t) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    calls.push({ path: url.pathname, init });
    return Response.json({});
  });
  await adminApi.take('task-id');
  await adminApi.review('task-id', {
    moderationId: 'moderation-id',
    decision: 'PASS',
    reason: 'Reviewed',
  });
  await adminApi.retryModeration('task-id', 'moderation-id');
  await adminApi.setUserStatus('user-id', 'DISABLED');
  await adminApi.setAiEnabled('keys', 'key-id', false);
  await adminApi.addAiModel('endpoint-id', 'model-name');
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/admin/tasks/task-id/take',
      '/api/admin/tasks/task-id/review',
      '/api/admin/tasks/task-id/moderations/moderation-id/retry',
      '/api/admin/users/user-id/status',
      '/api/admin/ai/keys/key-id',
      '/api/admin/ai/endpoints/endpoint-id/models',
    ],
  );
  assert.equal(calls[3]!.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), {
    status: 'DISABLED',
  });
  for (const { init } of calls) {
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('X-CSRF-Protection'), '1');
  }
});

test('administrator clients use the protected resource, history and notification endpoints with cookies', async (t) => {
  const requests: { path: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    requests.push({ path: url.pathname, init });
    return Response.json([]);
  });
  await adminApi.resources();
  await adminApi.moderations('task-id');
  await adminApi.notifications();
  await adminApi.configureResource({
    baseUrl: 'https://ai.example.test/v1/',
    model: 'test-model',
    apiKey: 'test-input-key',
  });
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      '/api/admin/ai/resources',
      '/api/admin/tasks/task-id/moderations',
      '/api/admin/notifications',
      '/api/admin/ai/resources',
    ],
  );
  for (const { init } of requests) {
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
  }
  assert.equal(requests[3]!.init?.method, 'POST');
  assert.equal(
    new Headers(requests[3]!.init?.headers).get('X-CSRF-Protection'),
    '1',
  );
});

test('task reads send cookies without caching and serialize scope and pagination', async (t) => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    requests.push({ url: input, init });
    return Response.json({ items: [], nextCursor: null });
  });
  const signal = new AbortController().signal;
  await tasksApi.list(
    {
      scope: 'mine',
      limit: 10,
      cursor: 'a94ad2aa-bb97-491b-a54e-e9a9294f2870',
    },
    signal,
  );
  const request = requests[0]!;
  assert.equal(request.url.origin, 'https://api.example.com');
  assert.equal(request.url.pathname, '/api/tasks');
  assert.equal(request.url.searchParams.get('limit'), '10');
  assert.equal(request.url.searchParams.get('scope'), 'mine');
  assert.equal(
    request.url.searchParams.get('cursor'),
    'a94ad2aa-bb97-491b-a54e-e9a9294f2870',
  );
  assert.equal(request.init?.credentials, 'include');
  assert.equal(request.init?.cache, 'no-store');
  assert.equal(request.init?.signal, signal);
  assert.equal(request.init?.body, undefined);
  await tasksApi.publicStats(signal);
  assert.equal(requests[1]!.url.pathname, '/api/tasks/public-stats');
  assert.equal(requests[1]!.init?.signal, signal);
  await tasksApi.findOne('a94ad2aa-bb97-491b-a54e-e9a9294f2870');
  assert.equal(
    requests[2]!.url.pathname,
    '/api/tasks/a94ad2aa-bb97-491b-a54e-e9a9294f2870',
  );
});

test('task creation, PATCH and cancellation send the CSRF header and expected HTTP methods', async (t) => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    requests.push({ url, init });
    return Response.json({ id: 'task-id' });
  });
  const input = {
    title: 'Title',
    summary: 'Summary',
    description: 'Private text',
    type: 'general',
  };
  await tasksApi.create(input);
  await tasksApi.update('task-id', { description: 'Updated private text' });
  await tasksApi.cancel('task-id');
  assert.deepEqual(
    requests.map(({ init }) => init?.method),
    ['POST', 'PATCH', 'POST'],
  );
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    ['/api/tasks', '/api/tasks/task-id', '/api/tasks/task-id/cancel'],
  );
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), input);
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), {
    description: 'Updated private text',
  });
  for (const { init } of requests) {
    assert.equal(new Headers(init?.headers).get('X-CSRF-Protection'), '1');
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
  }
});

test('API errors remain typed for authentication and task callers, including malformed upstream responses', async (t) => {
  assert.equal(AuthApiError, ApiClientError);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 'TASK_NOT_EDITABLE' }, { status: 409 }),
  );
  await assert.rejects(
    tasksApi.update('task-id', { title: 'Edited' }),
    (error) =>
      error instanceof ApiClientError &&
      error.code === 'TASK_NOT_EDITABLE' &&
      error.status === 409,
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(null, { status: 502 }),
  );
  await assert.rejects(
    tasksApi.list(),
    (error) =>
      error instanceof ApiClientError && error.code === 'REQUEST_FAILED',
  );
});

test('the shared client preserves the existing login, me and logout contracts', async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    paths.push(url.pathname);
    return url.pathname.endsWith('logout')
      ? new Response(null, { status: 204 })
      : Response.json({ user: { id: 'user-id' } });
  });
  await authApi.login({
    email: 'user@example.com',
    password: 'Example test password',
  });
  await authApi.me();
  await authApi.logout();
  assert.deepEqual(paths, [
    '/api/auth/login',
    '/api/auth/me',
    '/api/auth/logout',
  ]);
});
