'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import type { TaskFeedQuery, UserDto } from '../lib/types';
import { ApiClientError } from '../lib/api-client';
import { tasksApi } from '../lib/tasks-api';

type Viewer = Pick<UserDto, 'id' | 'role' | 'status'> | null | undefined;

function viewerKey(viewer: Viewer): string {
  if (viewer === undefined) return 'loading';
  return viewer ? `${viewer.id}:${viewer.role}:${viewer.status}` : 'anonymous';
}

function useTaskQuery<T>(
  identity: string,
  enabled: boolean,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const key = identity;
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
  }, [enabled, key, load, revision]);

  // A viewer change hides the previous account's private data before the next effect runs.
  const current = enabled && result?.key === key ? result : undefined;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: enabled && !current,
    reload,
  };
}

export function useTasks(viewer: Viewer, query: TaskFeedQuery = {}) {
  const { limit = 20, cursor, scope = 'public' } = query;
  const load = useCallback(
    (signal: AbortSignal) => tasksApi.list({ limit, cursor, scope }, signal),
    [limit, cursor, scope],
  );
  return useTaskQuery(
    `${viewerKey(viewer)}:list:${scope}:${limit}:${cursor ?? ''}`,
    viewer !== undefined &&
      (scope === 'public' ||
        (viewer?.role === 'USER' && viewer.status === 'ACTIVE')),
    load,
  );
}

export function usePublicTaskStats(enabled: boolean) {
  const load = useCallback(
    (signal: AbortSignal) => tasksApi.publicStats(signal),
    [],
  );
  return useTaskQuery('public-stats', enabled, load);
}

export function useTask(viewer: Viewer, id?: string) {
  const load = useCallback(
    (signal: AbortSignal) => tasksApi.findOne(id!, signal),
    [id],
  );
  return useTaskQuery(
    `${viewerKey(viewer)}:detail:${id ?? ''}`,
    viewer !== undefined && !!id,
    load,
  );
}
