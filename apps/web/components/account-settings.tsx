'use client';

import { useId, useState, type FormEvent } from 'react';
import type { UserDto } from '../lib/types';
import { authApi } from '../lib/auth-api';
import { dateText } from '../lib/task-presentation';
import { EmailPreferences } from './email-preferences';
import { EmailCodeInput, emailError } from './email-code-input';
import { IconLock, IconUsers } from './icons';
import './account-settings.css';

export function AccountSettings({
  user,
  onPasswordReset,
}: {
  user: UserDto;
  onPasswordReset: () => void;
}) {
  return (
    <>
      <div className="sec-head">
        <h1 className="sec-title">账户设置</h1>
        <span className="sec-note">管理邮箱验证、消息订阅与账户安全</span>
      </div>
      <div className="settings-grid">
        <section
          className="panel settings-panel"
          aria-labelledby="account-info-title"
        >
          <div className="panel-head">
            <IconUsers size={14} />
            <h2 id="account-info-title">账户信息</h2>
          </div>
          <dl className="settings-account-details">
            <div>
              <dt>登录邮箱</dt>
              <dd className="mono">{user.email}</dd>
            </div>
            <div>
              <dt>账户角色</dt>
              <dd>{user.role === 'ADMIN' ? '管理员' : '发布者'}</dd>
            </div>
            <div>
              <dt>账户状态</dt>
              <dd>
                <span
                  className={`st ${user.status === 'ACTIVE' ? 'st-done' : 'st-cancel'}`}
                >
                  {user.status === 'ACTIVE' ? '正常' : '已禁用'}
                </span>
              </dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>
                <time dateTime={user.createdAt}>
                  {dateText(user.createdAt)}
                </time>
              </dd>
            </div>
          </dl>
        </section>
        <div className="settings-sections">
          <EmailPreferences />
          <PasswordSettings
            email={user.email}
            onPasswordReset={onPasswordReset}
          />
        </div>
      </div>
    </>
  );
}

function PasswordSettings({
  email,
  onPasswordReset,
}: {
  email: string;
  onPasswordReset: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    try {
      await authApi.resetPassword({ email, password, code });
      setPassword('');
      setConfirmation('');
      setCode('');
      onPasswordReset();
    } catch (error) {
      setError(emailError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="panel settings-panel" aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <IconLock size={14} />
        <h2 id={`${id}-title`}>账户安全</h2>
      </div>
      <div className="settings-panel-body">
        <div className="settings-row">
          <div>
            <h3>登录密码</h3>
            <p className="settings-help">
              通过当前邮箱验证身份，重置后所有设备均需重新登录。
            </p>
          </div>
          <button
            type="button"
            className="btn"
            aria-expanded={open}
            aria-controls={`${id}-form`}
            disabled={pending}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : '重置密码'}
          </button>
        </div>
        <form
          id={`${id}-form`}
          hidden={!open}
          className="settings-form"
          onSubmit={(event) => void submit(event)}
        >
          <EmailCodeInput
            value={code}
            onChange={setCode}
            requestCode={() => authApi.requestCode(email, 'password-reset')}
            disabled={pending}
          />
          <label className="form-field">
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              disabled={pending}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="form-field">
            确认新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              disabled={pending}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <p className="settings-help">密码长度为 12 至 128 位。</p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-pri" disabled={pending}>
            {pending ? '正在重置…' : '确认重置密码'}
          </button>
        </form>
      </div>
    </section>
  );
}
