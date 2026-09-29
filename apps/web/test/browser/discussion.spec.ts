import { expect, test, type Page } from '@playwright/test';
import type {
  AttachmentDto,
  MessageDto,
  PrivateTaskDto,
  UserDto,
  TaskModerationDto,
} from '../../lib/types';

const taskId = '00000000-0000-4000-8000-000000000901';
const publisher: UserDto = {
  id: '00000000-0000-4000-8000-000000000902',
  email: 'publisher@discussion.test',
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const admin: UserDto = {
  ...publisher,
  id: '00000000-0000-4000-8000-000000000903',
  role: 'ADMIN',
  email: 'admin@discussion.test',
};
const uploaded: AttachmentDto = {
  id: '00000000-0000-4000-8000-000000000904',
  fileName: 'requirements.txt',
  size: 3,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  deleted: false,
};

function fixture() {
  const task: PrivateTaskDto = {
    id: taskId,
    publisherId: publisher.id,
    title: '统一任务讨论',
    summary: '公共摘要',
    description: '请在这里确认交付细节。',
    type: '开发',
    status: 'PENDING_REVIEW',
    createdAt: publisher.createdAt,
    updatedAt: publisher.createdAt,
    attachments: [
      {
        ...uploaded,
        id: '00000000-0000-4000-8000-000000000905',
        fileName: '旧需求.zip',
        deleted: true,
        expiresAt: publisher.createdAt,
      },
    ],
    reviewFeedback: {
      source: 'MANUAL',
      reason: '请补充接口字段和验收步骤。',
      reviewedAt: publisher.createdAt,
    },
  };
  const moderation: TaskModerationDto = {
    id: '00000000-0000-4000-8000-000000000906',
    taskId,
    status: 'ERROR',
    source: 'AI',
    reviewerId: null,
    promptVersion: '1.0.0',
    decision: null,
    riskLevel: null,
    categories: [],
    reason: null,
    confidence: null,
    categoryMatch: null,
    suggestedType: null,
    errorCode: 'TIMEOUT',
    attempts: 1,
    createdAt: publisher.createdAt,
    completedAt: publisher.createdAt,
  };
  return {
    task,
    moderation,
    remaining: 3,
    messages: [] as MessageDto[],
    uploads: 0,
    dropNextSend: false,
    writes: [] as { path: string; body: Record<string, unknown> }[],
    policy: { retentionDays: 7, maxSizeMb: 5 },
  };
}

async function install(
  page: Page,
  state: ReturnType<typeof fixture>,
  user = publisher,
) {
  await page.routeWebSocket('**/api/tasks/*/events', (socket) =>
    socket.close(),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api', '');
    if (path === '/auth/me') {
      await route.fulfill({ json: { user } });
      return;
    }
    if (path === '/notifications') {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === '/notifications/presence') {
      expect(request.headers()['x-csrf-protection']).toBe('1');
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/notifications/preferences') {
      await route.fulfill({
        json: {
          emailVerifiedAt: publisher.createdAt,
          messageEmailEnabled: false,
        },
      });
      return;
    }
    if (path === '/attachments/policy') {
      await route.fulfill({ json: state.policy });
      return;
    }
    if (path === '/attachments') {
      expect(request.headers()['content-type']).toContain(
        'multipart/form-data; boundary=',
      );
      expect(request.headers()['x-csrf-protection']).toBe('1');
      state.uploads++;
      await route.fulfill({ status: 201, json: uploaded });
      return;
    }
    if (request.method() === 'PATCH' || request.method() === 'POST') {
      const body = request.postData()
        ? (request.postDataJSON() as Record<string, unknown>)
        : {};
      state.writes.push({ path, body });
      if (
        path ===
        `/admin/tasks/${taskId}/moderations/${state.moderation.id}/retry`
      ) {
        state.moderation = {
          ...state.moderation,
          id: '00000000-0000-4000-8000-000000000907',
          status: 'PENDING',
          errorCode: null,
          attempts: 0,
        };
        await route.fulfill({ status: 204 });
        return;
      }
      if (path === '/admin/settings/attachments') {
        state.policy = body as typeof state.policy;
        await route.fulfill({ json: state.policy });
        return;
      }
      if (path === `/admin/tasks/${taskId}/review`) {
        const approved = body.decision === 'PASS';
        state.moderation = {
          ...state.moderation,
          source: 'MANUAL',
          status: 'COMPLETED',
          decision: approved ? 'PASS' : 'REJECT',
          reason: approved ? (body.reason as string) : null,
          categoryMatch: null,
          suggestedType: null,
        };
        state.task = {
          ...state.task,
          ...(approved
            ? {
                status: 'OPEN',
                type: body.type as string,
                reviewFeedback: null,
              }
            : {
                reviewFeedback: {
                  reason: null,
                  source: 'MANUAL',
                  reviewedAt: new Date().toISOString(),
                },
              }),
        };
        await route.fulfill({ json: state.task });
        return;
      }
      if (path === `/tasks/${taskId}`) {
        state.task = { ...state.task, ...body, reviewFeedback: null };
        await route.fulfill({ json: state.task });
        return;
      }
      if (path === `/tasks/${taskId}/messages`) {
        expect(state.remaining).toBeGreaterThan(0);
        const message: MessageDto = {
          id: body.id as string,
          conversationId: taskId,
          senderId: user.id,
          content: body.content as string,
          attachments: (body.attachmentIds as string[]).length
            ? [uploaded]
            : [],
          createdAt: new Date().toISOString(),
        };
        state.messages.push(message);
        state.remaining--;
        if (state.dropNextSend) {
          state.dropNextSend = false;
          await route.abort();
          return;
        }
        await route.fulfill({ status: 201, json: message });
        return;
      }
    }
    if (path === `/tasks/${taskId}/messages`) {
      const after = url.searchParams.get('after');
      await route.fulfill({
        json: {
          conversationId: taskId,
          items: after
            ? state.messages.slice(
                state.messages.findIndex((item) => item.id === after) + 1,
              )
            : state.messages,
          olderCursor: null,
          newerCursor: null,
          canSend: user.role === 'ADMIN' || state.remaining > 0,
          remainingMessages: user.role === 'ADMIN' ? null : state.remaining,
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
    if (path === `/admin/tasks/${taskId}/moderations`) {
      await route.fulfill({ json: [state.moderation] });
      return;
    }
    if (path === `/tasks/${taskId}` || path === `/admin/tasks/${taskId}`) {
      await route.fulfill({
        json: { ...state.task, publisher, moderation: state.moderation },
      });
      return;
    }
    throw new Error(`Unexpected request: ${request.method()} ${path}`);
  });
}

test('detail contains revision feedback, expiring attachments and a three-message discussion', async ({
  page,
}, info) => {
  const state = fixture();
  await install(page, state);
  await page.goto(`/tasks/detail?id=${taskId}#discussion`);
  await expect(page).toHaveURL(`/tasks/detail?id=${taskId}#discussion`);
  await expect(page.getByRole('region', { name: '审核退回' })).toContainText(
    '请补充接口字段和验收步骤。',
  );
  await expect(page.getByRole('button', { name: '旧需求.zip' })).toBeDisabled();
  const chat = page.getByRole('region', { name: '任务会话' });
  await expect(chat.getByText('管理员回复前还可发送 3 条消息。')).toBeVisible();
  await chat.getByLabel('添加附件').setInputFiles({
    name: 'too-large.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(chat.getByRole('alert')).toContainText('不限速网盘');
  expect(state.uploads).toBe(0);
  const attachmentButton = chat.getByRole('button', { name: '添加附件' });
  await expect(attachmentButton).toBeEnabled();
  const chooserPromise = page.waitForEvent('filechooser');
  await attachmentButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'requirements.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('123'),
  });
  await expect(
    chat.getByRole('button', { name: '发送', exact: true }),
  ).toBeEnabled();
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    chat.getByRole('button', { name: 'requirements.txt', exact: true }),
  ).toBeVisible();
  for (const text of ['第二条补充', '第三条补充']) {
    if (text === '第三条补充') state.dropNextSend = true;
    await chat.getByRole('textbox', { name: '消息' }).fill(text);
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      chat.getByRole('list').getByText(text, { exact: true }),
    ).toBeVisible();
    await expect(chat.getByRole('textbox', { name: '消息' })).toHaveValue('');
  }
  await expect(chat.getByRole('textbox', { name: '消息' })).toBeDisabled();
  await expect(attachmentButton).toBeDisabled();
  await expect(
    chat.getByText('已连续发送 3 条，请等待管理员回复。'),
  ).toBeVisible();
  state.remaining = 3;
  state.messages.push({
    id: '00000000-0000-4000-8000-000000000907',
    conversationId: taskId,
    senderId: admin.id,
    content: '已收到，请继续补充。',
    attachments: [],
    createdAt: new Date().toISOString(),
  });
  await chat.getByRole('button', { name: '刷新会话' }).click();
  await expect(chat.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(chat.getByText('已收到，请继续补充。')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('discussion.png'),
    fullPage: true,
  });
});

test('pending refresh preserves the unsent discussion draft', async ({
  page,
}) => {
  const state = fixture();
  state.task.reviewFeedback = null;
  await install(page, state);
  await page.goto(`/tasks/detail?id=${taskId}`);
  const input = page.getByRole('textbox', { name: '消息' });
  await input.fill('还未发送的草稿');
  await page.waitForTimeout(5500);
  await expect(input).toHaveValue('还未发送的草稿');
  expect(state.writes).toEqual([]);
});

test('ADMIN returns a task without a reason and adjusts attachment policy', async ({
  page,
}, info) => {
  const state = fixture();
  state.task.reviewFeedback = null;
  await install(page, state, admin);
  await page.goto(`/admin/tasks/detail?id=${taskId}`);
  await page.getByRole('button', { name: '退回修改', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '退回理由（选填）' }),
  ).not.toHaveAttribute('required', '');
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByText('任务已退回，等待发布者修改。')).toBeVisible();
  expect(state.writes[0]!.body.reason).toBe('');
  await page.screenshot({
    path: info.outputPath('admin-detail.png'),
    fullPage: true,
  });
  await page.goto('/admin/settings');
  await page.getByLabel('保留天数', { exact: true }).fill('14');
  await page.getByLabel('单文件大小上限（MB）', { exact: true }).fill('8');
  await page.getByRole('button', { name: '保存附件设置' }).click();
  await expect(
    page.getByText('附件设置已保存。保留天数仅影响新上传附件。'),
  ).toBeVisible();
  expect(state.policy).toEqual({ retentionDays: 14, maxSizeMb: 8 });
});

