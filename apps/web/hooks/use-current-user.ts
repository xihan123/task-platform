'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserDto } from '../lib/types';
import { AuthApiError, authApi } from '../lib/auth-api';

type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; error?: string }
  | { status: 'authenticated'; user: UserDto }
  | { status: 'error' };

export function useCurrentUser() {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const generation = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const { user } = await authApi.me(signal);
      if (current === generation.current)
        setState({ status: 'authenticated', user });
    } catch (error) {
      if (signal?.aborted || current !== generation.current) return;
      if (error instanceof AuthApiError && [401, 403].includes(error.status)) {
        setState({
          status: 'anonymous',
          error: error.status === 403 ? error.code : undefined,
        });
      } else {
        setState({ status: 'error' });
      }
    }
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    setState({ status: 'anonymous' });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    void authApi.me(controller.signal).then(
      ({ user }) => {
        if (current === generation.current && !controller.signal.aborted) {
          setState({ status: 'authenticated', user });
        }
      },
      (error: unknown) => {
        if (current !== generation.current || controller.signal.aborted) return;
        if (
          error instanceof AuthApiError &&
          [401, 403].includes(error.status)
        ) {
          setState({
            status: 'anonymous',
            error: error.status === 403 ? error.code : undefined,
          });
        } else {
          setState({ status: 'error' });
        }
      },
    );
    const onFocus = () => void refresh(controller.signal);
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      generation.current += 1;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { state, refresh, clear };
}
