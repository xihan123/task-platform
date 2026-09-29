'use client';

import { useEffect, useId, useState } from 'react';
import { AuthApiError } from '../lib/auth-api';

export function emailError(error: unknown): string {
  const messages: Record<string, string> = {
    INVALID_EMAIL_CODE: '验证码错误、已使用或已过期，请重新获取。',
    EMAIL_NOT_VERIFIED: '请先验证邮箱，再开启邮件订阅。',
    EMAIL_UNAVAILABLE: '邮件服务暂时不可用，请稍后重试。',
    RATE_LIMITED: '发送或尝试次数过多，请稍后再试。',
    VALIDATION_ERROR: '请检查邮箱、6 位验证码及 12 至 128 位密码。',
  };
  return error instanceof AuthApiError
    ? (messages[error.code] ?? '操作失败，请稍后重试。')
    : '操作失败，请稍后重试。';
}

export function EmailCodeInput({
  value,
  onChange,
  requestCode,
  disabled = false,
}: {
  value: string;
  onChange: (code: string) => void;
  requestCode: () => Promise<void>;
  disabled?: boolean;
}) {
  const id = useId();
  const [remaining, setRemaining] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!remaining) return;
    const timer = setTimeout(
      () => setRemaining((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [remaining]);
  async function send() {
    if (sending || remaining) return;
    setSending(true);
    setError('');
    setNotice('');
    try {
      await requestCode();
      setRemaining(60);
      setNotice('若邮箱符合条件，验证码将发送至该邮箱，10 分钟内有效。');
    } catch (error) {
      setError(emailError(error));
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="form-field email-code-field">
      <label htmlFor={id}>邮箱验证码</label>
      <div className="email-code-control">
        <input
          id={id}
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
        <button
          className="btn"
          type="button"
          disabled={disabled || sending || remaining > 0}
          onClick={() => void send()}
        >
          {sending
            ? '正在发送…'
            : remaining
              ? `${remaining} 秒后可重发`
              : '获取验证码'}
        </button>
      </div>
      {notice && (
        <p role="status" className="notice-text">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
