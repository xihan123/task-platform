import type {
  CreateTaskInput,
  TaskFeedQuery,
  PrivateTaskDto,
  TaskDto,
  TaskListResponse,
  UpdateTaskInput,
  TaskCompletionDto,
  PublicTaskStatsDto,
} from './types';
import { apiRequest } from './api-client';

export const tasksApi = {
  async publicStats(signal?: AbortSignal): Promise<PublicTaskStatsDto> {
    return (
      await apiRequest('tasks/public-stats', 'GET', undefined, signal)
    ).json();
  },
  async completion(
    id: string,
    signal?: AbortSignal,
  ): Promise<TaskCompletionDto> {
    return (
      await apiRequest(
        `tasks/${encodeURIComponent(id)}/completion`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async confirmCompletion(id: string): Promise<PrivateTaskDto> {
    return (
      await apiRequest(
        `tasks/${encodeURIComponent(id)}/confirm-completion`,
        'POST',
      )
    ).json();
  },
  async list(
    query: TaskFeedQuery = {},
    signal?: AbortSignal,
  ): Promise<TaskListResponse> {
    const params = new URLSearchParams();
    if (query.scope) params.set('scope', query.scope);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    return (
      await apiRequest(`tasks?${params.toString()}`, 'GET', undefined, signal)
    ).json();
  },
  async findOne(id: string, signal?: AbortSignal): Promise<TaskDto> {
    return (
      await apiRequest(
        `tasks/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        signal,
      )
    ).json();
  },
  async create(input: CreateTaskInput): Promise<PrivateTaskDto> {
    return (await apiRequest('tasks', 'POST', input)).json();
  },
  async update(id: string, input: UpdateTaskInput): Promise<PrivateTaskDto> {
    return (
      await apiRequest(`tasks/${encodeURIComponent(id)}`, 'PATCH', input)
    ).json();
  },
  async cancel(id: string): Promise<PrivateTaskDto> {
    return (
      await apiRequest(`tasks/${encodeURIComponent(id)}/cancel`, 'POST')
    ).json();
  },
};
