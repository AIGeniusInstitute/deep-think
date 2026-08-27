import { replaceInApp, stripBasePath, withBasePath } from '../utils/url';

const REQUEST_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const requestPath = /^https?:\/\//i.test(path)
    ? path
    : withBasePath(path.startsWith('/') ? path : `/${path}`);
  const { timeoutMs: customTimeout, ...fetchOptions } = options ?? {};
  const controller = new AbortController();
  const isFormData = fetchOptions.body instanceof FormData;
  const timeoutMs = customTimeout ?? (isFormData ? 120_000 : REQUEST_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // FormData 时不设 Content-Type，让浏览器自动加 multipart boundary
  const headers = isFormData
    ? fetchOptions.headers ?? {}
    : { 'Content-Type': 'application/json', ...fetchOptions.headers };

  let res: Response;
  try {
    res = await fetch(requestPath, {
      credentials: 'include',
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(408, 'Request timeout');
    }
    throw new ApiError(0, 'Network error');
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401) {
    // Avoid redirect loop if already on the login page
    const currentPath = stripBasePath(window.location.pathname);
    if (!currentPath.startsWith('/login')) {
      replaceInApp('/login');
    }
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.code === 'PASSWORD_CHANGE_REQUIRED') {
      const currentPath = stripBasePath(window.location.pathname);
      if (!currentPath.startsWith('/settings')) {
        replaceInApp('/settings');
      }
    }
    throw new ApiError(res.status, body.error || res.statusText, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * 按上传字节数推算请求超时，避免大文件在慢网络下被固定的 120s 超时误杀。
 * 以 20KB/s 的保守下限估算，最少 120s，最多 10min（与后端 requestTimeout 对齐）。
 */
export function computeUploadTimeoutMs(bytes: number): number {
  return Math.min(10 * 60_000, Math.max(120_000, Math.ceil(bytes / (20 * 1024)) * 1000));
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) => apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, ...(timeoutMs ? { timeoutMs } : {}) }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  uploadFiles: async <T>(path: string, files: FileList, extraFields?: Record<string, string>) => {
    const formData = new FormData();
    let totalBytes = 0;
    for (const file of files) {
      formData.append('files', file);
      totalBytes += file.size;
    }
    if (extraFields) for (const [k, v] of Object.entries(extraFields)) formData.append(k, v);
    // 不设 Content-Type，浏览器自动加 boundary
    return apiFetch<T>(path, { method: 'POST', body: formData, headers: {}, timeoutMs: computeUploadTimeoutMs(totalBytes) });
  },
};
