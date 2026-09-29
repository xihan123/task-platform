'use client';

import Link from 'next/link';
import type { PublicTaskDto } from '../../lib/types';
import { adminApi } from '../../lib/admin-api';
import { waitDurationText } from '../../lib/task-presentation';
import { useAdminData } from './use-admin-data';
import { dateText, Empty, ErrorState, Loading } from './common';
import { IconRefresh, IconShield, StatusGlyph } from '../icons';

function waitDuration(tasks: PublicTaskDto[]): string | null {
  if (!tasks.length) return null;
  const earliest = Math.min(
    ...tasks.map((task) => new Date(task.createdAt).getTime()),
  );
  return waitDurationText(new Date(earliest).toISOString());
}

export function Dashboard() {
  const { data, error, loading, reload } = useAdminData(
    'dashboard',
    adminApi.dashboard,
  );
  const when = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const queues: {
    key: 'open' | 'inProgress' | 'review';
    title: string;
    href: string;
    glyph: 'open' | 'prog' | 'shield';
    tasks: PublicTaskDto[];
    foot: string;
    empty: string;
  }[] = data
    ? [
        {
          key: 'open',
          title: '待接取',
          href: '/admin/tasks?view=OPEN',
          glyph: 'open',
          tasks: data.openTasks,
          foot: '已通过智能审核，等待接取',
          empty: '队列为空',
        },
        {
          key: 'inProgress',
          title: '进行中',
          href: '/admin/tasks?view=IN_PROGRESS',
          glyph: 'prog',
          tasks: data.inProgressTasks,
          foot: '同时进行的任务建议不超过 3 件',
          empty: '队列为空',
        },
        {
          key: 'review',
          title: '待人工审核',
          href: '/admin/moderations',
          glyph: 'shield',
          tasks: data.reviewTasks,
          foot: '智能审核需要人工确认，请检查任务内容',
          empty: '没有待人工审核的任务',
        },
      ]
    : [];
  return (
    <>
      <div className="dash-head">
        <h2>今日队列</h2>
        <button
          className="btn btn-ghost btn-ic"
          onClick={reload}
          aria-label="刷新"
          title="刷新"
        >
          <IconRefresh size={14} />
        </button>
        <div className="when">
          {when}
          <br />
          唯一接取者 · 全天驻留
        </div>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : data ? (
        <>
          <div className="stats">
            <Link href="/admin/tasks?view=OPEN" className="stat stat-hot">
              <div className="stat-k">
                <StatusGlyph status="OPEN" size={13} />
                待接取任务
              </div>
              <div className="stat-n">
                <b className="num">{data.counts.open}</b>
                <span>件等你接手</span>
              </div>
              <div className="stat-note">
                {data.openTasks.length
                  ? `最久的一件已等待 ${waitDuration(data.openTasks)}`
                  : '队列为空，等待新任务'}
              </div>
            </Link>
            <Link href="/admin/tasks?view=IN_PROGRESS" className="stat">
              <div className="stat-k">
                <StatusGlyph status="IN_PROGRESS" size={13} />
                进行中任务
              </div>
              <div className="stat-n">
                <b className="num">{data.counts.inProgress}</b>
                <span>件在你手上</span>
              </div>
              <div className="stat-note">所有进行中任务都由你一人处理</div>
            </Link>
            <Link href="/admin/moderations" className="stat">
              <div className="stat-k">
                <IconShield size={13} />
                待人工审核
              </div>
              <div className="stat-n">
                <b className="num">{data.counts.humanReview}</b>
                <span>件需要人工确认</span>
              </div>
              <div className="stat-note">
                智能审核异常或存在疑问，需要人工确认
              </div>
            </Link>
          </div>
          <div className="queues">
            {queues.map((queue) => (
              <section className="panel" key={queue.key}>
                <div className="panel-head">
                  {queue.glyph === 'shield' ? (
                    <span
                      className="q-icon"
                      style={{ color: 'var(--danger-fg)' }}
                    >
                      <IconShield size={13} />
                    </span>
                  ) : (
                    <span
                      className="q-icon"
                      style={{
                        color:
                          queue.glyph === 'open'
                            ? 'var(--st-open-fg)'
                            : 'var(--st-prog-fg)',
                      }}
                    >
                      <StatusGlyph
                        status={queue.glyph === 'open' ? 'OPEN' : 'IN_PROGRESS'}
                        size={13}
                      />
                    </span>
                  )}
                  <h3>{queue.title}</h3>
                  <Link href={queue.href} className="more">
                    查看全部
                  </Link>
                </div>
                {queue.tasks.length ? (
                  <div className="q-list">
                    {queue.tasks.map((task) => (
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
                ) : (
                  <Empty>{queue.empty}</Empty>
                )}
                <div className="q-foot">{queue.foot}</div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <Empty />
      )}
    </>
  );
}
