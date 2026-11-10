import { describe, expect, it, vi } from 'vitest';
import { createHttpProxy, MAX_REDIRECTS, type SendFn } from './httpProxy.js';

type Init = Parameters<SendFn>[1];

const ok = (body = 'hello', headers: Record<string, string> = {}, status = 200) =>
  new Response(body, { status, headers });
const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

function proxy(send: SendFn, validate = vi.fn(async () => {}), timeoutMs?: number) {
  return { request: createHttpProxy({ send, validate, timeoutMs }), validate };
}

describe('httpProxy request', () => {
  it('returns status, text body and lowercased headers', async () => {
    const send = vi.fn<SendFn>(async () => ok('<multistatus/>', { ETag: '"abc-gzip"', 'Content-Type': 'text/xml' }, 207));
    const { request } = proxy(send);
    expect(await request('propfind', 'https://dav.example.com/x/', { Depth: '1' }, null)).toEqual({
      status: 207,
      statusText: '',
      body: '<multistatus/>',
      headers: { etag: '"abc-gzip"', 'content-type': 'text/xml' },
    });
    const init = send.mock.calls[0][1] as Init;
    expect(init.method).toBe('PROPFIND');
    expect(init.headers).toEqual({ Depth: '1' });
    expect(init.redirect).toBe('manual');
    expect('body' in init).toBe(false);
  });

  it('refuses methods outside the list and malformed arguments, without sending', async () => {
    const send = vi.fn<SendFn>();
    const { request } = proxy(send);
    expect(await request('TRACE', 'https://a.example.com/', {}, null)).toEqual({ error: 'Method not allowed: TRACE' });
    expect(await request('GET', 42, {}, null)).toEqual({ error: 'Invalid URL' });
    expect(await request('PUT', 'https://a.example.com/', {}, new Uint8Array(1))).toEqual({ error: 'Only text bodies are supported' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a refused URL as an error, not an HTTP status, and never sends it', async () => {
    const send = vi.fn<SendFn>();
    const { request } = proxy(send, vi.fn(async () => { throw new Error('Private/reserved address'); }));
    expect(await request('GET', 'https://192.168.1.10/', {}, null)).toEqual({ error: 'Private/reserved address' });
    expect(send).not.toHaveBeenCalled();
  });

  it('checks every redirect hop, marked as a redirect', async () => {
    const send = vi.fn<SendFn>()
      .mockResolvedValueOnce(redirect(302, 'http://127.0.0.1/admin'));
    const validate = vi.fn(async (_url: string, isRedirect: boolean) => {
      if (isRedirect) throw new Error('Redirect to a private address');
    });
    const { request } = proxy(send, validate);
    expect(await request('GET', 'https://public.example.com/', {}, null)).toEqual({ error: 'Redirect to a private address' });
    expect(validate).toHaveBeenLastCalledWith('http://127.0.0.1/admin', true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('drops credentials on a redirect to another origin, and keeps them on the same origin', async () => {
    const send = vi.fn<SendFn>()
      .mockResolvedValueOnce(redirect(307, '/dav/'))
      .mockResolvedValueOnce(redirect(307, 'https://cdn.example.net/file'))
      .mockResolvedValueOnce(ok());
    const { request } = proxy(send);
    await request('GET', 'https://dav.example.com/old', { Authorization: 'Basic c2VjcmV0', Cookie: 'a=b', Depth: '0' }, null);
    const headersAt = (i: number) => (send.mock.calls[i][1] as Init).headers;
    expect(headersAt(1)).toEqual({ Authorization: 'Basic c2VjcmV0', Cookie: 'a=b', Depth: '0' });
    expect(headersAt(2)).toEqual({ Depth: '0' });
    expect(send.mock.calls[2][0]).toBe('https://cdn.example.net/file');
  });

  it('treats a port change as another origin', async () => {
    const send = vi.fn<SendFn>()
      .mockResolvedValueOnce(redirect(302, 'https://dav.example.com:8443/'))
      .mockResolvedValueOnce(ok());
    const { request } = proxy(send);
    await request('GET', 'https://dav.example.com/', { authorization: 'Bearer t' }, null);
    expect((send.mock.calls[1][1] as Init).headers).toEqual({});
  });

  it('rewrites to a bodyless GET on 303, and on 301/302 after a POST; 307 keeps method and body', async () => {
    const send = vi.fn<SendFn>()
      .mockResolvedValueOnce(redirect(307, '/a'))
      .mockResolvedValueOnce(redirect(303, '/b'))
      .mockResolvedValueOnce(ok());
    const { request } = proxy(send);
    await request('POST', 'https://vault.example.com/start', {}, '{"x":1}');
    const init = (i: number) => send.mock.calls[i][1] as Init;
    expect([init(1).method, init(1).body]).toEqual(['POST', '{"x":1}']);
    expect([init(2).method, 'body' in init(2)]).toEqual(['GET', false]);
  });

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    const send = vi.fn<SendFn>(async () => redirect(302, '/again'));
    const { request } = proxy(send);
    expect(await request('GET', 'https://loop.example.com/', {}, null)).toEqual({ error: 'Too many redirects' });
    expect(send).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('times out a server that never answers', async () => {
    const send: SendFn = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const { request } = proxy(send, undefined, 20);
    expect(await request('GET', 'https://slow.example.com/', {}, null)).toEqual({ error: 'The server did not respond within 0 s' });
  });

  it('reports a network failure as an error', async () => {
    const { request } = proxy(vi.fn<SendFn>(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }));
    expect(await request('GET', 'https://down.example.com/', {}, null)).toEqual({ error: 'net::ERR_CONNECTION_REFUSED' });
  });
});
