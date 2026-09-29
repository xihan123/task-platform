'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AttachmentDto, TaskStatus, UserDto } from '../../lib/types';
import { AttachmentList, AttachmentPicker } from '../attachments';
import { useTaskChat } from '../../hooks/use-task-chat';
import { ApiClientError } from '../../lib/api-client';
import { adminApi } from '../../lib/admin-api';
import { tasksApi } from '../../lib/tasks-api';
import { useTaskCompletion } from '../../hooks/use-task-completion';
import './task-chat.css';
import {
  IconCheck,
  IconChevronUp,
  IconClock,
  IconRefresh,
  IconSend,
} from '../icons';

const errors: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  ACCOUNT_DISABLED: '账户已被禁用。',
  CONVERSATION_FORBIDDEN: '无权访问此任务会话。',
  TASK_NOT_FOUND: '任务不存在。',
  CONVERSATION_NOT_FOUND: '会话不存在，请联系管理员。',
  CHAT_REPLY_LIMIT: '请等待管理员回复，最多连续发送 3 条消息。',
  ATTACHMENT_INVALID: '附件已过期或不可用，请移除后重新上传。',
  CHAT_READ_ONLY: '当前任务不可发送消息。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
  TASKS_UNAVAILABLE: '任务操作暂不可用，请稍后再试。',
  MESSAGE_CONFLICT: '此消息已提交，请刷新历史记录。',
  VALIDATION_ERROR: '消息需要包含 1 至 5000 个字符。',
  FORBIDDEN: '无权执行此操作。',
  TASK_NOT_IN_PROGRESS: '任务状态已变更，请刷新。',
  COMPLETION_NOT_REQUESTED: '管理员尚未请求完成。',
};

export function TaskChat({
  taskId,
  user,
  status,
  onStatusChange,
}: {
  taskId: string;
  user: UserDto;
  status: TaskStatus;
  onStatusChange?: () => void;
}) {
  return (
    <ChatContent
      key={`${taskId}:${user.id}`}
      taskId={taskId}
      user={user}
      status={status}
      onStatusChange={onStatusChange}
    />
  );
}

