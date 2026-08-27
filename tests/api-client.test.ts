import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../web/src/api/client';

async function captureApiError(request: Promise<unknown>): Promise<ApiError> {
  try {
    await request;
    throw new Error('Expected apiFetch to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('apiFetch errors', () => {
  it.each([400, 500])(
    'preserves the %i response status, message, and body',
    async (status) => {
      const body = { error: `HTTP ${status}`, detail: 'request failed' };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status,
            statusText: 'Request failed',
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const err = await captureApiError(apiFetch('/api/test'));

      expect(err.name).toBe('ApiError');
      expect(err.status).toBe(status);
      expect(err.message).toBe(`HTTP ${status}`);
      expect(err.body).toEqual(body);
    },
  );

  it('wraps network failures in an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );

    const err = await captureApiError(apiFetch('/api/test'));

    expect(err).toMatchObject({ status: 0, message: 'Network error' });
  });

  it('wraps aborted requests as timeouts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );

    const errorPromise = captureApiError(
      apiFetch('/api/slow', { timeoutMs: 10 }),
    );
    await vi.advanceTimersByTimeAsync(10);
    const err = await errorPromise;

    expect(err).toMatchObject({ status: 408, message: 'Request timeout' });
  });

  it('redirects unauthorized requests and preserves the 401 status', async () => {
    const replace = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://deepthink.example',
        pathname: '/chat',
        replace,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 401, statusText: 'Unauthorized' }),
        ),
    );

    const err = await captureApiError(apiFetch('/api/test'));

    expect(err).toMatchObject({ status: 401, message: 'Unauthorized' });
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('falls back to statusText for non-JSON error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('upstream unavailable', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );

    const err = await captureApiError(apiFetch('/api/test'));

    expect(err).toMatchObject({
      status: 502,
      message: 'Bad Gateway',
      body: {},
    });
  });
});
