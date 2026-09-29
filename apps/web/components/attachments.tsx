'use client';

import { useEffect, useRef, useState } from 'react';
import type { AttachmentDto, AttachmentPolicyDto } from '../lib/types';
import { attachmentsApi, attachmentError } from '../lib/attachments-api';
import './attachments.css';

export function AttachmentList({ files }: { files: AttachmentDto[] }) {
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!files.length) return null;
  return (
    <div className="attachment-list">
      {files.map((file) => {
        const expired = file.deleted || Date.parse(file.expiresAt) <= now;
        return (
          <div className="attachment-file" key={file.id}>
            <button
              type="button"
              disabled={expired || !!downloading}
              onClick={async () => {
                setError('');
                setDownloading(file.id);
                try {
                  await attachmentsApi.download(file);
                } catch (error) {
                  setError(attachmentError(error));
                } finally {
                  setDownloading(null);
                }
              }}
            >
              {downloading === file.id ? '正在下载…' : file.fileName}
            </button>
            <small>
              {expired
                ? '附件已过期删除'
                : `${(file.size / 1024).toFixed(1)} KB · ${new Date(file.expiresAt).toLocaleString('zh-CN')} 到期`}
            </small>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}

export function AttachmentPicker({
  files,
  onChange,
  disabled,
  onBusy,
  existingIds = [],
}: {
  files: AttachmentDto[];
  onChange: (files: AttachmentDto[]) => void;
  disabled?: boolean;
  onBusy: (busy: boolean) => void;
  existingIds?: string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [policy, setPolicy] = useState<AttachmentPolicyDto>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cannotAdd = !!disabled || busy || !policy || files.length >= 10;
  useEffect(() => {
    const controller = new AbortController();
    void attachmentsApi
      .policy(controller.signal)
      .then(setPolicy, (error: unknown) => {
        if (!controller.signal.aborted) setError(attachmentError(error));
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <div className="attachment-picker">
      <button
        type="button"
        className="btn"
        disabled={cannotAdd}
        onClick={() => inputRef.current?.click()}
      >
        添加附件
      </button>
      <input
        ref={inputRef}
        type="file"
        aria-label="添加附件"
        hidden
        multiple
        disabled={cannotAdd}
        onChange={async (event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (!policy || !selected.length) return;
          setError('');
          if (selected.length + files.length > 10) {
            setError('每份正文或消息最多添加 10 个附件。');
            return;
          }
          if (
            selected.some((file) => file.size > policy.maxSizeMb * 1024 * 1024)
          ) {
            setError(
              '文件超过当前上限，请使用不限速网盘，并在任务或讨论中提供分享链接。',
            );
            return;
          }
          setBusy(true);
          onBusy(true);
          const uploaded = [...files];
          try {
            for (const file of selected) {
              uploaded.push(await attachmentsApi.upload(file));
              onChange([...uploaded]);
            }
          } catch (error) {
            setError(attachmentError(error));
            setRevision((value) => value + 1);
          } finally {
            setBusy(false);
            onBusy(false);
          }
        }}
      />
      <p className="attachment-help">
        {busy
          ? '正在上传…'
          : policy
            ? `单文件 ≤ ${policy.maxSizeMb} MB，上传后保留 ${policy.retentionDays} 天，到期永久删除。`
            : '正在读取附件限制…'}
      </p>
      {files.map((file) => (
        <div className="attachment-selected" key={file.id}>
          <span>
            {file.fileName}
            {file.deleted ? ' · 已过期删除' : ''}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || busy}
            aria-label={`移除 ${file.fileName}`}
            onClick={async () => {
              setBusy(true);
              onBusy(true);
              setError('');
              try {
                if (!existingIds.includes(file.id))
                  await attachmentsApi.discard(file.id);
                onChange(files.filter((item) => item.id !== file.id));
              } catch (error) {
                setError(attachmentError(error));
              } finally {
                setBusy(false);
                onBusy(false);
              }
            }}
          >
            移除
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="error-text">
          {error}
          {!policy && (
            <button
              type="button"
              className="btn btn-ghost"
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
    </div>
  );
}
