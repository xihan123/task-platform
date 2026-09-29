'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UserDto } from '../../lib/types';
import { useCurrentUser } from '../../hooks/use-current-user';
import { useOnlineStatus } from '../../hooks/use-online-status';
import { authApi } from '../../lib/auth-api';
import { AuthScreen } from '../auth-screen';
import { NotificationCenter } from '../notification-center';
import {
  IconFlow,
  IconGrid,
  IconList,
  IconShield,
  IconSliders,
  IconUsers,
} from '../icons';

const AdminContext = createContext<{
  user: UserDto;
  invalidate: () => void;
  passwordReset: () => void;
} | null>(null);

export function useAdminSession() {
  const context = useContext(AdminContext);
  if (!context) throw new Error('Administrator session required');
  return context;
}

const navigation = [
  { href: '/admin', title: '工作概览', icon: IconGrid },
  { href: '/admin/tasks', title: '任务管理', icon: IconList },
  { href: '/admin/users', title: '用户管理', icon: IconUsers },
  { href: '/admin/moderations', title: '人工审核', icon: IconShield },
  { href: '/admin/ai', title: '模型配置', icon: IconSliders },
  { href: '/admin/settings', title: '账户设置', icon: IconUsers },
];

function NetworkStatus() {
  const online = useOnlineStatus();
  return (
    <div className="side-foot">
      <span className={`dot-live${online ? '' : ' off'}`} />
      {online ? '实时连接正常' : '网络已离线'}
    </div>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { state, refresh, clear } = useCurrentUser();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invalidate = useCallback(() => {
    clear();
    void refresh();
  }, [clear, refresh]);
  const passwordReset = useCallback(() => {
    setNotice('密码已重置，所有旧登录已失效，请重新登录。');
    clear();
  }, [clear]);
  async function logout() {
    setPending(true);
    setError('');
    try {
      await authApi.logout();
      clear();
      window.location.replace('/tasks?scope=public');
    } catch {
      setError('退出失败，请重试。');
    } finally {
      setPending(false);
    }
  }
  const brand = (
    <Link className="brand" href="/admin">
      <span className="brand-mark">
        <IconFlow size={13} />
      </span>
      <span className="brand-txt">
        <span className="brand-name">任务协作平台</span>
        <span className="brand-sub">管理员工作台</span>
      </span>
    </Link>
  );
  if (state.status === 'loading')
    return (
      <div className="admin-access">
        {brand}
        <p role="status">正在验证账户...</p>
      </div>
    );
  if (state.status === 'anonymous')
    return (
      <div className="admin-access">
        {brand}
        <h1>管理员登录</h1>
        {notice && (
          <p role="status" className="notice-text">
            {notice}
          </p>
        )}
        <AuthScreen
          adminOnly
          onAuthenticated={() => {
            setNotice('');
            void refresh();
          }}
        />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="admin-access">
        {brand}
        <p role="alert">无法验证账户。</p>
        <button className="btn" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  if (state.user.role !== 'ADMIN' || state.user.status !== 'ACTIVE')
    return (
      <div className="admin-access">
        {brand}
        <h1>无权访问</h1>
        <p>当前账户没有管理员权限。</p>
        <Link className="btn" href="/">
          返回工作台
        </Link>
      </div>
    );
  const current = navigation.find((item) =>
    item.href === '/admin'
      ? pathname === item.href
      : pathname.startsWith(item.href),
  );
  return (
    <AdminContext.Provider
      value={{ user: state.user, invalidate, passwordReset }}
    >
      <div className="shell admin-shell">
        <aside className="side">
          {brand}
          <div className="nav-eyebrow">工作区</div>
          <nav className="nav" aria-label="管理员导航">
            {navigation.map(({ href, title, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={current?.href === href ? 'page' : undefined}
                className={current?.href === href ? 'on' : undefined}
              >
                <span className="ic">
                  <Icon size={15} />
                </span>
                {title}
              </Link>
            ))}
          </nav>
          <NetworkStatus />
        </aside>
        <main className="main">
          <header className="top">
            <span className="top-title">{current?.title ?? '任务管理'}</span>
            <div className="top-right">
              <NotificationCenter key={state.user.id} user={state.user} />
              <span className="who">
                <span className="mail" title={state.user.email}>
                  {state.user.email}
                </span>
                <span className="role">管理员</span>
              </span>
              <button
                className="btn btn-ghost"
                onClick={() => void logout()}
                disabled={pending}
              >
                退出登录
              </button>
            </div>
          </header>
          <div className="body-pad">
            {error && (
              <p
                role="alert"
                className="error-text"
                style={{ marginBottom: 12 }}
              >
                {error}
              </p>
            )}
            {children}
          </div>
        </main>
      </div>
    </AdminContext.Provider>
  );
}
