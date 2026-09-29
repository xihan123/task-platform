'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ConversationListResponse } from '../../lib/types';
import { chatApi } from '../../lib/chat-api';
import './task-chat.css';
import { IconChevronLeft, IconChevronRight } from '../icons';

export function MyConversations() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const [result, setResult] = useState<{
    cursor?: string;
    data?: ConversationListResponse;
    error?: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void chatApi.conversations(cursor, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ cursor, data });
      },
      () => {
        if (!controller.signal.aborted) setResult({ cursor, error: true });
      },
    );
    return () => controller.abort();
  }, [cursor]);
  const data = result?.cursor === cursor ? result?.data : undefined;
  return (
    <section className="my-conversations panel">
      <h3>任务会话</h3>
      {result?.error ? (
        <p role="alert">暂时无法加载会话。</p>
      ) : !data ? (
        <p role="status">加载中...</p>
      ) : !data.items.length ? (
        <p>暂无任务会话</p>
      ) : (
        <ul className="chat-task-links">
          {data.items.map((task) => (
            <li key={task.taskId}>
              <Link href={`/tasks/detail?id=${task.taskId}#discussion`}>
                {task.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="conversation-pages">
        <button
          className="btn btn-ic"
          aria-label="上一页会话"
          title="上一页"
          disabled={cursors.length <= 1}
          onClick={() => setCursors((items) => items.slice(0, -1))}
        >
          <IconChevronLeft size={14} />
        </button>
        <button
          className="btn btn-ic"
          aria-label="下一页会话"
          title="下一页"
          disabled={!data?.nextCursor}
          onClick={() => setCursors((items) => [...items, data!.nextCursor!])}
        >
          <IconChevronRight size={14} />
        </button>
      </div>
    </section>
  );
}
