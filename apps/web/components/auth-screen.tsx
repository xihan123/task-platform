'use client';

import { useState, type FormEvent } from 'react';
import { AuthApiError, authApi } from '../lib/auth-api';
import { useCurrentUser } from '../hooks/use-current-user';
import { EmailCodeInput, emailError } from './email-code-input';

const errorMessages: Record<string, string> = {
  INVALID_CREDENTIALS: '邮箱或密码错误。',
  EMAIL_IN_USE: '该邮箱已注册。',
  ACCOUNT_DISABLED: '账户已被禁用。',
  RATE_LIMITED: '尝试次数过多，请稍后再试。',
  VALIDATION_ERROR: '请检查邮箱、6 位验证码及 12 至 128 位密码。',
  CSRF_REJECTED: '请求未通过安全校验，请刷新后重试。',
};

export function AuthScreen({
  adminOnly = false,
  onAuthenticated,
}: { adminOnly?: boolean; onAuthenticated?: () => void } = {}) {
  const { state, refresh, clear } = useCurrentUser();
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function showError(error: unknown) {
    setError(
      error instanceof AuthApiError
        ? (errorMessages[error.code] ?? emailError(error))
        : '操作失败，请稍后重试。',
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setNotice('');
    if (mode !== 'login' && password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    try {
      if (mode === 'register') {
        await authApi.register({ email, password, code });
        setMode('login');
        setNotice('注册成功，请登录。');
      } else if (mode === 'reset') {
        await authApi.resetPassword({ email, password, code });
        clear();
        setMode('login');
        setNotice('密码已重置，所有旧登录已失效，请重新登录。');
      } else {
        await authApi.login({ email, password });
        await refresh();
        onAuthenticated?.();
      }
      setPassword('');
      setConfirmation('');
      setCode('');
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  }

  if (state.status === 'loading') return <p role="status">正在加载账户...</p>;
  if (state.status === 'error')
    return (
      <section className="auth-panel">
        <p role="alert">暂时无法获取账户信息。</p>
        <button className="btn" type="button" onClick={() => void refresh()}>
          重试
        </button>
      </section>
    );

  if (state.status === 'authenticated')
    return <p role="status">账户已验证，正在加载工作台...</p>;

  return (
    <section className="auth-panel" aria-label="账户认证">
      {!adminOnly && (
        <div className="auth-tabs" role="tablist" aria-label="账户入口">
          {(['login', 'register'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mode === tab}
              aria-controls="auth-form"
              id={`${tab}-tab`}
              disabled={pending}
              onClick={() => {
                setMode(tab);
                setPassword('');
                setConfirmation('');
                setCode('');
                setError('');
                setNotice('');
              }}
            >
              {tab === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>
      )}
      <form
        id="auth-form"
        role={adminOnly || mode === 'reset' ? undefined : 'tabpanel'}
        aria-labelledby={
          adminOnly || mode === 'reset' ? undefined : `${mode}-tab`
        }
        onSubmit={(event) => void submit(event)}
      >
        {mode === 'reset' && <h2>重置密码</h2>}
        <div className="form-field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setCode('');
            }}
            disabled={pending}
          />
        </div>
        <div className="form-field">
          <div className="field-label">
            <label htmlFor="password">密码</label>
            {mode === 'login' && (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={pending}
                onClick={() => {
                  setMode('reset');
                  setPassword('');
                  setConfirmation('');
                  setCode('');
                  setError('');
                  setNotice('');
                }}
              >
                忘记密码？
              </button>
            )}
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode !== 'login' ? 'new-password' : 'current-password'
            }
            minLength={12}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
          />
        </div>
        {mode !== 'login' && (
          <div className="form-field">
            <label htmlFor="confirmation">确认密码</label>
            <input
              id="confirmation"
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending}
            />
          </div>
        )}
        {mode !== 'login' && (
          <EmailCodeInput
            key={mode}
            value={code}
            onChange={setCode}
            disabled={pending}
            requestCode={() =>
              authApi.requestCode(
                email,
                mode === 'register' ? 'register' : 'password-reset',
              )
            }
          />
        )}
        <div className="auth-actions">
          {(error || state.error) && (
            <p role="alert" className="error-message">
              {error || errorMessages[state.error ?? '']}
            </p>
          )}
          {notice && (
            <p role="status" className="notice-message">
              {notice}
            </p>
          )}
          <button
            className="btn btn-pri btn-block"
            type="submit"
            disabled={pending}
          >
            {pending
              ? '正在提交...'
              : mode === 'login'
                ? '登录'
                : mode === 'register'
                  ? '创建账户'
                  : '重置密码'}
          </button>
        </div>
      </form>
      {mode === 'reset' && (
        <button
          className="btn btn-ghost auth-back"
          type="button"
          disabled={pending}
          onClick={() => {
            setMode('login');
            setPassword('');
            setConfirmation('');
            setCode('');
            setError('');
            setNotice('');
          }}
        >
          返回登录
        </button>
      )}
    </section>
  );
}
