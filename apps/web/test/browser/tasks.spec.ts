import { expect, test, type Page } from '@playwright/test';
import type {
  CreateTaskInput,
  PrivateTaskDto,
  TaskDto,
  UserDto,
} from '../../lib/types';

const taskId = '00000000-0000-4000-8000-000000000110';
const createdAt = '2026-09-20T01:00:00.000Z';
const publisher: UserDto = {
  id: '00000000-0000-4000-8000-000000000101',
  email: 'publisher@browser.test',
  role: 'USER',
  status: 'ACTIVE',
  createdAt,
};
const admin: UserDto = {
  ...publisher,
  id: '00000000-0000-4000-8000-000000000102',
  role: 'ADMIN',
};
const other: UserDto = {
  ...publisher,
  id: '00000000-0000-4000-8000-000000000103',
};
const original: PrivateTaskDto = {
  attachments: [],
  reviewFeedback: null,
  id: taskId,
  publisherId: publisher.id,
  title: '接口联调任务',
  type: '开发',
  summary: '公开的需求摘要',
  description: '<script>private requirements</script>',
  status: 'PENDING_REVIEW',
  createdAt,
  updatedAt: createdAt,
};

function fixture(user: UserDto | null = publisher) {
  return {
    user,
    loginUser: publisher,
    task: { ...original },
    writes: [] as { path: string; method: string; body: unknown }[],
    holdWrite: undefined as Promise<void> | undefined,
    failWrite: undefined as { status: number; code: string } | undefined,
    failList: false,
    empty: false,
    authFailure: false,
    cursors: [] as (string | null)[],
    scopes: [] as (string | null)[],
    statsCounts: null as null | {
      open: number;
      inProgress: number;
      completed: number;
    },
    statsFailure: false,
    statsRequests: 0,
  };
}

