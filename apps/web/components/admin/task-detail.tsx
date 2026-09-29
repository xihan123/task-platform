'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { adminApi } from '../../lib/admin-api';
import { useAdminData } from './use-admin-data';
import { useAdminSession } from './admin-shell';
import { AttachmentList } from '../attachments';
import { TaskChat } from '../chat/task-chat';
import {
  dateText,
  errorText,
  ErrorState,
  Loading,
  Modal,
  moderationErrorText,
} from './common';
import { StatusBadge } from '../task-status';
import { IconArrowLeft, IconLock, IconRefresh } from '../icons';
import type { TaskModerationDto } from '../../lib/types';
import taskCategories from '../../lib/task-categories.json';
import { taskTypeLabel } from '../../lib/task-presentation';

function decisionText(record: TaskModerationDto): string {
  if (record.status === 'ERROR') return '异常';
  if (record.status === 'SUPERSEDED') return '已失效';
  if (record.decision === 'PASS') return '通过';
  if (record.decision === 'REJECT') return '拒绝';
  if (record.decision === 'REVIEW') return '待人工判断';
  if (record.status === 'PROCESSING') return '审核中';
  return '排队中';
}

function HistoryRow({ record }: { record: TaskModerationDto }) {
  const manual = record.source === 'MANUAL';
  const warn =
    record.status === 'ERROR' ||
    record.decision === 'REJECT' ||
    record.decision === 'REVIEW';
  const detail =
    record.reason ??
    (record.errorCode ? moderationErrorText(record.errorCode) : null);
  return (
    <li>
      <time dateTime={record.createdAt}>{dateText(record.createdAt)}</time>
      <span
        className={`tag ${manual ? 'tag-ok' : warn ? 'tag-warn' : 'tag-ai'}`}
      >
        {manual
          ? '人工审核'
          : record.status === 'ERROR'
            ? '智能审核异常'
            : '智能审核'}
      </span>
      <p>
        {decisionText(record)}
        {detail ? ` · ${detail}` : ''}
        <span className="hist-meta">
          {record.source === 'AI'
            ? `提示词版本 ${record.promptVersion} · 尝试 ${record.attempts} 次`
            : `审核人 ${record.reviewerId}`}
          {record.riskLevel &&
            ` · ${{ LOW: '低风险', MEDIUM: '中风险', HIGH: '高风险' }[record.riskLevel]}`}
          {record.confidence !== null &&
            ` · 置信度 ${Math.round(record.confidence * 100)}%`}
          {record.categoryMatch !== null &&
            ` · 分类${record.categoryMatch ? '匹配' : '待确认'}`}
          {record.suggestedType &&
            ` · 建议：${taskTypeLabel(record.suggestedType)}`}
        </span>
      </p>
    </li>
  );
}

