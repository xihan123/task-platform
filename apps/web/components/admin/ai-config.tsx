'use client';

import { useState, type FormEvent } from 'react';
import { adminApi } from '../../lib/admin-api';
import { useAdminData } from './use-admin-data';
import {
  Empty,
  ErrorState,
  errorText,
  Loading,
  Modal,
  PageHeading,
} from './common';
import { IconKey, IconLayers, IconPlus, IconServer } from '../icons';

export function AiConfig() {
  const { data, error, loading, reload } = useAdminData(
    'ai-config',
    adminApi.aiConfiguration,
  );
  const [form, setForm] = useState<{
    kind: 'resource' | 'model' | 'key';
    endpointId?: string;
    baseUrl?: string;
  } | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  function open(next: NonNullable<typeof form>) {
    setForm(next);
    setBaseUrl(next.baseUrl ?? '');
    setModel('');
    setApiKey('');
    setActionError('');
  }
  function close() {
    setForm(null);
    setApiKey('');
    setActionError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || busy) return;
    setBusy(true);
    setActionError('');
    try {
      if (form.kind === 'resource')
        await adminApi.configureResource({ baseUrl, model, apiKey });
      else if (form.kind === 'model')
        await adminApi.addAiModel(form.endpointId!, model);
      else await adminApi.addAiKey(form.endpointId!, apiKey);
      close();
      reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
      setApiKey('');
    }
  }
  async function toggle(
    kind: 'endpoints' | 'models' | 'keys',
    id: string,
    enabled: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await adminApi.setAiEnabled(kind, id, enabled);
      reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title="模型配置" eyebrow="智能审核" onRefresh={reload}>
        <button
          className="btn btn-pri"
          onClick={() => open({ kind: 'resource' })}
        >
          <IconPlus size={13} />
          新增服务商
        </button>
      </PageHeading>
      {!form && actionError && (
        <p role="alert" className="error-text" style={{ marginBottom: 12 }}>
          {actionError}
        </p>
      )}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data?.length ? (
        <Empty>暂无模型服务商</Empty>
      ) : (
        <div className="provider-list">
          {data.map((endpoint) => (
            <section key={endpoint.id} className="panel provider-group">
              <header>
                <div className="provider-title">
                  <span className="ic">
                    <IconServer size={16} />
                  </span>
                  <div>
                    <h2 className="mono">{endpoint.baseUrl}</h2>
                    <span className="muted">OpenAI 兼容协议</span>
                  </div>
                </div>
                <label className="toggle-label">
                  服务启用
                  <input
                    className="toggle"
                    type="checkbox"
                    role="switch"
                    aria-label={`启用服务 ${endpoint.baseUrl}`}
                    checked={endpoint.enabled}
                    disabled={busy}
                    onChange={(event) =>
                      void toggle(
                        'endpoints',
                        endpoint.id,
                        event.target.checked,
                      )
                    }
                  />
                </label>
              </header>
              <div
                className={`provider-parts ${endpoint.enabled ? '' : 'provider-disabled'}`}
              >
                <div>
                  <div className="block-h">
                    <h3>
                      <IconLayers size={13} />
                      模型
                    </h3>
                    <button
                      className="btn btn-ghost btn-ic"
                      title="添加模型"
                      aria-label={`添加模型 ${endpoint.baseUrl}`}
                      onClick={() =>
                        open({
                          kind: 'model',
                          endpointId: endpoint.id,
                          baseUrl: endpoint.baseUrl,
                        })
                      }
                    >
                      <IconPlus size={13} />
                    </button>
                  </div>
                  {endpoint.models.map((item) => (
                    <div className="resource-row" key={item.id}>
                      <span className="mono">{item.name}</span>
                      <input
                        type="checkbox"
                        role="switch"
                        className="toggle"
                        checked={item.enabled}
                        aria-label={`启用模型 ${item.name}`}
                        disabled={busy}
                        onChange={(event) =>
                          void toggle('models', item.id, event.target.checked)
                        }
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <div className="block-h">
                    <h3>
                      <IconKey size={13} />
                      接口密钥
                    </h3>
                    <button
                      className="btn btn-ghost btn-ic"
                      title="添加密钥"
                      aria-label={`添加密钥 ${endpoint.baseUrl}`}
                      onClick={() =>
                        open({
                          kind: 'key',
                          endpointId: endpoint.id,
                          baseUrl: endpoint.baseUrl,
                        })
                      }
                    >
                      <IconPlus size={13} />
                    </button>
                  </div>
                  {endpoint.keys.map((item) => (
                    <div className="resource-row" key={item.id}>
                      <code className="mono">{item.maskedKey}</code>
                      <input
                        type="checkbox"
                        role="switch"
                        className="toggle"
                        checked={item.enabled}
                        aria-label={`启用密钥 ${item.maskedKey}`}
                        disabled={busy}
                        onChange={(event) =>
                          void toggle('keys', item.id, event.target.checked)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      {form && (
        <Modal
          title={
            form.kind === 'resource'
              ? '新增模型服务商'
              : form.kind === 'model'
                ? '添加模型'
                : '添加密钥'
          }
          busy={busy}
          close={close}
        >
          <form onSubmit={(event) => void submit(event)}>
            {form.kind === 'resource' ? (
              <label className="form-field">
                服务地址
                <input
                  type="url"
                  placeholder="https://provider.example/v1/"
                  required
                  maxLength={2048}
                  value={baseUrl}
                  disabled={busy}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
            ) : (
              <p className="dialog-task-title">{form.baseUrl}</p>
            )}
            {form.kind !== 'key' && (
              <label className="form-field">
                模型名称
                <input
                  required
                  maxLength={128}
                  value={model}
                  disabled={busy}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
            )}
            {form.kind !== 'model' && (
              <label className="form-field">
                接口密钥
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={512}
                  value={apiKey}
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            )}
            {actionError && (
              <p role="alert" className="error-text">
                {actionError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={close}
              >
                返回
              </button>
              <button type="submit" className="btn btn-pri" disabled={busy}>
                {busy ? '保存中...' : '保存配置'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