async function installApi(page: Page, state: ReturnType<typeof fixture>) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api', '');
    const fail = (status: number, code: string) =>
      route.fulfill({
        status,
        json: { code, message: code, requestId: 'browser-tasks' },
      });
    const visibleTask = (): TaskDto => {
      if (state.user?.id === publisher.id || state.user?.role === 'ADMIN')
        return state.task;
      const { id, title, summary, type, status, createdAt } = state.task;
      return { id, title, summary, type, status, createdAt };
    };
    if (path === '/notifications') {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === '/notifications/presence') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/attachments/policy') {
      await route.fulfill({ json: { retentionDays: 7, maxSizeMb: 5 } });
      return;
    }
    if (path === `/tasks/${taskId}/messages`) {
      await route.fulfill({
        json: {
          conversationId: taskId,
          items: [],
          olderCursor: null,
          newerCursor: null,
          canSend: !['COMPLETED', 'CANCELLED'].includes(state.task.status),
          remainingMessages: 3,
        },
      });
      return;
    }
    if (path === `/tasks/${taskId}/completion`) {
      await route.fulfill({
        json: { taskId, status: state.task.status, requestedAt: null },
      });
      return;
    }
    if (path === '/auth/me') {
      if (state.authFailure) await fail(503, 'AUTH_UNAVAILABLE');
      else if (state.user) await route.fulfill({ json: { user: state.user } });
      else await fail(401, 'UNAUTHENTICATED');
      return;
    }
    if (request.method() !== 'GET') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      const body = request.postData()
        ? (request.postDataJSON() as CreateTaskInput)
        : undefined;
      state.writes.push({ path, method: request.method(), body });
      await state.holdWrite;
      if (state.failWrite) {
        const error = state.failWrite;
        state.failWrite = undefined;
        await fail(error.status, error.code);
        return;
      }
      if (path === '/auth/login') {
        state.user = state.loginUser;
        await route.fulfill({ json: { user: state.user } });
        return;
      }
      if (path === '/auth/logout') {
        state.user = null;
        await route.fulfill({ status: 204 });
        return;
      }
      if (state.user?.id !== publisher.id) {
        await fail(403, 'FORBIDDEN');
        return;
      }
      if (
        path === '/tasks' ||
        (path === `/tasks/${taskId}` && request.method() === 'PATCH')
      ) {
        expect(Object.keys(body!).sort()).toEqual([
          'attachmentIds',
          'description',
          'summary',
          'title',
          'type',
        ]);
        state.task = { ...state.task, ...body, status: 'PENDING_REVIEW' };
        await route.fulfill({
          status: path === '/tasks' ? 201 : 200,
          json: state.task,
        });
        return;
      }
      if (path === `/tasks/${taskId}/cancel`) {
        state.task.status = 'CANCELLED';
        await route.fulfill({ json: state.task });
        return;
      }
      throw new Error(`Unexpected write ${request.method()} ${path}`);
    }
    if (path === '/tasks/public-stats') {
      state.statsRequests += 1;
      if (state.statsFailure) {
        await fail(503, 'STATS_UNAVAILABLE');
        return;
      }
      await route.fulfill({
        json: state.statsCounts ?? {
          open: state.task.status === 'OPEN' && !state.empty ? 1 : 0,
          inProgress:
            state.task.status === 'IN_PROGRESS' && !state.empty ? 1 : 0,
          completed: state.task.status === 'COMPLETED' && !state.empty ? 1 : 0,
        },
      });
      return;
    }
    if (path === '/tasks') {
      state.cursors.push(url.searchParams.get('cursor'));
      const scope = url.searchParams.get('scope');
      state.scopes.push(scope);
      if (state.failList) {
        await fail(503, 'TASKS_UNAVAILABLE');
        return;
      }
      if (scope === 'mine' && state.user?.role !== 'USER') {
        await fail(
          state.user ? 403 : 401,
          state.user ? 'FORBIDDEN' : 'UNAUTHENTICATED',
        );
        return;
      }
      const next = url.searchParams.has('cursor');
      const { id, title, summary, type, status, createdAt } = state.task;
      const base =
        scope === 'mine'
          ? state.task
          : { id, title, summary, type, status, createdAt };
      const item = next
        ? {
            ...base,
            id: '00000000-0000-4000-8000-000000000111',
            title: '第二页任务',
          }
        : base;
      const empty =
        state.empty ||
        (scope === 'mine'
          ? state.user?.id !== state.task.publisherId
          : !['OPEN', 'IN_PROGRESS', 'COMPLETED'].includes(state.task.status));
      await route.fulfill({
        json: {
          items: empty ? [] : [item],
          nextCursor: next || empty ? null : 'next-page-token',
        },
      });
    } else if (path === '/conversations') {
      await route.fulfill({
        json: {
          items:
            state.user?.id === publisher.id
              ? [{ taskId, title: '已有任务会话' }]
              : [],
          nextCursor: null,
        },
      });
    } else if (path === '/admin/dashboard') {
      await route.fulfill({
        json: {
          counts: { open: 0, inProgress: 0, humanReview: 0 },
          openTasks: [],
          inProgressTasks: [],
          reviewTasks: [],
        },
      });
    } else if (path === `/tasks/${taskId}`) {
      await route.fulfill({ json: visibleTask() });
    } else throw new Error(`Unexpected read ${path}`);
  });
}

async function fillTask(page: Page) {
  await page.getByLabel('任务标题', { exact: true }).fill('  新的任务  ');
  await page
    .getByLabel('任务类型', { exact: true })
    .selectOption('web_backend');
  await page.getByLabel('公开摘要', { exact: true }).fill('公开摘要内容');
  await page
    .getByLabel('完整需求（私密）', { exact: true })
    .fill(original.description);
}

for (const [name, user, destination] of [
  ['visitor', null, '/tasks?scope=public'],
  ['publisher', publisher, '/tasks?scope=mine'],
  ['admin', admin, '/admin'],
] as const) {
  test(`${name} enters the matching workbench directly`, async ({ page }) => {
    const state = fixture(user);
    await installApi(page, state);
    await page.goto('/');
    await expect(page).toHaveURL(destination);
    await expect(page.getByRole('heading', { name: '当前账户' })).toHaveCount(
      0,
    );
    if (user?.role !== 'ADMIN') {
      await expect(
        page.getByRole('tab', { name: user ? '我的任务' : '公开广场' }),
      ).toHaveAttribute('aria-selected', 'true');
    }
  });
}

