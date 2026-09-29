import type {
  AdminNotificationDto,
  ConversationListResponse,
  MessageDto,
  MessagesPage,
  MessagesQuery,
  SendMessageInput,
} from './types';
import { apiRequest } from './api-client';

export const chatApi = {
  async presence(tabId: string, online: boolean): Promise<void> {
    await apiRequest('notifications/presence', online ? 'POST' : 'DELETE', {
      tabId,
    });
  },
  async conversations(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ConversationListResponse> {
    return (
      await apiRequest(
        `conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async messages(
    taskId: string,
    query: MessagesQuery = {},
    signal?: AbortSignal,
  ): Promise<MessagesPage> {
    const params = new URLSearchParams();
    if (query.before) params.set('before', query.before);
    if (query.after) params.set('after', query.after);
    if (query.limit) params.set('limit', String(query.limit));
    return (
      await apiRequest(
        `tasks/${encodeURIComponent(taskId)}/messages?${params}`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async send(taskId: string, input: SendMessageInput): Promise<MessageDto> {
    return (
      await apiRequest(
        `tasks/${encodeURIComponent(taskId)}/messages`,
        'POST',
        input,
      )
    ).json();
  },
  async notifications(signal?: AbortSignal): Promise<AdminNotificationDto[]> {
    return (await apiRequest('notifications', 'GET', undefined, signal)).json();
  },
};
