'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageDto } from '../lib/types';
import { apiEndpoint, ApiClientError } from '../lib/api-client';
import { chatApi } from '../lib/chat-api';
import { mergeMessages } from '../lib/chat-state';

interface ChatState {
  key: string;
  messages: MessageDto[];
  loading: boolean;
  connected: boolean;
  error: string | null;
  olderCursor: string | null;
  canSend: boolean;
  remainingMessages: number | null;
}

export function useTaskChat(taskId: string, userId: string) {
  const key = `${taskId}:${userId}`;
  const [state, setState] = useState<ChatState>({
    key,
    messages: [],
    loading: true,
    connected: false,
    error: null,
    olderCursor: null,
    canSend: false,
    remainingMessages: null,
  });
  const syncRef = useRef<() => Promise<void>>(async () => undefined);
  const reconnectRef = useRef<() => void>(() => undefined);
  const lastSend = useRef<{
    id: string;
    content: string;
    attachmentIds: string[];
  } | null>(null);
  const activeKey = useRef(key);

  useEffect(() => {
    activeKey.current = key;
    lastSend.current = null;
    const controller = new AbortController();
    let highWater: string | undefined;
    let running: Promise<void> | null = null;
    let requested = false;
    let denied = false;
    const empty: ChatState = {
      key,
      messages: [],
      loading: true,
      connected: false,
      error: null,
      olderCursor: null,
      canSend: false,
      remainingMessages: null,
    };
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    function fail(error: unknown) {
      if (controller.signal.aborted) return;
      const code =
        error instanceof ApiClientError ? error.code : 'CHAT_UNAVAILABLE';
      const forbidden = [
        'UNAUTHENTICATED',
        'ACCOUNT_DISABLED',
        'CONVERSATION_FORBIDDEN',
        'TASK_NOT_FOUND',
      ].includes(code);
      if (forbidden) {
        denied = true;
        socket?.close();
      }
      setState((previous) => ({
        ...(previous.key === key ? previous : empty),
        loading: false,
        error: code,
        ...(forbidden
          ? { messages: [], olderCursor: null, connected: false }
          : {}),
      }));
    }
    async function fetchMissing() {
      do {
        requested = false;
        let more = false;
        do {
          const initial = !highWater;
          const page = await chatApi.messages(
            taskId,
            { after: highWater, limit: 50 },
            controller.signal,
          );
          if (controller.signal.aborted || denied) return;
          const pending = lastSend.current;
          if (
            pending &&
            page.items.some(
              (message) =>
                message.id === pending.id &&
                message.senderId === userId &&
                message.content === pending.content &&
                JSON.stringify(
                  message.attachments.map((file) => file.id).sort(),
                ) === JSON.stringify(pending.attachmentIds),
            )
          )
            lastSend.current = null;
          highWater = page.items.at(-1)?.id ?? highWater;
          setState((previous) => ({
            ...(previous.key === key ? previous : empty),
            loading: false,
            error: null,
            canSend: page.canSend,
            remainingMessages: page.remainingMessages,
            messages: mergeMessages(
              previous.key === key ? previous.messages : [],
              page.items,
            ),
            olderCursor: initial ? page.olderCursor : previous.olderCursor,
          }));
          more = !!page.newerCursor;
        } while (more);
      } while (requested && !controller.signal.aborted && !denied);
    }
    async function sync() {
      if (controller.signal.aborted || denied) return;
      requested = true;
      if (running) return running;
      running = fetchMissing().catch(fail);
      try {
        await running;
      } finally {
        running = null;
      }
    }
    syncRef.current = sync;
    function connect() {
      if (controller.signal.aborted || denied) return;
      if (
        socket?.readyState === WebSocket.CONNECTING ||
        socket?.readyState === WebSocket.OPEN
      )
        return;
      const endpoint = apiEndpoint(
        'tasks/' + encodeURIComponent(taskId) + '/events',
      );
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection = new WebSocket(endpoint);
      socket = connection;
      connection.onopen = () => {
        retryCount = 0;
        setState((previous) => ({
          ...(previous.key === key ? previous : empty),
          connected: true,
        }));
        void sync();
      };
      connection.onmessage = (event) => {
        try {
          const payload: unknown = JSON.parse(event.data as string);
          if (
            payload &&
            typeof payload === 'object' &&
            'event' in payload &&
            (payload.event === 'message:new' ||
              payload.event === 'task:activity')
          )
            void sync();
        } catch {
          /* Ignore malformed realtime hints; HTTP remains authoritative. */
        }
      };
      connection.onclose = () => {
        if (controller.signal.aborted || socket !== connection) return;
        setState((previous) => ({ ...previous, connected: false }));
        void sync();
        if (!denied) {
          retryTimer = setTimeout(
            connect,
            Math.min(5000, 500 * 2 ** retryCount),
          );
          retryCount += 1;
        }
      };
    }
    reconnectRef.current = connect;
    const onFocus = () => {
      void sync();
      connect();
    };
    window.addEventListener('focus', onFocus);
    void sync();
    connect();
    return () => {
      controller.abort();
      activeKey.current = '';
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      reconnectRef.current = () => undefined;
      window.removeEventListener('focus', onFocus);
    };
  }, [key, taskId, userId]);

  const send = useCallback(
    async (content: string, attachmentIds: string[] = []) => {
      const input =
        lastSend.current?.content === content &&
        JSON.stringify(lastSend.current.attachmentIds) ===
          JSON.stringify([...attachmentIds].sort())
          ? lastSend.current
          : {
              id: crypto.randomUUID(),
              content,
              attachmentIds: [...attachmentIds].sort(),
            };
      lastSend.current = input;
      let message: MessageDto;
      try {
        message = await chatApi.send(taskId, input);
      } catch (error) {
        await syncRef.current();
        // A lost POST response must not leave an already committed third message
        // stuck as an unsendable draft when the durable quota reaches zero.
        if (activeKey.current === key && lastSend.current === null) return;
        throw error;
      }
      if (activeKey.current !== key) return;
      lastSend.current = null;
      setState((previous) => ({
        ...previous,
        messages: mergeMessages(previous.messages, [message]),
      }));
      await syncRef.current();
    },
    [taskId, key],
  );

  const older = useCallback(async () => {
    if (state.key !== key || !state.olderCursor) return;
    const page = await chatApi.messages(taskId, { before: state.olderCursor });
    if (activeKey.current !== key) return;
    setState((previous) => ({
      ...previous,
      messages: mergeMessages(previous.messages, page.items),
      olderCursor: page.olderCursor,
    }));
  }, [key, taskId, state.olderCursor, state.key]);

  const refresh = useCallback(() => {
    reconnectRef.current();
    void syncRef.current();
  }, []);
  const current =
    state.key === key
      ? state
      : {
          key,
          messages: [],
          loading: true,
          connected: false,
          error: null,
          olderCursor: null,
          canSend: false,
          remainingMessages: null,
        };
  return { ...current, send, older, refresh };
}
