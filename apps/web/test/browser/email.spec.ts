import { expect, test, type Page } from '@playwright/test';
import type { AdminNotificationDto, UserDto } from '../../lib/types';

const user: UserDto = {
  id: '00000000-0000-4000-8000-000000000011',
  email: 'member@example.test',
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-09-27T00:00:00.000Z',
};
function fixture() {
  return {
    current: null as UserDto | null,
    verified: false,
    subscribed: false,
    failCode: false,
    failSave: false,
    notices: [] as AdminNotificationDto[],
    writes: [] as { path: string; body: unknown }[],
    presenceWrites: [] as { tabId: string; method: string }[],
  };
}
async function installApi(page: Page, state: ReturnType<typeof fixture>) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/', '');
    const fail = (status: number, code: string) =>
      route.fulfill({
        status,
        json: { code, message: code, requestId: 'email-browser-test' },
      });
    if (path === 'notifications/presence') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      state.presenceWrites.push({
        tabId: (request.postDataJSON() as { tabId: string }).tabId,
        method: request.method(),
      });
      return route.fulfill({ status: 204 });
    }
    if (request.method() !== 'GET') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      state.writes.push({
        path,
        body: request.postData() ? request.postDataJSON() : undefined,
      });
    }
    if (path === 'attachments/policy')
      return route.fulfill({ json: { retentionDays: 7, maxSizeMb: 5 } });
    if (path === 'auth/me')
      return state.current
        ? route.fulfill({ json: { user: state.current } })
        : fail(401, 'UNAUTHENTICATED');
    if (path.endsWith('-code'))
      return state.failCode
        ? fail(503, 'EMAIL_UNAVAILABLE')
        : route.fulfill({
            status: 202,
            json: { message: 'If eligible, a verification code will be sent.' },
          });
    if (
      path === 'auth/register' ||
      path === 'auth/reset-password' ||
      path === 'auth/verify-email'
    ) {
      const input = request.postDataJSON() as { code: string };
      if (input.code !== '123456') return fail(400, 'INVALID_EMAIL_CODE');
      state.verified = true;
      if (path === 'auth/reset-password') state.current = null;
      if (path === 'auth/register')
        return route.fulfill({ status: 201, json: { user } });
      return route.fulfill({ status: 204 });
    }
    if (path === 'auth/login') {
      state.current = user;
      return route.fulfill({ json: { user } });
    }
    if (path === 'auth/logout') {
      state.current = null;
      return route.fulfill({ status: 204 });
    }
    if (path === 'notifications/preferences') {
      if (request.method() === 'PATCH') {
        if (state.failSave) return fail(503, 'EMAIL_UNAVAILABLE');
        state.subscribed = (
          request.postDataJSON() as { messageEmailEnabled: boolean }
        ).messageEmailEnabled;
      }
      return route.fulfill({
        json: {
          emailVerifiedAt: state.verified ? user.createdAt : null,
          messageEmailEnabled: state.subscribed,
        },
      });
    }
    if (path === 'notifications') return route.fulfill({ json: state.notices });
    if (path === 'conversations' || path === 'tasks')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === 'admin/dashboard')
      return route.fulfill({
        json: {
          counts: { open: 0, inProgress: 0, humanReview: 0 },
          openTasks: [],
          inProgressTasks: [],
          reviewTasks: [],
        },
      });
    if (path === 'admin/tasks' || path === 'admin/users')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === 'admin/ai/config')
      return route.fulfill({
        json: [
          {
            id: 'service',
            baseUrl: 'https://models.example.test/v1/',
            protocol: 'OPENAI_COMPATIBLE',
            enabled: true,
            models: [{ id: 'model', name: 'example-model', enabled: true }],
            keys: [{ id: 'key', maskedKey: '••••1234', enabled: true }],
          },
        ],
      });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
}

