'use client';

import { useEffect, useReducer, useState } from 'react';
import type { TaskCompletionDto, UserDto } from '../lib/types';
import { ApiClientError } from '../lib/api-client';
import { tasksApi } from '../lib/tasks-api';

export function useTaskCompletion(taskId: string, user: UserDto) {
  const key = `${taskId}:${user.id}:${user.role}:${user.status}`;
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const [result, setResult] = useState<{
    key: string;
    data?: TaskCompletionDto;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const data = await tasksApi.completion(taskId, controller.signal);
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            key,
            error:
              error instanceof ApiClientError ? error.code : 'REQUEST_FAILED',
          });
      } finally {
        fetching = false;
      }
    }
    const refreshOnFocus = () => void refresh();
    void refresh();
    const timer = setInterval(refreshOnFocus, 5000);
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [key, taskId, revision]);
  const current = result?.key === key ? result : undefined;
  return { data: current?.data, error: current?.error, reload };
}
