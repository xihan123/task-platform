'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import type { PublicTaskDto, TaskStatus } from '../../lib/types';
import { ApiClientError } from '../../lib/api-client';
import { dateText } from '../../lib/task-presentation';
import { StatusBadge } from '../task-status';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconInbox,
  IconRefresh,
} from '../icons';

export { dateText };

export const statusLabels: Record<TaskStatus, string> = {
  PENDING_REVIEW: '待审核',
  OPEN: '待接取',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

export function errorText(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '操作未完成，请重试。';
  const messages: Record<string, string> = {
    TASK_NOT_AVAILABLE: '任务状态已变化，当前无法接取。',
    MODERATION_CONFLICT: '任务内容或审核状态已变化，请刷新后重新审核。',
    TASK_NOT_FOUND: '任务不存在。',
    USER_NOT_FOUND: '用户不存在。',
    ADMIN_PROTECTED: '管理员账户不能被禁用。',
    VALIDATION_ERROR: '提交内容不符合要求，请检查后重试。',
    AI_CONFIG_INVALID: '请检查服务地址、模型名称和接口密钥。',
    AI_CONFIG_UNAVAILABLE: '服务端尚未配置模型密钥的加密凭据。',
    AI_RESOURCE_NOT_FOUND: '模型资源不存在，请刷新。',
    FORBIDDEN: '没有执行此操作的权限。',
    ACCOUNT_DISABLED: '账户已禁用。',
    UNAUTHENTICATED: '登录已失效。',
  };
  return messages[error.code] ?? '服务暂时不可用，请重试。';
}

export { StatusBadge };

export function moderationErrorText(code: string | null | undefined): string {
  if (!code) return '—';
  const messages: Record<string, string> = {
    RATE_LIMITED: '审核服务请求过于频繁',
    SERVER_ERROR: '审核服务异常',
    TIMEOUT: '审核服务响应超时',
    CONNECTION_ERROR: '无法连接审核服务',
    INVALID_RESPONSE: '审核结果格式不正确',
    PROVIDER_REJECTED: '审核服务拒绝请求',
    CONFIG_ERROR: '审核服务配置不完整',
    NO_AVAILABLE_RESOURCES: '没有可用的审核资源',
    ATTEMPT_LIMIT: '审核尝试次数已达上限',
    ROUTER_UNAVAILABLE: '审核服务暂不可用',
    PROCESSING_ERROR: '审核处理异常',
  };
  return messages[code] ?? '审核未完成，请检查模型配置后重试';
}

export function PageHeading({
  title,
  eyebrow,
  children,
  onRefresh,
}: {
  title: string;
  eyebrow: string;
  children?: ReactNode;
  onRefresh?: () => void;
}) {
  return (
    <div className="sec-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="sec-title">{title}</h1>
      </div>
      <div className="sec-actions">
        {children}
        {onRefresh && (
          <button
            className="btn btn-ghost btn-ic"
            onClick={onRefresh}
            aria-label="刷新"
            title="刷新"
          >
            <IconRefresh size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <div role="status" className="empty-state">
      正在加载...
    </div>
  );
}
export function Empty({ children = '暂无记录' }: { children?: ReactNode }) {
  return (
    <div className="empty-state">
      <IconInbox size={28} />
      <p>{children}</p>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <div className="empty-state">
      <p role="alert" className="error-text">
        {errorText(error)}
      </p>
      <button className="btn" onClick={retry}>
        重试
      </button>
    </div>
  );
}

export function TaskPreview({ tasks }: { tasks: PublicTaskDto[] }) {
  if (!tasks.length) return <Empty />;
  return (
    <div className="q-list">
      {tasks.map((task) => (
        <Link
          key={task.id}
          href={`/admin/tasks/detail?id=${task.id}`}
          className="q-row"
        >
          <div className="q-t">{task.title}</div>
          <div className="q-m">
            {task.type} · {dateText(task.createdAt)}
          </div>
        </Link>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  previous,
  next,
  hasNext,
}: {
  page: number;
  previous: () => void;
  next: () => void;
  hasNext: boolean;
}) {
  return (
    <div className="pager">
      <span className="pg">
        第 <b className="num">{page}</b> 页
      </span>
      <div className="pg-btns">
        <button
          className="btn btn-ic"
          disabled={page <= 1}
          onClick={previous}
          title="上一页"
          aria-label="上一页"
        >
          <IconChevronLeft size={14} />
        </button>
        <button
          className="btn btn-ic"
          disabled={!hasNext}
          onClick={next}
          title="下一页"
          aria-label="下一页"
        >
          <IconChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function Modal({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="admin-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-header">
        <h2 id="dialog-title">{title}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-ic"
          title="关闭"
          aria-label="关闭"
          onClick={close}
          disabled={busy}
        >
          <IconClose size={14} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