for (const loginUser of [publisher, admin]) {
  test(`${loginUser.role} login automatically enters the workbench`, async ({
    page,
  }) => {
    const state = fixture(null);
    state.loginUser = loginUser;
    await installApi(page, state);
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill(loginUser.email);
    await page.getByLabel('密码', { exact: true }).fill('A browser password!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(
      loginUser.role === 'ADMIN' ? '/admin' : '/tasks?scope=mine',
    );
    await expect(page.getByRole('heading', { name: '当前账户' })).toHaveCount(
      0,
    );
  });
}

test('home retries session failures and blocks disabled accounts', async ({
  page,
}) => {
  const state = fixture(publisher);
  state.authFailure = true;
  await installApi(page, state);
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    '暂时无法获取账户信息。',
  );
  await expect(page).toHaveURL('/');
  state.authFailure = false;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page).toHaveURL('/tasks?scope=mine');
  state.user = { ...publisher, status: 'DISABLED' };
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    '账户不可用',
  );
  await expect(page).toHaveURL('/');
});

test('scope tabs persist in URLs, reset pagination and support keyboard navigation', async ({
  page,
}, info) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto('/tasks');
  await expect(page.getByText('暂无公开任务。')).toBeVisible();
  await page.getByRole('tab', { name: '我的任务' }).click();
  await expect(page).toHaveURL('/tasks?scope=mine');
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  await expect(page.getByRole('link', { name: '已有任务会话' })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('link', { name: '第二页任务' })).toBeVisible();
  await page.getByRole('tab', { name: '公开广场' }).click();
  await expect(page.getByText('暂无公开任务。')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: '我的任务' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  expect(state.cursors.at(-1)).toBeNull();
  await page.goForward();
  await expect(page.getByRole('tab', { name: '公开广场' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '公开广场' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '我的任务' })).toBeFocused();
  await expect(page).toHaveURL('/tasks?scope=mine');
  await page.reload();
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  await expect(page.getByRole('tab', { name: '我的任务' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const typeBounds = await page.locator('.pub-row .type').first().boundingBox();
  const dateBounds = await page.locator('.pub-row time').first().boundingBox();
  expect(typeBounds).not.toBeNull();
  expect(dateBounds).not.toBeNull();
  expect(typeBounds!.x + typeBounds!.width).toBeLessThanOrEqual(dateBounds!.x);
  const path = info.outputPath('my-tasks.png');
  await page.screenshot({ path, fullPage: true });
  await info.attach('my-tasks', { path, contentType: 'image/png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('public stats show all statuses, stay independent of pagination, and refresh', async ({
  page,
}) => {
  const state = fixture();
  state.task.status = 'OPEN';
  state.statsCounts = { open: 4, inProgress: 2, completed: 9 };
  await installApi(page, state);
  await page.goto('/tasks?scope=public');
  const stats = page.locator('.public-stats');
  await expect(stats.locator('.public-stat-open')).toContainText('待接取4');
  await expect(stats.locator('.public-stat-progress')).toContainText('进行中2');
  await expect(stats.locator('.public-stat-completed')).toContainText(
    '已完成9',
  );
  await expect(page.locator('.pub-row .sum').first()).toHaveCSS(
    'font-size',
    '14px',
  );
  const initialRequests = state.statsRequests;
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('link', { name: '第二页任务' })).toBeVisible();
  await expect(stats.locator('.public-stat-open')).toContainText('4');
  expect(state.statsRequests).toBe(initialRequests);
  state.statsCounts = { open: 5, inProgress: 3, completed: 10 };
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(stats.locator('.public-stat-open')).toContainText('5');
  await expect(stats.locator('.public-stat-progress')).toContainText('3');
  await expect(stats.locator('.public-stat-completed')).toContainText('10');
  await page.getByRole('tab', { name: '我的任务' }).click();
  await expect(stats).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('public stats handle zero and retry errors without hiding the list', async ({
  page,
}) => {
  const state = fixture(null);
  state.empty = true;
  state.statsCounts = { open: 0, inProgress: 0, completed: 0 };
  await installApi(page, state);
  await page.goto('/tasks?scope=public');
  await expect(page.locator('.public-stat dd')).toHaveText(['0', '0', '0']);
  state.empty = false;
  state.task.status = 'OPEN';
  state.statsFailure = true;
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByText('公开统计暂时无法获取。')).toBeVisible();
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  state.statsFailure = false;
  state.statsCounts = { open: 1, inProgress: 0, completed: 0 };
  await page.getByRole('button', { name: '重试统计' }).click();
  await expect(page.locator('.public-stat dd')).toHaveText(['1', '0', '0']);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

for (const user of [null, admin]) {
  test(`${user ? 'admin' : 'visitor'} sees an actionable mine-tab prompt without requesting private tasks`, async ({
    page,
  }) => {
    const state = fixture(user);
    await installApi(page, state);
    await page.goto('/tasks?scope=mine');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('link')).toHaveAttribute(
      'href',
      user ? '/admin/tasks' : '/login',
    );
    expect(state.scopes).toEqual([]);
    await expect(page.getByRole('link', { name: original.title })).toHaveCount(
      0,
    );
  });
}

test('account changes and expired sessions clear personal tasks and conversations', async ({
  page,
}) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto('/tasks?scope=mine');
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  await expect(page.getByRole('link', { name: '已有任务会话' })).toBeVisible();
  state.user = other;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('你还没有发布任务。')).toBeVisible();
  await expect(page.getByRole('link', { name: original.title })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '已有任务会话' })).toHaveCount(0);
  state.user = null;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('tabpanel').getByRole('link', { name: '登录 / 注册' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '任务会话' })).toHaveCount(0);
});

