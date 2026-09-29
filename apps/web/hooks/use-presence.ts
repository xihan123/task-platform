'use client';

import { useEffect } from 'react';
import { chatApi } from '../lib/chat-api';

export function usePresence(userId: string): void {
  useEffect(() => {
    const tabId = crypto.randomUUID();
    let pending: Promise<void> = Promise.resolve();
    const update = (online: boolean) => {
      // Serialize visibility changes so a late heartbeat cannot undo removal.
      pending = pending
        .then(() => chatApi.presence(tabId, online))
        .catch(() => undefined);
    };
    const visible = () => document.visibilityState === 'visible';
    const onVisibility = () => update(visible());
    const timer = window.setInterval(() => {
      if (visible()) update(true);
    }, 10000);
    update(visible());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      update(false);
    };
  }, [userId]);
}
