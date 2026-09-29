'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { AdminNotificationDto, UserDto } from '../lib/types';
import { chatApi } from '../lib/chat-api';
import { usePresence } from '../hooks/use-presence';
import { IconInbox } from './icons';
import './notification-center.css';

function label(type: AdminNotificationDto['type']): string {
  switch (type) {
    case 'TASK_MESSAGE':
      return '新聊天消息';
    case 'TASK_COMPLETION_REQUESTED':
      return '待确认任务完成';
    case 'TASK_REVISION_REQUESTED':
      return '任务需要修改';
    case 'TASK_MODERATION_REVIEW':
      return '任务等待人工审核';
    case 'TASK_MODERATION_ERROR':
      return '智能审核遇到问题';
  }
}

export function NotificationCenter({ user }: { user: UserDto }) {
  usePresence(user.id);
  const [items, setItems] = useState<AdminNotificationDto[]>([]);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || document.visibilityState !== 'visible') return;
      loading = true;
      try {
        const next = await chatApi.notifications(controller.signal);
        if (controller.signal.aborted) return;
        if (
          seen.current &&
          next.some(
            (item) =>
              item.type === 'TASK_MESSAGE' && !seen.current!.has(item.id),
          )
        )
          setFresh(true);
        seen.current = new Set(next.map((item) => item.id));
        setItems(next);
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        loading = false;
      }
    }
    const onResume = () => void refresh();
    const timer = window.setInterval(onResume, 5000);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    void refresh();
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [user.id]);

  return (
    <div className="notification-center">
      <button
        className="btn btn-ghost notification-trigger"
        type="button"
        aria-label={fresh ? '通知，有新消息' : '通知'}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setFresh(false);
        }}
      >
        <IconInbox size={16} />
        <span>通知</span>
        {fresh && <span className="notification-dot" aria-hidden="true" />}
      </button>
      {fresh && (
        <span className="notification-live" role="status">
          收到新的任务消息
        </span>
      )}
      {open && (
        <section className="notification-panel" aria-label="最近通知">
          <h2>最近通知</h2>
          {error && <p role="alert">通知暂时无法更新。</p>}
          {!items.length ? (
            <p>暂无通知</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={
                      user.role === 'ADMIN'
                        ? `/admin/tasks/detail?id=${item.taskId}`
                        : `/tasks/detail?id=${item.taskId}${item.type === 'TASK_MESSAGE' ? '#discussion' : ''}`
                    }
                    onClick={() => setOpen(false)}
                  >
                    <strong>{label(item.type)}</strong>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString('zh-CN')}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
