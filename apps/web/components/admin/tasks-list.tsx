'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { AdminTaskView } from '../../lib/types';
import { adminApi } from '../../lib/admin-api';
import { taskTypeLabel } from '../../lib/task-presentation';
import { useAdminData } from './use-admin-data';
import {
  dateText,
  Empty,
  ErrorState,
  Loading,
  PageHeading,
  Pagination,
  StatusBadge,
  statusLabels,
  moderationErrorText,
} from './common';

export function TasksList({ moderation = false }: { moderation?: boolean }) {
  const params = useSearchParams();
  const requested = params.get('view') ?? 'ALL';
  const view: AdminTaskView = moderation
    ? 'HUMAN_REVIEW'
    : [
          'ALL',
          'OPEN',
          'IN_PROGRESS',
          'PENDING_REVIEW',
          'COMPLETED',
          'CANCELLED',
        ].includes(requested)
      ? (requested as AdminTaskView)
      : 'ALL';
  return (
    <TasksTable
      key={`${moderation}:${view}`}
      view={view}
      moderation={moderation}
    />
  );
}

function TasksTable({
  view,
  moderation,
}: {
  view: AdminTaskView;
  moderation: boolean;
}) {
  const router = useRouter();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const load = useCallback(
    (signal: AbortSignal) =>
      adminApi.tasks({ view, cursor, limit: 20 }, signal),
    [view, cursor],
  );
  const { data, error, loading, reload } = useAdminData(
    `tasks:${view}:${cursor ?? ''}`,
    load,
  );
  return (
    <>
      <PageHeading
        title={moderation ? '人工审核' : '任务列表'}
        eyebrow={moderation ? '审核中心' : '任务管理'}
        onRefresh={reload}
      />
      <div className="filters">
        {moderation ? (
          <span className="filter-label">待人工审核任务</span>
        ) : (
          <div className="field">
            <label htmlFor="admin-task-view">任务状态</label>
            <select
              id="admin-task-view"
              aria-label="任务状态"
              value={view}
              onChange={(event) =>
                router.push(`/admin/tasks?view=${event.target.value}`)
              }
            >
              <option value="ALL">全部状态</option>
              {Object.entries(statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data?.items.length ? (
        <Empty>{moderation ? '没有待人工审核的任务' : '暂无任务'}</Empty>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="c-task">任务</th>
                  <th>发布者</th>
                  <th>{moderation ? '审核结果' : '状态'}</th>
                  <th>{moderation ? '审核原因' : '创建时间'}</th>
                  <th className="c-act">
                    <span className="sr-only">查看</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((task) => (
                  <tr key={task.id}>
                    <td className="c-task">
                      <Link
                        className="t-title"
                        href={`/admin/tasks/detail?id=${task.id}`}
                      >
                        {task.title}
                      </Link>
                      <div className="t-type">{taskTypeLabel(task.type)}</div>
                    </td>
                    <td>
                      <span className="mail">{task.publisher.email}</span>
                    </td>
                    <td>
                      {moderation ? (
                        <span className="tag tag-warn">
                          {task.moderation?.status === 'ERROR'
                            ? '智能审核异常'
                            : '需人工判断'}
                        </span>
                      ) : (
                        <StatusBadge status={task.status} />
                      )}
                    </td>
                    <td className={moderation ? 'reason-cell' : undefined}>
                      {moderation ? (
                        (task.moderation?.reason ??
                        moderationErrorText(task.moderation?.errorCode))
                      ) : (
                        <time dateTime={task.createdAt}>
                          {dateText(task.createdAt)}
                        </time>
                      )}
                    </td>
                    <td className="c-act">
                      <Link
                        className="btn btn-ghost"
                        title="查看任务"
                        aria-label={`查看 ${task.title}`}
                        href={`/admin/tasks/detail?id=${task.id}`}
                      >
                        查看
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={cursors.length}
            previous={() => setCursors((value) => value.slice(0, -1))}
            next={() => {
              if (data?.nextCursor)
                setCursors((value) => [...value, data.nextCursor!]);
            }}
            hasNext={!loading && !!data?.nextCursor}
          />
        </section>
      )}
    </>
  );
}
