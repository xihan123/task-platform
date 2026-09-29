'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { UserDto } from '../../lib/types';
import { useCurrentUser } from '../../hooks/use-current-user';
import { useOnlineStatus } from '../../hooks/use-online-status';
import { authApi } from '../../lib/auth-api';
import { tasksApi } from '../../lib/tasks-api';
import { TaskList } from './task-list';
import { TaskDetail } from './task-detail';
import { TaskForm } from './task-form';
import { NotificationCenter } from '../notification-center';
import {
  IconChevronRight,
  IconFlow,
  IconGrid,
  IconList,
  IconSend,
  IconSliders,
} from '../icons';
import './tasks.css';

function NetworkStatus() {
  const online = useOnlineStatus();
  return (
    <div className="side-foot">
      <span className={`dot-live${online ? '' : ' off'}`} />
      {online ? '实时连接正常' : '网络已离线'}
    </div>
  );
}

/** 公开侧应用外壳：侧栏（品牌 + 我的导航）+ 顶栏 + 内容区，聊天页与任务页共用 */
export function PubShell({
  user,
  active,
  crumb,
  title,
  children,
}: {
  user: UserDto | null;
  active: 'tasks' | 'new' | 'settings';
  crumb?: { label: string } | null;
  title?: string;
  children: ReactNode;
}) {
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  async function logout() {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError('');
    try {
      await authApi.logout();
      // Reload the document so no mounted page retains the previous session.
      window.location.replace('/tasks?scope=public');
    } catch {
      setLogoutError('退出失败，请重试。');
      setLogoutPending(false);
    }
  }
  const isPublisher = user?.role === 'USER' && user.status === 'ACTIVE';
  return (
    <div className="shell pub">
      <aside className="side">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <IconFlow size={13} />
          </span>
          <span className="brand-txt">
            <span className="brand-name">任务协作平台</span>
            <span className="brand-sub">发布者工作台</span>
          </span>
        </Link>
        <div className="nav-eyebrow">我的</div>
        <nav className="nav" aria-label="主导航">
          <Link
            href="/tasks"
            className={active === 'tasks' ? 'on' : undefined}
            aria-current={active === 'tasks' ? 'page' : undefined}
          >
            <span className="ic">
              <IconList size={15} />
            </span>
            任务列表
          </Link>
          {isPublisher && (
            <Link
              href="/tasks/new"
              className={active === 'new' ? 'on' : undefined}
              aria-current={active === 'new' ? 'page' : undefined}
            >
              <span className="ic">
                <IconSend size={15} />
              </span>
              发布任务
            </Link>
          )}
          {user?.role === 'ADMIN' && (
            <Link href="/admin">
              <span className="ic">
                <IconGrid size={15} />
              </span>
              管理工作台
            </Link>
          )}
          {user && (
            <Link
              href={user.role === 'ADMIN' ? '/admin/settings' : '/settings'}
              className={active === 'settings' ? 'on' : undefined}
              aria-current={active === 'settings' ? 'page' : undefined}
            >
              <span className="ic">
                <IconSliders size={15} />
              </span>
              账户设置
            </Link>
          )}
          {!user && (
            <Link href="/login">
              <span className="ic">
                <IconGrid size={15} />
              </span>
              登录 / 注册
            </Link>
          )}
        </nav>
        <NetworkStatus />
      </aside>
      <main className="main">
        <header className="top">
          {crumb ? (
            <div className="crumb">
              <Link href="/tasks">任务列表</Link>
              <IconChevronRight size={13} />
              <span className="top-title">{crumb.label}</span>
            </div>
          ) : (
            <span className="top-title">{title ?? '任务列表'}</span>
          )}
          <div className="top-right">
            {user ? (
              <>
                {user.status === 'ACTIVE' && (
                  <NotificationCenter key={user.id} user={user} />
                )}
                <span className="who">
                  <span className="mail" title={user.email}>
                    {user.email}
                  </span>
                  {user.role === 'ADMIN' && (
                    <span className="role">管理员</span>
                  )}
                </span>
                <button
                  className="btn btn-ghost"
                  disabled={logoutPending}
                  onClick={() => void logout()}
                >
                  退出登录
                </button>
              </>
            ) : (
              <Link className="btn" href="/login">
                登录 / 注册
              </Link>
            )}
          </div>
        </header>
        <div className="body-pad">
          {logoutError && (
            <p role="alert" className="error-message">
              {logoutError}
            </p>
          )}
          {logoutPending ? <p role="status">正在退出登录...</p> : children}
        </div>
      </main>
    </div>
  );
}

export function TaskWorkspace({
  mode,
  taskId,
}: {
  mode: 'list' | 'create' | 'detail';
  taskId?: string;
}) {
  const { state, refresh } = useCurrentUser();
  const router = useRouter();
  const user = state.status === 'authenticated' ? state.user : null;
  return (
    <PubShell
      user={user}
      active={mode === 'create' ? 'new' : 'tasks'}
      crumb={mode === 'detail' ? { label: '任务详情' } : null}
      title={mode === 'create' ? '发布任务' : '任务列表'}
    >
      {state.status === 'loading' ? (
        <p role="status">正在验证账户...</p>
      ) : state.status === 'error' ? (
        <div role="alert" className="state-box">
          <p>暂时无法获取账户信息。</p>
          <button className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : state.status === 'anonymous' && state.error ? (
        <p role="alert">账户不可用，请前往登录页面重新登录。</p>
      ) : user?.status === 'DISABLED' ? (
        <p role="alert">账户已被禁用。</p>
      ) : (
        <div
          key={`${user?.id ?? 'anonymous'}:${user?.role ?? ''}:${mode}:${taskId ?? ''}`}
        >
          {mode === 'list' ? (
            <TaskList user={user} />
          ) : mode === 'detail' && taskId ? (
            <TaskDetail taskId={taskId} user={user} />
          ) : (
            <>
              <div className="sec-head">
                <h1 className="sec-title">发布任务</h1>
                <span className="sec-note">标题、摘要和类型公开可见</span>
              </div>
              {user?.role === 'USER' ? (
                <div className="form-panel">
                  <TaskForm
                    save={async (input) => {
                      const task = await tasksApi.create(input);
                      router.push(
                        `/tasks/detail?id=${encodeURIComponent(task.id)}`,
                      );
                    }}
                  />
                </div>
              ) : (
                <p className="task-help">
                  {user
                    ? '管理员负责接取任务，请前往管理工作台。'
                    : '请先登录，再发布任务。'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </PubShell>
  );
}