test('register requires a mailed code, reports invalid codes, and returns to login', async ({
  page,
}) => {
  const state = fixture();
  await installApi(page, state);
  await page.goto('/login');
  await page.getByRole('tab', { name: '注册', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page
    .getByLabel('密码', { exact: true })
    .fill('A browser test password!');
  await page
    .getByLabel('确认密码', { exact: true })
    .fill('A browser test password!');
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await expect(page.getByRole('button', { name: /秒后可重发/ })).toBeDisabled();
  await expect(
    page.getByText('若邮箱符合条件，验证码将发送至该邮箱，10 分钟内有效。'),
  ).toBeVisible();
  await page.getByLabel('邮箱验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    '验证码错误',
  );
  await page.getByLabel('邮箱验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.getByText('注册成功，请登录。')).toBeVisible();
  expect(state.current).toBeNull();
  expect(state.writes.at(-1)).toEqual({
    path: 'auth/register',
    body: {
      email: user.email,
      password: 'A browser test password!',
      code: '123456',
    },
  });
});

test('password reset handles mail failure and mismatch then explains session revocation', async ({
  page,
}) => {
  const state = fixture();
  state.failCode = true;
  await installApi(page, state);
  await page.goto('/login');
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    '邮件服务暂时不可用',
  );
  state.failCode = false;
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await page.getByLabel('邮箱验证码', { exact: true }).fill('123456');
  await page
    .getByLabel('密码', { exact: true })
    .fill('A new browser password!');
  await page
    .getByLabel('确认密码', { exact: true })
    .fill('A different password!');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    '两次输入的密码不一致',
  );
  await page
    .getByLabel('确认密码', { exact: true })
    .fill('A new browser password!');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await expect(
    page.getByText('密码已重置，所有旧登录已失效，请重新登录。'),
  ).toBeVisible();
  expect(state.writes.at(-1)?.path).toBe('auth/reset-password');
});

for (const role of ['USER', 'ADMIN'] as const) {
  test(`${role} shows a task message in the notification entry and tracks visible tabs`, async ({
    page,
  }) => {
    const state = fixture();
    state.current = { ...user, role };
    await installApi(page, state);
    await page.goto(role === 'ADMIN' ? '/admin' : '/tasks');
    await expect
      .poll(
        () =>
          state.presenceWrites.filter((item) => item.method === 'POST').length,
      )
      .toBeGreaterThan(0);
    const tabId = state.presenceWrites.find(
      (item) => item.method === 'POST',
    )!.tabId;
    expect(tabId).toMatch(/^[a-f0-9-]{36}$/);
    await page.getByRole('button', { name: '通知', exact: true }).click();
    await expect(page.getByRole('region', { name: '最近通知' })).toContainText(
      '暂无通知',
    );
    await page.getByRole('button', { name: '通知', exact: true }).click();
    const taskId = '00000000-0000-4000-8000-000000000022';
    state.notices.push({
      id: '00000000-0000-4000-8000-000000000033',
      type: 'TASK_MESSAGE',
      taskId,
      moderationId: null,
      messageId: '00000000-0000-4000-8000-000000000044',
      activityId: null,
      createdAt: new Date().toISOString(),
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      page.getByRole('status').filter({ hasText: '收到新的任务消息' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '通知，有新消息' }).click();
    await expect(
      page
        .getByRole('region', { name: '最近通知' })
        .getByRole('link', { name: /新聊天消息/ }),
    ).toHaveAttribute(
      'href',
      role === 'ADMIN'
        ? `/admin/tasks/detail?id=${taskId}`
        : `/tasks/detail?id=${taskId}#discussion`,
    );
    const postsBefore = state.presenceWrites.filter(
      (item) => item.method === 'POST',
    ).length;
    const deletesBefore = state.presenceWrites.filter(
      (item) => item.method === 'DELETE',
    ).length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(
        () =>
          state.presenceWrites.filter((item) => item.method === 'DELETE')
            .length,
      )
      .toBeGreaterThan(deletesBefore);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(
        () =>
          state.presenceWrites.filter((item) => item.method === 'POST').length,
      )
      .toBeGreaterThan(postsBefore);
  });
  test(`${role} verifies a legacy mailbox before opting in and can unsubscribe`, async ({
    page,
  }, testInfo) => {
    const state = fixture();
    state.current = { ...user, role };
    await installApi(page, state);
    await page.goto('/login');
    await page.getByRole('link', { name: '账户设置', exact: true }).click();
    await expect(page).toHaveURL(
      role === 'ADMIN' ? /\/admin\/settings$/ : /\/settings$/,
    );
    const navigation = page.getByRole('navigation', {
      name: role === 'ADMIN' ? '管理员导航' : '主导航',
    });
    await expect(
      navigation.getByRole('link', { name: '账户设置', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '账户信息' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
    const emailPanel = page.getByRole('region', { name: '邮箱与通知' });
    const subscription = page.getByRole('switch', {
      name: '订阅聊天新消息邮件',
    });
    await expect(subscription).toBeDisabled();
    await expect(subscription).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath('workspace-verification.png'),
      fullPage: true,
    });
    await emailPanel
      .getByRole('button', { name: '获取验证码', exact: true })
      .click();
    await emailPanel.getByLabel('邮箱验证码', { exact: true }).fill('123456');
    await emailPanel
      .getByRole('button', { name: '验证邮箱', exact: true })
      .click();
    await expect(subscription).toBeEnabled();
    await subscription.check();
    await expect(page.getByText('已订阅聊天新消息邮件。')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('workspace-settings.png'),
      fullPage: true,
    });
    state.failSave = true;
    await subscription.click();
    await expect(page.locator('main').getByRole('alert')).toContainText(
      '邮件服务暂时不可用',
    );
    await expect(subscription).toBeChecked();
    state.failSave = false;
    await subscription.uncheck();
    await expect(page.getByText('已关闭聊天邮件订阅。')).toBeVisible();
    expect(
      state.writes.filter((w) => w.path === 'notifications/preferences').at(-1)
        ?.body,
    ).toEqual({ messageEmailEnabled: false });
  });

  test(`${role} resets a password inside the workspace and returns to its login`, async ({
    page,
  }) => {
    const state = fixture();
    state.current = { ...user, role };
    state.verified = true;
    await installApi(page, state);
    const path = role === 'ADMIN' ? '/admin/settings' : '/settings';
    await page.goto(path);
    const security = page.getByRole('region', { name: '账户安全' });
    await security
      .getByRole('button', { name: '重置密码', exact: true })
      .click();
    await security
      .getByRole('button', { name: '获取验证码', exact: true })
      .click();
    await security.getByLabel('邮箱验证码', { exact: true }).fill('123456');
    await security
      .getByLabel('新密码', { exact: true })
      .fill('A new workspace password!');
    await security
      .getByLabel('确认新密码', { exact: true })
      .fill('A new workspace password!');
    await security.getByRole('button', { name: '确认重置密码' }).click();
    await expect(
      page.getByText('密码已重置，所有旧登录已失效，请重新登录。'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '登录', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    expect(state.writes.at(-1)).toEqual({
      path: 'auth/reset-password',
      body: {
        email: user.email,
        password: 'A new workspace password!',
        code: '123456',
      },
    });
  });
}

test('administrator navigation and model configuration use Chinese labels within the workspace', async ({
  page,
}) => {
  const state = fixture();
  state.current = { ...user, role: 'ADMIN' };
  await installApi(page, state);
  await page.goto('/admin/settings');
  const navigation = page.getByRole('navigation', { name: '管理员导航' });
  await expect(navigation.getByRole('link')).toHaveText([
    '工作概览',
    '任务管理',
    '用户管理',
    '人工审核',
    '模型配置',
    '账户设置',
  ]);
  for (const [name, title] of [
    ['工作概览', '今日队列'],
    ['任务管理', '任务列表'],
    ['用户管理', '用户管理'],
    ['人工审核', '人工审核'],
    ['模型配置', '模型配置'],
  ]) {
    await navigation.getByRole('link', { name, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('link', { name, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  }
  await expect(
    page.getByText('OpenAI 兼容协议', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '模型', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '接口密钥', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '新增服务商' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('服务地址')).toBeVisible();
  await expect(dialog.getByLabel('模型名称')).toBeVisible();
  await expect(dialog.getByLabel('接口密钥')).toBeVisible();
});

test('a publisher cannot open administrator account settings', async ({
  page,
}) => {
  const state = fixture();
  state.current = user;
  await installApi(page, state);
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(page.getByRole('region', { name: '邮箱与通知' })).toHaveCount(0);
});
