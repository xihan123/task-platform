'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { TaskListScope, UserDto } from '../../lib/types';
import { usePublicTaskStats, useTasks } from '../../hooks/use-tasks';
import {
  dateText,
  taskErrorText,
  taskTypeLabel,
} from '../../lib/task-presentation';
import { StatusBadge } from '../task-status';
import {
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  StatusGlyph,
} from '../icons';
import { MyConversations } from '../chat/my-conversations';

export function TaskList({ user }: { user: UserDto | null }) {
  const params = useSearchParams();
  const router = useRouter();
  const scope: TaskListScope =
    params.get('scope') === 'mine' ? 'mine' : 'public';
  const allowed = scope === 'public' || user?.role === 'USER';
  const scopes = ['public', 'mine'] as const;
  return (
    <>
      <div className="sec-head">
        <h1 className="sec-title">任务列表</h1>
      </div>
      <div className="task-tabs" role="tablist" aria-label="任务范围">
        {scopes.map((item, index) => (
          <button
            key={item}
            id={`task-tab-${item}`}
            className={`btn ${scope === item ? 'btn-pri' : 'btn-ghost'}`}
            type="button"
            role="tab"
            aria-selected={scope === item}
            aria-controls="task-list-panel"
            tabIndex={scope === item ? 0 : -1}
            onClick={() =>
              router.push(`/tasks?scope=${item}`, { scroll: false })
            }
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs?.[next]?.focus();
              router.push(`/tasks?scope=${scopes[next]}`, { scroll: false });
            }}
          >
            {item === 'public' ? '公开广场' : '我的任务'}
          </button>
        ))}
      </div>
      <section
        id="task-list-panel"
        role="tabpanel"
        aria-labelledby={`task-tab-${scope}`}
      >
        {allowed ? (
          <TaskFeed
            key={`${user?.id ?? 'anonymous'}:${user?.role ?? ''}:${scope}`}
            user={user}
            scope={scope}
          />
        ) : (
          <div className="panel task-list-prompt">
            <p className="task-help">
              {user
                ? '管理员负责接取任务，请前往任务管理。'
                : '登录后查看自己发布的全部任务。'}
            </p>
            <Link
              className="btn btn-pri"
              href={user ? '/admin/tasks' : '/login'}
            >
              {user ? '前往任务管理' : '登录 / 注册'}
            </Link>
          </div>
        )}
      </section>
    </>
  );
}

function TaskFeed({
  user,
  scope,
}: {
  user: UserDto | null;
  scope: TaskListScope;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const { data, error, loading, reload } = useTasks(user, {
    scope,
    cursor: cursors.at(-1),
  });
  const stats = usePublicTaskStats(scope === 'public');
  const publicCounts = stats.data;
  const statItems = [
    { key: 'open', status: 'OPEN', label: '待接取', style: 'open' },
    {
      key: 'inProgress',
      status: 'IN_PROGRESS',
      label: '进行中',
      style: 'progress',
    },
    {
      key: 'completed',
      status: 'COMPLETED',
      label: '已完成',
      style: 'completed',
    },
  ] as const;
  return (
    <>
      <div className="sec-head">
        <span className="sec-note">
          {scope === 'public'
            ? '浏览已通过审核的待接取、进行中和已完成任务'
            : '你发布的全部任务，包含待审核和已取消任务'}
        </span>
        <div className="sec-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              reload();
              if (scope === 'public') stats.reload();
            }}
            disabled={loading}
          >
            <IconRefresh size={13} />
            刷新列表
          </button>
        </div>
      </div>
      {scope === 'public' &&
        (stats.error ? (
          <div role="alert" className="state-box public-stats-status">
            <p>公开统计暂时无法获取。</p>
            <button className="btn" onClick={stats.reload}>
              重试统计
            </button>
          </div>
        ) : publicCounts ? (
          <dl className="public-stats" aria-label="公开任务统计">
            {statItems.map((item) => (
              <div
                className={`public-stat public-stat-${item.style}`}
                key={item.key}
              >
                <dt>
                  <StatusGlyph status={item.status} size={13} />
                  {item.label}
                </dt>
                <dd className="num">{publicCounts[item.key]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status" className="task-help public-stats-status">
            正在加载公开统计...
          </p>
        ))}
      {error ? (
        <div role="alert" className="state-box">
          <p>{taskErrorText(error)}</p>
          <button className="btn" onClick={reload}>
            重试
          </button>
        </div>
      ) : !data ? (
        <p role="status">正在加载任务...</p>
      ) : !data.items.length ? (
        <div className="panel task-list-prompt">
          <p className="task-help">
            {scope === 'public' ? '暂无公开任务。' : '你还没有发布任务。'}
          </p>
          {scope === 'mine' && (
            <Link className="btn btn-pri" href="/tasks/new">
              发布第一个任务
            </Link>
          )}
        </div>
      ) : (
        <section className="panel">
          <div className="pub-list">
            {data.items.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/detail?id=${task.id}`}
                className="pub-row"
              >
                <div>
                  <div className="t-title">{task.title}</div>
                  <div className="sum">{task.summary}</div>
                </div>
                <span className="type mono">{taskTypeLabel(task.type)}</span>
                <time dateTime={task.createdAt}>
                  {dateText(task.createdAt)}
                </time>
                <span className="st-cell">
                  <StatusBadge status={task.status} />
                </span>
              </Link>
            ))}
          </div>
          {scope === 'mine' && (
            <div className="q-foot">
              待审核任务通过审核后进入公开广场，完整需求仅你与管理员可见。
            </div>
          )}
        </section>
      )}
      <nav className="pager pub-pager" aria-label="任务分页">
        <span className="pg">
          第 <b className="num">{cursors.length}</b> 页
        </span>
        <div className="pg-btns">
          <button
            className="btn btn-ic"
            disabled={loading || cursors.length <= 1}
            onClick={() => setCursors((items) => items.slice(0, -1))}
            aria-label="上一页"
            title="上一页"
          >
            <IconChevronLeft size={14} />
          </button>
          <button
            className="btn btn-ic"
            disabled={loading || !data?.nextCursor}
            onClick={() => {
              if (data?.nextCursor)
                setCursors((items) => [...items, data.nextCursor!]);
            }}
            aria-label="下一页"
            title="下一页"
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      </nav>
      {scope === 'mine' && data && !error && <MyConversations />}
    </>
  );
}
