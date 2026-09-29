import type { ApiErrorResponse } from './types';

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export function apiEndpoint(path: string): URL {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  const base = configured
    ? new URL(configured)
    : new URL('/api/', window.location.href);
  if (!configured && process.env.NODE_ENV !== 'production') base.port = '4000';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(path, base);
}

export async function apiRequest(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(apiEndpoint(path), {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal,
      headers:
        method !== 'GET'
          ? {
              ...(body instanceof FormData
                ? {}
                : { 'Content-Type': 'application/json' }),
              'X-CSRF-Protection': '1',
            }
          : {},
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiClientError('NETWORK_ERROR', 0);
  }
  if (!response.ok) {
    const error: Partial<ApiErrorResponse> | null = await response
      .json()
      .catch(() => null);
    throw new ApiClientError(
      typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
      response.status,
    );
  }
  return response;
}
