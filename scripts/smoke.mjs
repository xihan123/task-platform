import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';

for (const path of ['../apps/api/.env', '../.env', '../apps/web/.env']) {
  try {
    loadEnvFile(new URL(path, import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const webUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const apiHost = process.env.API_HOST ?? '127.0.0.1';
const connectHost =
  apiHost === '0.0.0.0' ? '127.0.0.1' : apiHost === '::' ? '::1' : apiHost;
const urlHost = connectHost.includes(':') ? `[${connectHost}]` : connectHost;
const apiUrl = `http://${urlHost}:${process.env.API_PORT ?? 4000}`;

for (const [url, expected] of [
  [`${apiUrl}/api/health/live`, { status: 'ok', service: 'api' }],
  [
    `${apiUrl}/api/health`,
    {
      status: 'ok',
      service: 'api',
      checks: { postgres: 'up', redis: 'up' },
    },
  ],
]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `${url} must return HTTP 200`);
  assert.deepEqual(await response.json(), expected);
  console.info(`PASS ${url}`);
}

const page = await fetch(webUrl, { signal: AbortSignal.timeout(30000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /任务协作平台/);
console.info(`PASS ${webUrl}`);

const tasks = await fetch(`${apiUrl}/api/tasks`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(tasks.status, 200);
const taskPage = await tasks.json();
assert.ok(Array.isArray(taskPage.items));
for (const task of taskPage.items) {
  assert.deepEqual(Object.keys(task).sort(), [
    'createdAt',
    'id',
    'status',
    'summary',
    'title',
    'type',
  ]);
}
console.info(`PASS ${apiUrl}/api/tasks (anonymous public DTOs)`);
