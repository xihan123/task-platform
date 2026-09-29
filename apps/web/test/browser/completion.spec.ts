import { expect, test, type Page } from '@playwright/test';
import type { TaskStatus, UserDto } from '../../lib/types';

const taskId = '00000000-0000-4000-8000-000000000010';
const conversationId = '00000000-0000-4000-8000-000000000020';
const createdAt = '2026-09-10T12:00:00.000Z';
const publisher: UserDto = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'publisher@browser.test',
  role: 'USER',
  status: 'ACTIVE',
  createdAt,
};
const admin: UserDto = {
  ...publisher,
  id: '00000000-0000-4000-8000-000000000002',
  email: 'admin@browser.test',
  role: 'ADMIN',
};

function fixture(status: TaskStatus = 'IN_PROGRESS') {
  return {
    status,
    requestedAt: null as string | null,
    failNextWrite: false,
    holdWrite: undefined as Promise<void> | undefined,
    writes: [] as string[],
  };
}

async function installApi(
  page: Page,
  user: UserDto,
  state: ReturnType<typeof fixture>,
) {
  // Real Next.js pages and hooks, deterministic HTTP contracts; API E2E tests cover persistence.
  await page.routeWebSocket('**/api/tasks/*/events', (socket) =>
    socket.close(),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const task = {
      id: taskId,
      title: 'Completion acceptance task',
      summary: 'Agreed acceptance criteria',
      description: 'Private requirements',
      type: 'development',
      status: state.status,
      publisherId: publisher.id,
      publisher,
      moderation: null,
      attachments: [],
      reviewFeedback: null,
      createdAt,
      updatedAt: createdAt,
    };
    const completion = () => ({
      taskId,
      status: state.status,
      requestedAt: state.requestedAt,
    });
    if (path === '/notifications') {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === '/notifications/presence') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      state.writes.push(path);
      await state.holdWrite;
      if (state.failNextWrite) {
        state.failNextWrite = false;
        await route.fulfill({
          status: 503,
          json: {
            code: 'TASKS_UNAVAILABLE',
            message: 'Unavailable',
            requestId: 'browser-test',
          },
        });
        return;
      }
      if (path === `/admin/tasks/${taskId}/complete-request`) {
        expect(user.role).toBe('ADMIN');
        state.requestedAt = createdAt;
        await route.fulfill({ json: completion() });
        return;
      }
      if (path === `/tasks/${taskId}/confirm-completion`) {
        expect(user.id).toBe(publisher.id);
        expect(state.requestedAt).not.toBeNull();
        state.status = 'COMPLETED';
        await route.fulfill({ json: { ...task, status: state.status } });
        return;
      }
    }
    if (path === '/attachments/policy') {
      await route.fulfill({ json: { retentionDays: 7, maxSizeMb: 5 } });
      return;
    }
    if (path === '/auth/me') {
      await route.fulfill({ json: { user } });
    } else if (path === `/tasks/${taskId}/completion`) {
      await route.fulfill({ json: completion() });
    } else if (path === `/tasks/${taskId}/messages`) {
      await route.fulfill({
        json: {
          conversationId,
          canSend: !['COMPLETED', 'CANCELLED'].includes(state.status),
          remainingMessages: user.role === 'ADMIN' ? null : 3,
          items: [
            {
              id: '00000000-0000-4000-8000-000000000030',
              conversationId,
              senderId: publisher.id,
              content: 'Acceptance criteria agreed.',
              createdAt,
            },
          ],
          olderCursor: null,
          newerCursor: null,
        },
      });
    } else if (path === `/admin/tasks/${taskId}/moderations`) {
      await route.fulfill({ json: [] });
    } else if (
      path === `/admin/tasks/${taskId}` ||
      path === `/tasks/${taskId}`
    ) {
      if (user.role !== 'ADMIN' && user.id !== publisher.id) {
        const { id, title, summary, type, status, createdAt } = task;
        await route.fulfill({
          json: { id, title, summary, type, status, createdAt },
        });
      } else {
        await route.fulfill({ json: task });
      }
    } else {
      throw new Error(
        `Unexpected browser API request: ${request.method()} ${path}`,
      );
    }
  });
}