export function TaskDetail({ id }: { id: string }) {
  const { user } = useAdminSession();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [task, history] = await Promise.all([
        adminApi.task(id, signal),
        adminApi.moderations(id, signal),
      ]);
      return { task, history };
    },
    [id],
  );
  const { data, error, loading, reload } = useAdminData(`detail:${id}`, load);
  const [action, setAction] = useState<
    'take' | 'retry' | 'PASS' | 'REJECT' | null
  >(null);
  const [reason, setReason] = useState('');
  const [confirmedType, setConfirmedType] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const task = data?.task;
  useEffect(() => {
    if (
      !task ||
      task.status !== 'PENDING_REVIEW' ||
      task.reviewFeedback ||
      action
    )
      return;
    const timer = setInterval(reload, 5000);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [task, action, reload]);
  const human =
    task?.status === 'PENDING_REVIEW' &&
    task.moderation?.source === 'AI' &&
    (task.moderation.status === 'ERROR' ||
      (task.moderation.status === 'COMPLETED' &&
        task.moderation.decision === 'REVIEW'));
  const needsTypeConfirmation =
    !!task &&
    (task.moderation?.categoryMatch === false ||
      !taskCategories.some(
        (category) => category.id === task.type && category.id !== 'other',
      ));
  function open(next: 'take' | 'retry' | 'PASS' | 'REJECT') {
    setAction(next);
    setReason('');
    setConfirmedType('');
    setActionError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!task || !action || busy) return;
    setBusy(true);
    setActionError('');
    try {
      if (action === 'take') await adminApi.take(task.id);
      else if (action === 'retry')
        await adminApi.retryModeration(task.id, task.moderation!.id);
      else if (task.moderation)
        await adminApi.review(task.id, {
          moderationId: task.moderation.id,
          decision: action,
          reason,
          ...(action === 'PASS' && needsTypeConfirmation
            ? { type: confirmedType }
            : {}),
        });
      setNotice(
        action === 'take'
          ? '任务已接取。'
          : action === 'retry'
            ? '智能审核已重新排队。'
            : action === 'PASS'
              ? '人工审核已通过。'
              : '任务已退回，等待发布者修改。',
      );
      setAction(null);
      reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back" href="/admin/tasks">
        <IconArrowLeft size={14} />
        返回任务列表
      </Link>
      {notice && (
        <p role="status" className="notice-text" style={{ marginBottom: 12 }}>
          {notice}
        </p>
      )}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : (
        task && (
          <>
            <div className="d-head">
              <div>
                <h2>{task.title}</h2>
                <div className="d-sub">
                  <StatusBadge status={task.status} size="lg" />
                  <span className="mono muted">
                    创建于 {dateText(task.createdAt)}
                  </span>
                </div>
              </div>
              <div className="d-act">
                <button
                  className="btn btn-ghost btn-ic"
                  onClick={reload}
                  aria-label="刷新"
                  title="刷新"
                >
                  <IconRefresh size={14} />
                </button>
                {task.status === 'OPEN' && (
                  <button className="btn btn-pri" onClick={() => open('take')}>
                    接取任务
                  </button>
                )}
                {human && (
                  <>
                    {task.moderation?.status === 'ERROR' && (
                      <button className="btn" onClick={() => open('retry')}>
                        重试智能审核
                      </button>
                    )}
                    <button
                      className="btn btn-pri"
                      onClick={() => open('PASS')}
                    >
                      通过审核
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => open('REJECT')}
                    >
                      退回修改
                    </button>
                  </>
                )}
              </div>
            </div>
            {task.reviewFeedback && (
              <section className="revision-feedback" aria-label="审核退回">
                <strong>待修改 · 等待发布者重新提交</strong>
                <p>{task.reviewFeedback.reason || '未填写退回理由。'}</p>
              </section>
            )}
            <div className="d-grid issue-layout">
              <div>
                <section className="block">
                  <div className="block-h">
                    <h3>公开摘要</h3>
                  </div>
                  <p className="prose">{task.summary}</p>
                </section>
                <section className="block">
                  <div className="block-h">
                    <h3>完整需求</h3>
                    <span className="lock">
                      <IconLock size={12} />
                      仅你和管理员可见
                    </span>
                  </div>
                  <div className="priv">
                    <div className="priv-top">
                      <IconLock size={13} />
                      <span className="t">私密内容 · 不会出现在公开列表</span>
                      <span className="role" style={{ marginLeft: 'auto' }}>
                        管理员
                      </span>
                    </div>
                    <div className="priv-body">
                      <div className="task-content">{task.description}</div>
                      <AttachmentList files={task.attachments} />
                    </div>
                  </div>
                </section>

                <TaskChat
                  taskId={id}
                  user={user}
                  status={task.status}
                  onStatusChange={reload}
                />
              </div>
              <aside className="issue-sidebar">
                <dl className="meta4">
                  <div>
                    <dt className="meta-k">发布者</dt>
                    <dd className="meta-v mono" style={{ fontSize: 13 }}>
                      {task.publisher.email}
                    </dd>
                  </div>
                  <div>
                    <dt className="meta-k">类型</dt>
                    <dd className="meta-v mono" style={{ fontSize: 13 }}>
                      {taskTypeLabel(task.type)}
                    </dd>
                  </div>
                  {typeof task.moderation?.categoryMatch === 'boolean' && (
                    <div>
                      <dt className="meta-k">AI 分类判断</dt>
                      <dd className="meta-v">
                        {task.moderation.categoryMatch ? '匹配' : '待确认'}
                        {task.moderation.suggestedType &&
                          ` · 建议：${taskTypeLabel(task.moderation.suggestedType)}`}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="meta-k">创建时间</dt>
                    <dd className="meta-v mono" style={{ fontSize: 13 }}>
                      {dateText(task.createdAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="meta-k">更新时间</dt>
                    <dd className="meta-v mono" style={{ fontSize: 13 }}>
                      {dateText(task.updatedAt)}
                    </dd>
                  </div>
                </dl>

                <details>
                  <summary>审核历史</summary>{' '}
                  <section className="block" style={{ marginBottom: 0 }}>
                    <div className="block-h">
                      <h3>审核历史</h3>
                      <span className="muted">{data.history.length} 条</span>
                    </div>
                    {!data.history.length ? (
                      <p className="muted">暂无审核记录</p>
                    ) : (
                      <ul className="hist">
                        {data.history.map((record) => (
                          <HistoryRow key={record.id} record={record} />
                        ))}
                      </ul>
                    )}
                  </section>
                </details>
              </aside>
            </div>
          </>
        )
      )}
      {action && task && (
        <Modal
          title={
            action === 'take'
              ? '接取任务'
              : action === 'retry'
                ? '重试智能审核'
                : action === 'PASS'
                  ? '通过人工审核'
                  : '退回修改'
          }
          busy={busy}
          close={() => {
            setAction(null);
            reload();
          }}
        >
          <form onSubmit={(event) => void submit(event)}>
            <p className="dialog-task-title">{task.title}</p>
            {action !== 'take' && action !== 'retry' && (
              <label className="form-field">
                {action === 'REJECT' ? '退回理由（选填）' : '审核理由'}
                <textarea
                  required={action === 'PASS'}
                  minLength={action === 'PASS' ? 1 : undefined}
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                  rows={5}
                />
              </label>
            )}
            {action === 'PASS' && needsTypeConfirmation && (
              <label className="form-field">
                确认任务分类
                <select
                  required
                  value={confirmedType}
                  onChange={(event) => setConfirmedType(event.target.value)}
                  disabled={busy}
                >
                  <option value="" disabled>
                    请选择最终分类
                  </option>
                  {taskCategories
                    .filter((category) => category.id !== 'other')
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label}
                      </option>
                    ))}
                </select>
                {task.moderation?.suggestedType && (
                  <small>
                    AI 建议：{taskTypeLabel(task.moderation.suggestedType)}
                  </small>
                )}
              </label>
            )}
            {actionError && (
              <p className="error-text" role="alert">
                {actionError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAction(null);
                  reload();
                }}
                disabled={busy}
              >
                返回
              </button>
              <button
                className={
                  action === 'REJECT' ? 'btn btn-danger' : 'btn btn-pri'
                }
                type="submit"
                disabled={busy}
              >
                {busy
                  ? '提交中...'
                  : action === 'take'
                    ? '确认接取'
                    : action === 'retry'
                      ? '确认重试'
                      : '提交审核'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
