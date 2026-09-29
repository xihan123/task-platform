'use client';

import { useEffect, useReducer, useState } from 'react';
import { ApiClientError } from '../../lib/api-client';
import { useAdminSession } from './admin-shell';

export function useAdminData<T>(
  scope: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const { user, invalidate } = useAdminSession();
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const key = `${user.id}:${scope}`;
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: unknown;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiClientError &&
          [401, 403].includes(error.status)
        )
          invalidate();
        else setResult({ key, error });
      },
    );
    return () => controller.abort();
  }, [key, load, invalidate, revision]);
  const current = result?.key === key ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !current,
    reload,
  };
}
