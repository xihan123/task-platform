import type { TaskStatus } from './types';
import taskCategories from './task-categories.json';
import { ApiClientError } from './api-client';

export const taskStatusLabels: Record<TaskStatus, string> = {
  PENDING_REVIEW: '待审核',
  OPEN: '待接取',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

export const taskTypeLabel = (type: string): string =>
  taskCategories.find((category) => category.id === type)?.label ?? type;

export const dateText = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export function waitDurationText(value: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

export function taskErrorText(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '服务暂时不可用，请重试。';
  const messages: Record<string, string> = {
    ATTACHMENT_INVALID: '附件已过期或不可用，请移除后重新上传。',
    TASK_NOT_FOUND: '任务不存在。',
    TASK_NOT_EDITABLE: '任务已不在待审核状态，无法编辑。',
    TASK_NOT_CANCELLABLE: '任务已结束，无法取消。',
    TASK_CONFLICT: '任务状态已变化，请查看最新状态后重试。',
    RATE_LIMITED: '操作过于频繁，请稍后重试。',
    UNAUTHENTICATED: '登录已失效，请前往登录页面重新登录。',
    ACCOUNT_DISABLED: '账户已被禁用。',
    FORBIDDEN: '没有执行此操作的权限。',
    VALIDATION_ERROR: '请检查各项内容和长度后重试。',
    CSRF_REJECTED: '请求未通过安全校验，请刷新页面后重试。',
  };
  return messages[error.code] ?? '服务暂时不可用，请重试。';
}
