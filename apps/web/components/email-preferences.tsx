'use client';

import { useEffect, useId, useState } from 'react';
import type { EmailPreferencesDto } from '../lib/types';
import { authApi } from '../lib/auth-api';
import { EmailCodeInput, emailError } from './email-code-input';
import { IconInbox } from './icons';

export function EmailPreferences() {
  const id = useId();
  const [preferences, setPreferences] = useState<EmailPreferencesDto | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void authApi
      .emailPreferences(controller.signal)
      .then(setPreferences, (error: unknown) => {
        if (!controller.signal.aborted) setError(emailError(error));
      });
    return () => controller.abort();
  }, [reload]);

  async function verify() {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await authApi.verifyEmail(code);
      setPreferences(await authApi.emailPreferences());
      setCode('');
      setNotice('邮箱验证成功。');
    } catch (error) {
      setError(emailError(error));
    } finally {
      setPending(false);
    }
  }
  async function subscribe(enabled: boolean) {
    if (!preferences || pending) return;
    const previous = preferences;
    setPreferences({ ...previous, messageEmailEnabled: enabled });
    setPending(true);
    setError('');
    setNotice('');
    try {
      setPreferences(await authApi.updateEmailPreferences(enabled));
      setNotice(enabled ? '已订阅聊天新消息邮件。' : '已关闭聊天邮件订阅。');
    } catch (error) {
      setPreferences(previous);
      setError(emailError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel settings-panel" aria-labelledby={`${id}-heading`}>
      <div className="panel-head">
        <IconInbox size={14} />
        <h2 id={`${id}-heading`}>邮箱与通知</h2>
        {preferences && (
          <span
            className={`tag ${preferences.emailVerifiedAt ? 'tag-ok' : 'tag-warn'}`}
          >
            {preferences.emailVerifiedAt ? '邮箱已验证' : '邮箱待验证'}
          </span>
        )}
      </div>
      <div className="settings-panel-body">
        {!preferences ? (
          <>
            {!error && <p role="status">正在加载邮件设置…</p>}
            {error && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setError('');
                  setReload((value) => value + 1);
                }}
              >
                重新加载邮件设置
              </button>
            )}
          </>
        ) : (
          <>
            <div className="settings-row">
              <div>
                <label htmlFor={`${id}-subscription`}>订阅聊天新消息邮件</label>
                <p className="settings-help" id={`${id}-help`}>
                  网页前台在线时显示站内通知；离线时每条对方消息发送一封邮件。邮件不包含聊天正文。
                </p>
              </div>
              <input
                id={`${id}-subscription`}
                type="checkbox"
                role="switch"
                className="toggle"
                aria-describedby={`${id}-help`}
                checked={preferences.messageEmailEnabled}
                disabled={pending || !preferences.emailVerifiedAt}
                onChange={(event) => void subscribe(event.target.checked)}
              />
            </div>
            {!preferences.emailVerifiedAt && (
              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pending) void verify();
                }}
              >
                <p className="settings-help">订阅邮件前，请先验证当前邮箱。</p>
                <EmailCodeInput
                  value={code}
                  onChange={setCode}
                  requestCode={authApi.requestVerificationCode}
                  disabled={pending}
                />
                <button
                  className="btn btn-pri"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? '正在验证…' : '验证邮箱'}
                </button>
              </form>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice-text">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