function ChatContent({
  taskId,
  user,
  status,
  onStatusChange,
}: {
  taskId: string;
  user: UserDto;
  status: TaskStatus;
  onStatusChange?: () => void;
}) {
  const chat = useTaskChat(taskId, user.id);
  const completion = useTaskCompletion(taskId, user);
  const currentStatus = ['COMPLETED', 'CANCELLED'].includes(status)
    ? status
    : (completion.data?.status ?? status);
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState('');
  useEffect(() => {
    if (completion.data && completion.data.status !== status)
      onStatusChange?.();
  }, [completion.data, status, onStatusChange]);
  async function complete() {
    if (completing) return;
    setCompleting(true);
    setCompletionError('');
    try {
      if (user.role === 'ADMIN') await adminApi.requestCompletion(taskId);
      else await tasksApi.confirmCompletion(taskId);
      completion.reload();
    } catch (error) {
      setCompletionError(
        error instanceof ApiClientError
          ? (errors[error.code] ?? '操作失败，请重试。')
          : '操作失败，请重试。',
      );
      completion.reload();
    } finally {
      setCompleting(false);
    }
  }
  const [files, setFiles] = useState<AttachmentDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sendError, setSendError] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    if (window.location.hash === '#discussion')
      document.getElementById('discussion')?.scrollIntoView({ block: 'start' });
  }, [taskId]);
  useEffect(() => {
    const check = () => {
      nearBottom.current =
        document.documentElement.scrollHeight -
          window.scrollY -
          window.innerHeight <
        180;
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);
  const lastId = chat.messages.at(-1)?.id;
  useEffect(() => {
    if (nearBottom.current && viewport.current)
      viewport.current.closest('section')?.scrollIntoView({ block: 'end' });
  }, [lastId]);
  const blocked =
    !!chat.error &&
    [
      'UNAUTHENTICATED',
      'ACCOUNT_DISABLED',
      'CONVERSATION_FORBIDDEN',
      'TASK_NOT_FOUND',
    ].includes(chat.error);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = content.trim();
    if ((!message && !files.length) || pending || uploading || !chat.canSend)
      return;
    setPending(true);
    setSendError('');
    try {
      nearBottom.current = true;
      await chat.send(
        message,
        files.map((file) => file.id),
      );
      setFiles([]);
      setContent('');
    } catch (error) {
      setSendError(
        error instanceof ApiClientError
          ? (errors[error.code] ?? '发送失败，可重试此消息。')
          : '发送失败，可重试此消息。',
      );
    } finally {
      setPending(false);
    }
  }
  async function older() {
    setLoadingOlder(true);
    setSendError('');
    const height = document.documentElement.scrollHeight;
    try {
      await chat.older();
      requestAnimationFrame(() => {
        if (viewport.current)
          window.scrollBy(0, document.documentElement.scrollHeight - height);
      });
    } catch {
      setSendError('历史消息加载失败，请重试。');
    } finally {
      setLoadingOlder(false);
    }
  }
  return (
    <section
      id="discussion"
      className="task-chat issue-discussion"
      aria-label="任务会话"
    >
      <header className="chat-header">
        <h3>讨论</h3>
        <div>
          <span
            className={`chat-connection ${chat.connected ? 'online' : ''}`}
            role="status"
          >
            {chat.connected ? '已连接' : '未连接'}
          </span>
          <button
            type="button"
            className="chat-icon"
            onClick={() => {
              chat.refresh();
              completion.reload();
            }}
            aria-label="刷新会话"
            title="刷新会话"
          >
            <IconRefresh size={13} />
          </button>
        </div>
      </header>
      {chat.error && (
        <p className="chat-error" role="alert">
          {errors[chat.error] ?? '暂时无法同步消息，请重试。'}
        </p>
      )}
      <div ref={viewport} className="chat-history">
        {chat.olderCursor && (
          <div className="chat-history-control">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void older()}
              disabled={loadingOlder}
            >
              <IconChevronUp size={12} />
              {loadingOlder ? '加载中...' : '更早的消息'}
            </button>
          </div>
        )}
        {chat.loading ? (
          <p className="chat-empty" role="status">
            正在加载会话...
          </p>
        ) : !chat.messages.length && !blocked ? (
          <p className="chat-empty">暂无消息</p>
        ) : (
          <ol className="chat-messages">
            {chat.messages.map((message) => (
              <li
                key={message.id}
                data-initial={
                  message.senderId === user.id
                    ? user.role === 'ADMIN'
                      ? '管'
                      : '发'
                    : user.role === 'ADMIN'
                      ? '发'
                      : '管'
                }
                className={message.senderId === user.id ? 'own-message' : ''}
              >
                <div className="message-meta">
                  <span>
                    {message.senderId === user.id
                      ? '我'
                      : user.role === 'ADMIN'
                        ? '发布者'
                        : '管理员'}
                  </span>
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </time>
                </div>
                {message.content && <p>{message.content}</p>}
                <AttachmentList files={message.attachments ?? []} />
              </li>
            ))}
          </ol>
        )}
      </div>
      {sendError && (
        <p role="alert" className="chat-error">
          {sendError}
        </p>
      )}
      <div className="task-completion">
        <IconClock size={14} />
        <p role="status">
          {currentStatus === 'COMPLETED'
            ? '任务已完成'
            : currentStatus === 'CANCELLED'
              ? '任务已取消'
              : completion.data?.requestedAt
                ? user.role === 'ADMIN'
                  ? '待发布者确认完成'
                  : '管理员已请求完成'
                : currentStatus === 'IN_PROGRESS'
                  ? '任务进行中'
                  : '任务尚未接取'}
        </p>
        {currentStatus === 'IN_PROGRESS' &&
          (user.role === 'ADMIN' || completion.data?.requestedAt) && (
            <button
              type="button"
              className={user.role === 'ADMIN' ? 'btn btn-pri' : 'btn'}
              onClick={() => void complete()}
              disabled={
                completing ||
                !completion.data ||
                (user.role === 'ADMIN' && !!completion.data.requestedAt)
              }
            >
              <IconCheck size={13} />
              {completing
                ? '提交中...'
                : user.role === 'ADMIN'
                  ? '请求完成'
                  : '确认完成'}
            </button>
          )}
      </div>
      {(completion.error || completionError) && (
        <p role="alert" className="chat-error">
          {completionError ||
            errors[completion.error!] ||
            '无法同步任务完成状态，请刷新。'}
        </p>
      )}
      {['COMPLETED', 'CANCELLED'].includes(currentStatus) ? (
        <p className="chat-readonly">当前任务会话为只读。</p>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          className="chat-composer"
        >
          <label htmlFor={`message-${taskId}`} className="chat-label sr-only">
            消息
          </label>
          <textarea
            id={`message-${taskId}`}
            rows={2}
            maxLength={5000}
            placeholder="输入消息"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={pending || blocked || !chat.canSend}
          />
          <AttachmentPicker
            files={files}
            onChange={setFiles}
            onBusy={setUploading}
            disabled={pending || blocked || !chat.canSend}
          />
          {user.role === 'USER' && (
            <p role="status" className="chat-quota">
              {chat.remainingMessages === 0
                ? '已连续发送 3 条，请等待管理员回复。'
                : `管理员回复前还可发送 ${chat.remainingMessages ?? 3} 条消息。`}
            </p>
          )}
          <div>
            <span>{content.length} / 5000</span>
            <button
              type="submit"
              className="btn btn-pri chat-send"
              disabled={
                pending ||
                uploading ||
                blocked ||
                !chat.canSend ||
                (!content.trim() && !files.length)
              }
            >
              <IconSend size={13} />
              {pending ? '发送中...' : '发送'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