for (const user of [publisher, admin]) {
  test(`${user.role} logout failure can be retried before entering the public square`, async ({
    page,
  }) => {
    const state = fixture(user);
    state.failWrite = { status: 503, code: 'UNAVAILABLE' };
    await installApi(page, state);
    await page.goto(user.role === 'ADMIN' ? '/admin' : '/tasks?scope=mine');
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      '退出失败，请重试。',
    );
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL('/tasks?scope=public');
    await expect(page.getByRole('tab', { name: '公开广场' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0);
  });
}

test('publisher creates, edits and cancels a task through the browser', async ({
  page,
}, info) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto('/tasks');
  await page.getByRole('link', { name: '发布任务', exact: true }).click();
  const attachmentButton = page.getByRole('button', { name: '添加附件' });
  await expect(attachmentButton).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await attachmentButton.click();
  await chooser;
  await fillTask(page);
  let release!: () => void;
  state.holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByRole('button', { name: '提交中...' })).toBeDisabled();
  await expect(page.getByLabel('任务标题', { exact: true })).toBeDisabled();
  await expect(attachmentButton).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  release();
  state.holdWrite = undefined;
  await expect(page).toHaveURL(`/tasks/detail?id=${taskId}`);
  await expect(
    page.getByRole('heading', { name: '新的任务', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('待审核', { exact: true })).toBeVisible();
  await expect(
    page.getByText(original.description, { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.task-content script')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务会话' })).toBeVisible();
  await page.getByRole('button', { name: '编辑任务' }).click();
  await page.getByLabel('任务标题', { exact: true }).fill('修改后的任务');
  await page.getByRole('button', { name: '保存并重新审核' }).click();
  await expect(
    page.getByRole('heading', { name: '修改后的任务' }),
  ).toBeVisible();
  const path = info.outputPath('publisher-task-detail.png');
  await page.screenshot({ path, fullPage: true });
  await info.attach('publisher-task-detail', {
    path,
    contentType: 'image/png',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await page.getByRole('button', { name: '继续保留' }).click();
  expect(state.writes).toHaveLength(2);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '取消任务', exact: true }),
  ).toHaveCount(0);
  expect(state.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'POST /tasks',
    `PATCH /tasks/${taskId}`,
    `POST /tasks/${taskId}/cancel`,
  ]);
  expect(state.writes[0]?.body).toMatchObject({ title: '新的任务' });
});

for (const [name, user] of [
  ['anonymous', null],
  ['other USER', other],
  ['ADMIN', admin],
] as const) {
  test(`${name} sees only permitted task content and no publisher actions`, async ({
    page,
  }) => {
    const state = fixture(user);
    await installApi(page, state);
    await page.goto(`/tasks/detail?id=${taskId}`);
    await expect(
      page.getByRole('heading', { name: original.title }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '取消任务', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: '进入任务会话' })).toHaveCount(
      0,
    );
    if (user?.role === 'ADMIN') {
      await expect(
        page.getByText(original.description, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: '在工作台处理' }),
      ).toBeVisible();
    } else
      await expect(
        page.getByText(original.description, { exact: true }),
      ).toHaveCount(0);
    if (!user || user.role === 'ADMIN') {
      await page.goto('/tasks/new');
      await expect(
        page.getByRole('heading', { name: '发布任务', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '提交审核' })).toHaveCount(
        0,
      );
    }
    expect(state.writes).toHaveLength(0);
  });
}

