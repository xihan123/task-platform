'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '../hooks/use-current-user';
import { AuthScreen } from './auth-screen';
import { IconFlow } from './icons';

export function WorkspaceEntry({ login = false }: { login?: boolean }) {
  const { state, refresh } = useCurrentUser();
  const router = useRouter();
  const destination =
    state.status === 'authenticated' && state.user.status === 'ACTIVE'
      ? state.user.role === 'ADMIN'
        ? '/admin'
        : '/tasks?scope=mine'
      : state.status === 'anonymous' && !state.error && !login
        ? '/tasks?scope=public'
        : null;

  useEffect(() => {
    if (destination) router.replace(destination);
  }, [destination, router]);

  return (
    <main className="home-main">
      <header className="app-heading">
        <span className="brand-mark">
          <IconFlow size={13} />
        </span>
        <h1>任务协作平台</h1>
      </header>
      <Link className="home-link" href="/tasks?scope=public">
        浏览公开广场 →
      </Link>
      {state.status === 'loading' || destination ? (
        <p role="status">正在进入工作台...</p>
      ) : state.status === 'error' ? (
        <section className="auth-panel">
          <p role="alert">暂时无法获取账户信息。</p>
          <button className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </section>
      ) : state.status === 'authenticated' ||
        (state.status === 'anonymous' && state.error) ? (
        <section className="auth-panel">
          <p role="alert">账户不可用，请重新登录。</p>
          <Link className="btn" href="/login">
            返回登录
          </Link>
          {login && <AuthScreen onAuthenticated={() => void refresh()} />}
        </section>
      ) : login ? (
        <AuthScreen onAuthenticated={() => void refresh()} />
      ) : null}
    </main>
  );
}
