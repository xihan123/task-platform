'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AccountSettings } from '../../components/account-settings';
import { AuthScreen } from '../../components/auth-screen';
import { PubShell } from '../../components/tasks/task-workspace';
import { useCurrentUser } from '../../hooks/use-current-user';

export default function SettingsPage() {
  const { state, clear, refresh } = useCurrentUser();
  const [notice, setNotice] = useState('');
  const user = state.status === 'authenticated' ? state.user : null;
  return (
    <PubShell user={user} active="settings" title="账户设置">
      {state.status === 'loading' ? (
        <p role="status">正在验证账户...</p>
      ) : state.status === 'error' ? (
        <div className="empty-state">
          <p role="alert">暂时无法获取账户信息。</p>
          <button type="button" className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : user ? (
        user.role === 'ADMIN' ? (
          <div className="empty-state">
            <Link className="btn btn-pri" href="/admin/settings">
              进入管理员账户设置
            </Link>
          </div>
        ) : (
          <AccountSettings
            key={user.id}
            user={user}
            onPasswordReset={() => {
              setNotice('密码已重置，所有旧登录已失效，请重新登录。');
              clear();
            }}
          />
        )
      ) : (
        <div className="settings-login">
          {notice && (
            <p role="status" className="notice-text">
              {notice}
            </p>
          )}
          <AuthScreen
            onAuthenticated={() => {
              setNotice('');
              void refresh();
            }}
          />
        </div>
      )}
    </PubShell>
  );
}