test('creation validates blank input and preserves the draft after a rate limit failure', async ({
  page,
}) => {
  const state = fixture();
  state.failWrite = { status: 429, code: 'RATE_LIMITED' };
  await installApi(page, state);
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByLabel('任务标题', { exact: true }).fill('   ');
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    '内容不能只有空白',
  );
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('任务标题', { exact: true }).fill('重试任务');
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    '操作过于频繁，请稍后重试。',
  );
  await expect(
    page.getByLabel('完整需求（私密）', { exact: true }),
  ).toHaveValue(original.description);
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByRole('heading', { name: '重试任务' })).toBeVisible();
  expect(state.writes).toHaveLength(2);
});

test('editing a task which passed moderation refreshes its state on conflict', async ({
  page,
}) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await page.getByRole('button', { name: '编辑任务' }).click();
  await page
    .getByLabel('任务类型', { exact: true })
    .selectOption('web_backend');
  state.task.status = 'OPEN';
  state.failWrite = { status: 409, code: 'TASK_NOT_EDITABLE' };
  await page.getByRole('button', { name: '保存并重新审核' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    '任务已不在待审核状态，无法编辑。',
  );
  await expect(page.getByText('待接取', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('editing a legacy task requires choosing a preset category', async ({
  page,
}) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await expect(page.getByText('开发', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑任务' }).click();
  await expect(page.getByLabel('任务类型', { exact: true })).toHaveValue(
    '开发',
  );
  await page.getByRole('button', { name: '保存并重新审核' }).click();
  expect(state.writes).toHaveLength(0);
  await page
    .getByLabel('任务类型', { exact: true })
    .selectOption('office_docs');
  await page.getByRole('button', { name: '保存并重新审核' }).click();
  await expect(page.getByText('表格与办公文档', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body).toMatchObject({ type: 'office_docs' });
});

test('cancel failure leaves the task active and offers an explicit retry', async ({
  page,
}) => {
  const state = fixture();
  state.task.status = 'IN_PROGRESS';
  state.failWrite = { status: 503, code: 'TASKS_UNAVAILABLE' };
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    '服务暂时不可用，请重试。',
  );
  await expect(page.getByText('进行中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
});

test('completed tasks retain details and chat access without edit or cancel', async ({
  page,
}) => {
  const state = fixture();
  state.task.status = 'COMPLETED';
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '取消任务', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务会话' })).toBeVisible();
});

test('account change removes private content and the unsaved editing draft', async ({
  page,
}) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await page.getByRole('button', { name: '编辑任务' }).click();
  await page
    .getByLabel('完整需求（私密）', { exact: true })
    .fill('unsaved private draft');
  state.user = other;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByLabel('完整需求（私密）', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('完整需求仅发布者与管理员可见。', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(original.description, { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('unsaved private draft', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('task list retries failures, paginates and handles empty responses', async ({
  page,
}) => {
  const state = fixture(null);
  state.task.status = 'OPEN';
  state.failList = true;
  await installApi(page, state);
  await page.goto('/tasks');
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    '服务暂时不可用',
  );
  state.failList = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  await expect(
    page.getByText(original.description, { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('link', { name: '第二页任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByRole('link', { name: original.title })).toBeVisible();
  expect(state.cursors).toContain('next-page-token');
  state.empty = true;
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByText('暂无公开任务。', { exact: true })).toBeVisible();
});

test('authentication outage hides task content until a successful retry', async ({
  page,
}) => {
  const state = fixture();
  state.authFailure = true;
  await installApi(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    '暂时无法获取账户信息',
  );
  await expect(
    page.getByText(original.description, { exact: true }),
  ).toHaveCount(0);
  state.authFailure = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    page.getByText(original.description, { exact: true }),
  ).toBeVisible();
});
