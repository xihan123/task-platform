'use client';
import { useEffect, useState } from 'react';
import type { AttachmentPolicyDto } from '../../lib/types';
import { attachmentsApi } from '../../lib/attachments-api';

export function AttachmentSettings() {
  const [values, setValues] = useState<AttachmentPolicyDto>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void attachmentsApi.policy(controller.signal).then(setValues, () => {
      if (!controller.signal.aborted) setError('附件配置读取失败。');
    });
    return () => controller.abort();
  }, [revision]);
  return (
    <section className="panel settings-panel" style={{ marginTop: 24 }}>
      <div className="panel-head">
        <h2>附件设置</h2>
      </div>
      <form
        className="settings-panel-body settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!values || busy) return;
          setBusy(true);
          setError('');
          setNotice('');
          try {
            setValues(await attachmentsApi.configure(values));
            setNotice('附件设置已保存。保留天数仅影响新上传附件。');
          } catch {
            setError('保存失败，请检查数值后重试。');
          } finally {
            setBusy(false);
          }
        }}
      >
        {values && (
          <>
            <label className="form-field">
              保留天数
              <input
                required
                type="number"
                min="1"
                max="36500"
                step="1"
                value={values.retentionDays}
                disabled={busy}
                onChange={(event) =>
                  setValues({
                    ...values,
                    retentionDays: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="form-field">
              单文件大小上限（MB）
              <input
                required
                type="number"
                min="1"
                max="2147483647"
                step="1"
                value={values.maxSizeMb}
                disabled={busy}
                onChange={(event) =>
                  setValues({
                    ...values,
                    maxSizeMb: Number(event.target.value),
                  })
                }
              />
            </label>
            <p className="settings-help">
              新上传附件按此保留天数固定到期时间，旧附件不变；超限文件提示使用不限速网盘。1
              MB = 1024 × 1024 字节。
            </p>
            <button type="submit" className="btn btn-pri" disabled={busy}>
              {busy ? '保存中…' : '保存附件设置'}
            </button>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
            {!values && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setError('');
                  setRevision((value) => value + 1);
                }}
              >
                重试
              </button>
            )}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </form>
    </section>
  );
}
