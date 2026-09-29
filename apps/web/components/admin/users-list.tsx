'use client';

import { useCallback, useState, type FormEvent } from 'react';
import type { UserDto, UserStatus } from '../../lib/types';
import { adminApi } from '../../lib/admin-api';
import { useAdminData } from './use-admin-data';
import {
  dateText,
  Empty,
  ErrorState,
  errorText,
  Loading,
  Modal,
  PageHeading,
  Pagination,
} from './common';
import { IconSearch } from '../icons';

export function UsersList() {
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<UserDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const cursor = cursors.at(-1);
  const load = useCallback(
    (signal: AbortSignal) =>
      adminApi.users(
        { limit: 20, email, status: status || undefined, cursor },
        signal,
      ),
    [email, status, cursor],
  );
  const { data, error, loading, reload } = useAdminData(
    `users:${email}:${status}:${cursor ?? ''}`,
    load,
  );
  function find(event: FormEvent) {
    event.preventDefault();
    setEmail(search.trim());
    setCursors([undefined]);
  }
  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setActionError('');
    try {
      await adminApi.setUserStatus(
        selected.id,
        selected.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      );
      setSelected(null);
      reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title="用户管理" eyebrow="账户管理" onRefresh={reload} />
      <div className="filters">
        <form className="search-form" onSubmit={find}>
          <label className="sr-only" htmlFor="user-email">
            邮箱筛选
          </label>
          <input
            id="user-email"
            placeholder="按邮箱筛选"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={254}
          />
          <button
            className="btn btn-ic"
            title="筛选用户"
            aria-label="筛选用户"
            type="submit"
          >
            <IconSearch size={14} />
          </button>
        </form>
        <div className="field">
          <label htmlFor="user-status">状态</label>
          <select
            id="user-status"
            aria-label="用户状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as UserStatus | '');
              setCursors([undefined]);
            }}
          >
            <option value="">全部用户</option>
            <option value="ACTIVE">正常</option>
            <option value="DISABLED">已禁用</option>
          </select>
        </div>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data?.items.length ? (
        <Empty>没有符合条件的用户</Empty>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>注册时间</th>
                  <th>状态</th>
                  <th>账户启用</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <span className="mail">{user.email}</span>
                    </td>
                    <td>{user.role === 'ADMIN' ? '管理员' : '用户'}</td>
                    <td>
                      <time dateTime={user.createdAt}>
                        {dateText(user.createdAt)}
                      </time>
                    </td>
                    <td>
                      <span
                        className={`st ${user.status === 'ACTIVE' ? 'st-done' : 'st-cancel'}`}
                      >
                        {user.status === 'ACTIVE' ? '正常' : '已禁用'}
                      </span>
                    </td>
                    <td>
                      {user.role === 'ADMIN' ? (
                        <span className="muted">受保护</span>
                      ) : (
                        <input
                          className="toggle"
                          type="checkbox"
                          role="switch"
                          aria-label={`启用 ${user.email}`}
                          checked={user.status === 'ACTIVE'}
                          onChange={() => {
                            setSelected(user);
                            setActionError('');
                          }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={cursors.length}
            previous={() => setCursors((value) => value.slice(0, -1))}
            next={() => {
              if (data?.nextCursor)
                setCursors((value) => [...value, data.nextCursor!]);
            }}
            hasNext={!loading && !!data?.nextCursor}
          />
        </section>
      )}
      {selected && (
        <Modal
          title={selected.status === 'ACTIVE' ? '禁用用户' : '启用用户'}
          busy={busy}
          close={() => setSelected(null)}
        >
          <p className="dialog-task-title">{selected.email}</p>
          {actionError && (
            <p role="alert" className="error-text">
              {actionError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="btn"
              onClick={() => setSelected(null)}
              disabled={busy}
            >
              返回
            </button>
            <button
              className={
                selected.status === 'ACTIVE' ? 'btn btn-danger' : 'btn btn-pri'
              }
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? '提交中...' : '确认'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
