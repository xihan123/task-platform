import type {
  AdminNotificationDto,
  AiResourceDto,
  TaskModerationDto,
  AdminDashboardDto,
  AdminTaskListQuery,
  AdminTaskListResponse,
  AdminTaskRow,
  AdminUserListQuery,
  AdminUserListResponse,
  ManualReviewInput,
  AdminTaskDto,
  UserDto,
  UserStatus,
  AiEndpointDto,
  TaskCompletionDto,
} from './types';
import { apiRequest } from './api-client';

export const adminApi = {
  async requestCompletion(id: string): Promise<TaskCompletionDto> {
    return (
      await apiRequest(
        `admin/tasks/${encodeURIComponent(id)}/complete-request`,
        'POST',
      )
    ).json();
  },
  async addAiModel(endpointId: string, name: string): Promise<void> {
    await apiRequest(
      `admin/ai/endpoints/${encodeURIComponent(endpointId)}/models`,
      'POST',
      { name },
    );
  },
  async addAiKey(endpointId: string, apiKey: string): Promise<void> {
    await apiRequest(
      `admin/ai/endpoints/${encodeURIComponent(endpointId)}/keys`,
      'POST',
      { apiKey },
    );
  },
  async dashboard(signal?: AbortSignal): Promise<AdminDashboardDto> {
    return (
      await apiRequest('admin/dashboard', 'GET', undefined, signal)
    ).json();
  },
  async tasks(
    query: AdminTaskListQuery = {},
    signal?: AbortSignal,
  ): Promise<AdminTaskListResponse> {
    const params = new URLSearchParams();
    if (query.view) params.set('view', query.view);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    return (
      await apiRequest(`admin/tasks?${params}`, 'GET', undefined, signal)
    ).json();
  },
  async task(id: string, signal?: AbortSignal): Promise<AdminTaskRow> {
    return (
      await apiRequest(
        `admin/tasks/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async take(id: string): Promise<AdminTaskDto> {
    return (
      await apiRequest(`admin/tasks/${encodeURIComponent(id)}/take`, 'POST')
    ).json();
  },
  async review(id: string, input: ManualReviewInput): Promise<AdminTaskDto> {
    return (
      await apiRequest(
        `admin/tasks/${encodeURIComponent(id)}/review`,
        'POST',
        input,
      )
    ).json();
  },
  async retryModeration(id: string, moderationId: string): Promise<void> {
    await apiRequest(
      `admin/tasks/${encodeURIComponent(id)}/moderations/${encodeURIComponent(moderationId)}/retry`,
      'POST',
    );
  },
  async users(
    query: AdminUserListQuery = {},
    signal?: AbortSignal,
  ): Promise<AdminUserListResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.email) params.set('email', query.email);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    return (
      await apiRequest(`admin/users?${params}`, 'GET', undefined, signal)
    ).json();
  },
  async setUserStatus(id: string, status: UserStatus): Promise<UserDto> {
    return (
      await apiRequest(
        `admin/users/${encodeURIComponent(id)}/status`,
        'PATCH',
        { status },
      )
    ).json();
  },
  async aiConfiguration(signal?: AbortSignal): Promise<AiEndpointDto[]> {
    return (
      await apiRequest('admin/ai/config', 'GET', undefined, signal)
    ).json();
  },
  async setAiEnabled(
    kind: 'endpoints' | 'models' | 'keys',
    id: string,
    enabled: boolean,
  ): Promise<void> {
    await apiRequest(`admin/ai/${kind}/${encodeURIComponent(id)}`, 'PATCH', {
      enabled,
    });
  },
  async moderations(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskModerationDto[]> {
    return (
      await apiRequest(
        `admin/tasks/${encodeURIComponent(taskId)}/moderations`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async resources(signal?: AbortSignal): Promise<AiResourceDto[]> {
    return (
      await apiRequest('admin/ai/resources', 'GET', undefined, signal)
    ).json();
  },
  async configureResource(input: {
    baseUrl: string;
    model: string;
    apiKey: string;
  }): Promise<AiResourceDto> {
    return (await apiRequest('admin/ai/resources', 'POST', input)).json();
  },
  async notifications(signal?: AbortSignal): Promise<AdminNotificationDto[]> {
    return (
      await apiRequest('admin/notifications', 'GET', undefined, signal)
    ).json();
  },
};