test('ADMIN requests completion, publisher recovers it over HTTP and confirms, both chats become read-only', async ({
  page,
  context,
}, info) => {
  const state = fixture();
  const ownerPage = await context.newPage();
  await installApi(page, admin, state);
  await installApi(ownerPage, publisher, state);
  await page.goto(`/admin/tasks/detail?id=${taskId}`);
  await ownerPage.goto(`/tasks/detail?id=${taskId}#discussion`);
  const adminChat = page.getByRole('region', { name: '任务会话' });
  const ownerChat = ownerPage.getByRole('region', { name: '任务会话' });
  await expect(ownerChat.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(ownerChat.getByRole('button', { name: '确认完成' })).toHaveCount(
    0,
  );
  let release!: () => void;
  state.holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  await adminChat.getByRole('button', { name: '请求完成' }).click();
  await expect(
    adminChat.getByRole('button', { name: '提交中...' }),
  ).toBeDisabled();
  release();
  state.holdWrite = undefined;
  await expect(
    adminChat.getByText('待发布者确认完成', { exact: true }),
  ).toBeVisible();
  await expect(
    adminChat.getByRole('button', { name: '请求完成' }),
  ).toBeDisabled();
  expect(state.status).toBe('IN_PROGRESS');
  await expect(ownerChat.getByRole('button', { name: '确认完成' })).toBeEnabled(
    { timeout: 10000 },
  );
  await expect(ownerChat.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await ownerPage.reload();
  await expect(
    ownerChat.getByRole('button', { name: '确认完成' }),
  ).toBeEnabled();
  await ownerChat.getByRole('button', { name: '确认完成' }).click();
  for (const chat of [ownerChat, adminChat]) {
    await expect(chat.getByText('任务已完成', { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(
      chat.getByText('当前任务会话为只读。', { exact: true }),
    ).toBeVisible();
    await expect(chat.getByRole('textbox', { name: '消息' })).toHaveCount(0);
    await expect(
      chat.getByText('Acceptance criteria agreed.', { exact: true }),
    ).toBeVisible();
  }
  expect(state.writes).toEqual([
    `/admin/tasks/${taskId}/complete-request`,
    `/tasks/${taskId}/confirm-completion`,
  ]);
  for (const [name, target] of [
    ['admin-completed', page],
    ['publisher-completed', ownerPage],
  ] as const) {
    const path = info.outputPath(`${name}.png`);
    await target.screenshot({ path, fullPage: true });
    await info.attach(name, { path, contentType: 'image/png' });
  }
});

for (const actor of [admin, publisher]) {
  test(`${actor.role} completion failure is visible and can be retried`, async ({
    page,
  }) => {
    const state = fixture();
    state.requestedAt = actor.role === 'USER' ? createdAt : null;
    state.failNextWrite = true;
    await installApi(page, actor, state);
    await page.goto(
      actor.role === 'ADMIN'
        ? `/admin/tasks/detail?id=${taskId}`
        : `/tasks/detail?id=${taskId}#discussion`,
    );
    const chat = page.getByRole('region', { name: '任务会话' });
    const action = chat.getByRole('button', {
      name: actor.role === 'ADMIN' ? '请求完成' : '确认完成',
    });
    await expect(action).toBeEnabled();
    await action.click();
    await expect(chat.getByRole('alert')).toHaveText(
      '任务操作暂不可用，请稍后再试。',
    );
    await expect(action).toBeEnabled();
    expect(state.status).toBe('IN_PROGRESS');
    await action.click();
    await expect(
      chat.getByText(
        actor.role === 'ADMIN' ? '待发布者确认完成' : '任务已完成',
        { exact: true },
      ),
    ).toBeVisible();
    expect(state.writes).toHaveLength(2);
  });
}

test('cancelled tasks keep history readable without completion or send controls', async ({
  page,
}) => {
  const state = fixture('CANCELLED');
  state.requestedAt = createdAt;
  await installApi(page, publisher, state);
  await page.goto(`/tasks/detail?id=${taskId}#discussion`);
  const chat = page.getByRole('region', { name: '任务会话' });
  await expect(chat.getByText('任务已取消', { exact: true })).toBeVisible();
  await expect(chat.getByRole('button', { name: '确认完成' })).toHaveCount(0);
  await expect(chat.getByRole('textbox', { name: '消息' })).toHaveCount(0);
  await expect(
    chat.getByText('Acceptance criteria agreed.', { exact: true }),
  ).toBeVisible();
});

test('another USER cannot see completion controls or the private chat', async ({
  page,
}) => {
  const state = fixture();
  state.requestedAt = createdAt;
  await installApi(
    page,
    { ...publisher, id: '00000000-0000-4000-8000-000000000003' },
    state,
  );
  await page.goto(`/tasks/detail?id=${taskId}#discussion`);
  await expect(page.getByText('完整需求仅发布者与管理员可见。')).toBeVisible();
  await expect(page.getByRole('region', { name: '任务会话' })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