test('ADMIN can retry a failed AI review from the task detail', async ({
  page,
}) => {
  const state = fixture();
  state.task.reviewFeedback = null;
  await install(page, state, admin);
  await page.goto(`/admin/tasks/detail?id=${taskId}`);
  await page.getByRole('button', { name: '重试智能审核' }).click();
  await page.getByRole('button', { name: '确认重试' }).click();
  await expect(page.getByText('智能审核已重新排队。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试智能审核' })).toHaveCount(
    0,
  );
  expect(state.writes[0]!.path).toBe(
    `/admin/tasks/${taskId}/moderations/00000000-0000-4000-8000-000000000906/retry`,
  );
});

test('ADMIN confirms a mismatched category before approving', async ({
  page,
}) => {
  const state = fixture();
  state.task.type = 'web_frontend';
  state.task.reviewFeedback = null;
  state.moderation = {
    ...state.moderation,
    status: 'COMPLETED',
    decision: 'REVIEW',
    riskLevel: 'LOW',
    reason: '主要交付 Excel 表格，分类不符。',
    categoryMatch: false,
    suggestedType: 'office_docs',
    errorCode: null,
  };
  await install(page, state, admin);
  await page.goto(`/admin/tasks/detail?id=${taskId}`);
  await expect(page.getByText('网站与前端', { exact: true })).toBeVisible();
  await expect(
    page.getByText('待确认 · 建议：表格与办公文档', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '通过审核' }).click();
  await page.getByRole('textbox', { name: '审核理由' }).fill('确认表格交付。');
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('确认任务分类').selectOption('office_docs');
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByText('人工审核已通过。')).toBeVisible();
  expect(state.writes[0]!.body).toMatchObject({
    decision: 'PASS',
    type: 'office_docs',
    reason: '确认表格交付。',
  });
  await expect(page.getByText('表格与办公文档', { exact: true })).toBeVisible();
});
