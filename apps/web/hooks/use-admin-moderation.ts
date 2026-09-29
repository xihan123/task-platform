'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import type { UserDto } from '../lib/types';
import { adminApi } from '../lib/admin-api';
import { ApiClientError } from '../lib/api-client';

function useAdminQuery<T>(
  viewer: UserDto | null | undefined,
  scope: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const enabled = viewer?.role === 'ADMIN' && viewer.status === 'ACTIVE';
  const key = `${viewer?.id ?? 'none'}:${scope}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: ApiClientError | null;
  }>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data, error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            data: null,
            error:
              error instanceof ApiClientError
                ? error
                : new ApiClientError('REQUEST_FAILED', 0),
          });
      },
    );
    return () => controller.abort();
  }, [enabled, key, load]);
  const current = enabled && result?.key === key ? result : undefined;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: enabled && !current,
    reload,
  };
}

export function useTaskModerations(
  viewer: UserDto | null | undefined,
  taskId: string,
) {
  const load = useCallback(
    (signal: AbortSignal) => adminApi.moderations(taskId, signal),
    [taskId],
  );
  return useAdminQuery(viewer, `moderations:${taskId}`, load);
}

export function useAiResources(viewer: UserDto | null | undefined) {
  return useAdminQuery(viewer, 'ai-resources', adminApi.resources);
}

export function useAdminNotifications(viewer: UserDto | null | undefined) {
  return useAdminQuery(viewer, 'notifications', adminApi.notifications);
}
