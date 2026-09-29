'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { UserDto } from '../../lib/types';
import { useTask } from '../../hooks/use-tasks';
import { ApiClientError } from '../../lib/api-client';
import { tasksApi } from '../../lib/tasks-api';
import {
  dateText,
  taskErrorText,
  taskTypeLabel,
} from '../../lib/task-presentation';
import { TaskChat } from '../chat/task-chat';
import { AttachmentList } from '../attachments';
import { TaskForm } from './task-form';
import { StatusBadge } from '../task-status';
import { IconArrowLeft, IconClock, IconLock, IconRefresh } from '../icons';

export function TaskDetail({
  taskId,
  user,
}: {
  taskId: string;
  user: UserDto | null;
}) {
  const { data: task, error, reload } = useTask(user, taskId);
  const feedback =
    task && 'reviewFeedback' in task ? task.reviewFeedback : null;
  const editingRef = useRef(false);
  useEffect(() => {
    if (!task || task.status !== 'PENDING_REVIEW' || feedback) return;
    const refresh = () => {
      if (!editingRef.current) reload();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [task, feedback, reload]);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  function handleConflict(error: unknown) {
    if (
      error instanceof ApiClientError &&
      [401, 403, 404, 409].includes(error.status) &&
      !error.code.startsWith('ATTACHMENT_')
    ) {
      editingRef.current = false;
      setEditing(false);
      setConfirming(false);
      reload();
    }
    setActionError(taskErrorText(error));
  }

  async function cancelTask() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setActionError('');
    try {
      await tasksApi.cancel(taskId);
      setConfirming(false);
      setNotice('任务已取消。');
      reload();
    } catch (error) {
      handleConflict(error);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const owner =
    user?.role === 'USER' &&
    user.status === 'ACTIVE' &&
    task &&
    'publisherId' in task &&
    task.publisherId === user.id;
  const canEdit = owner && task.status === 'PENDING_REVIEW';
  const canCancel =
    owner && ['PENDING_REVIEW', 'OPEN', 'IN_PROGRESS'].includes(task.status);

  return (
    <>
      {notice && (
        <p role="status" className="notice-text" style={{ marginBottom: 12 }}>
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="error-text" style={{ marginBottom: 12 }}>
          {actionError}
        </p>
      )}
      {error ? (
        <div role="alert" className="state-box">
          <p>{taskErrorText(error)}</p>
          <button className="btn" onClick={reload}>
            重试
          </button>
        </div>
      ) : !task ? (
        <p role="status">正在加载任务...</p>
      ) : (
        <>
          <Link className="back" href="/tasks">
            <IconArrowLeft size={13} />
            返回任务列表
          </Link>
          <div className="d-head">
            <h1 className="d-title">{task.title}</h1>
            <StatusBadge status={task.status} size="lg" />
          </div>
          {feedback ? (
            <section className="revision-feedback" aria-label="审核退回">
              <strong>待修改 · 任务已退回</strong>
              <p>{feedback.reason || '请修改任务内容后重新提交审核。'}</p>
            </section>
          ) : null}
          {editing && canEdit && 'description' in task ? (
            <div className="form-panel">
              <TaskForm
                initial={task}
                cancel={() => {
                  editingRef.current = false;
                  setEditing(false);
                }}
                save={async (input) => {
                  setActionError('');
                  try {
                    await tasksApi.update(taskId, input);
                    editingRef.current = false;
                    setEditing(false);
                    setNotice('修改已保存，任务将重新审核。');
                    reload();
                  } catch (error) {
                    if (
                      error instanceof ApiClientError &&
                      [401, 403, 404, 409].includes(error.status) &&
                      !error.code.startsWith('ATTACHMENT_')
                    ) {
                      handleConflict(error);
                      return;
                    }
                    throw error;
                  }
                }}
              />
            </div>
          ) : (
            <>
              <div className="d-grid issue-layout">
                <div>
                  <section className="block">
                    <div className="block-h">
                      <h3>公开摘要</h3>
                    </div>
                    <p className="prose">{task.summary}</p>
                  </section>
                  {user &&
                  'description' in task &&
                  (owner || user.role === 'ADMIN') ? (
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
                          <span className="t">
                            私密内容 · 不会出现在公开列表
                          </span>
                        </div>
                        <div className="priv-body">
                          <div className="task-content">{task.description}</div>
                          <AttachmentList files={task.attachments} />
                        </div>
                      </div>
                    </section>
                  ) : (
                    <p className="task-help">完整需求仅发布者与管理员可见。</p>
                  )}
                  <div className="task-actions">
                    {canEdit && (
                      <button
                        className="btn"
                        disabled={pending || confirming}
                        onClick={() => {
                          setNotice('');
                          setActionError('');
                          editingRef.current = true;
                          setEditing(true);
                        }}
                      >
                        编辑任务
                      </button>
                    )}
                    {canCancel && (
                      <button
                        className="btn"
                        disabled={pending || confirming}
                        onClick={() => {
                          setNotice('');
                          setActionError('');
                          setConfirming(true);
                        }}
                      >
                        取消任务
                      </button>
                    )}
                    {user?.role === 'ADMIN' && (
                      <Link
                        className="btn"
                        href={`/admin/tasks/detail?id=${taskId}`}
                      >
                        在工作台处理
                      </Link>
                    )}
                    <button
                      className="btn btn-ghost"
                      disabled={pending || confirming}
                      onClick={reload}
                    >
                      <IconRefresh size={13} />
                      刷新状态
                    </button>
                  </div>
                  {confirming && canCancel && (
                    <section
                      className="task-confirm"
                      aria-labelledby="cancel-heading"
                    >
                      <h2 id="cancel-heading">确认取消任务？</h2>
                      <p>取消后无法恢复，任务会话将只读。</p>
                      <div className="task-actions">
                        <button
                          className="btn btn-danger"
                          disabled={pending}
                          onClick={() => void cancelTask()}
                        >
                          {pending ? '取消中...' : '确认取消'}
                        </button>
                        <button
                          className="btn"
                          disabled={pending}
                          onClick={() => setConfirming(false)}
                        >
                          继续保留
                        </button>
                      </div>
                    </section>
                  )}
                  {user &&
                    'description' in task &&
                    (owner || user.role === 'ADMIN') && (
                      <TaskChat
                        taskId={taskId}
                        user={user}
                        status={task.status}
                        onStatusChange={reload}
                      />
                    )}
                </div>
                <aside className="panel">
                  <div className="panel-head">
                    <h3>任务信息</h3>
                  </div>
                  <div className="task-info-grid">
                    <div>
                      <div className="meta-k">类型</div>
                      <div className="meta-v mono">
                        {taskTypeLabel(task.type)}
                      </div>
                    </div>
                    <div>
                      <div className="meta-k">创建时间</div>
                      <div className="meta-v mono" style={{ fontSize: 13 }}>
                        {dateText(task.createdAt)}
                      </div>
                    </div>
                    {'updatedAt' in task && (
                      <div>
                        <div className="meta-k">更新时间</div>
                        <div className="meta-v mono" style={{ fontSize: 13 }}>
                          {dateText(task.updatedAt)}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="gate">
                    <IconClock size={15} />
                    <span className="g-t">
                      这个平台只有一位接取者。任务先由 AI
                      审核，通过后进入这一位管理员的队列；完成时需要发布者确认一次，任务才会结束。
                    </span>
                  </div>
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
