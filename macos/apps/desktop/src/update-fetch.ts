import type { Net } from 'electron';

// Electron net.fetch neither exposes Response.url nor returns manual redirects
// consistently. Read that one redirect with net.request; all payloads still use
// the Chromium fetch stack and the user's configured system proxy.
export function createUpdateFetcher(network: Pick<Net, 'fetch' | 'request'>) {
  return (url: string, signal: AbortSignal, redirect: 'follow' | 'manual' = 'follow'): Promise<Response> => {
    if (redirect !== 'manual') return network.fetch(url, { signal, headers: {
      Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/octet-stream',
    } });
    return new Promise((resolve, reject) => {
      const request = network.request({ url, redirect: 'manual' });
      let settled = false;
      const finish = (response?: Response, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(response!);
        request.abort();
      };
      const onAbort = () => finish(undefined, signal.reason ?? new Error('Update request aborted'));
      request.on('redirect', (status, _method, destination) => finish(new Response(null, {
        status, headers: { location: destination },
      })));
      request.on('response', response => finish(new Response(null, { status: response.statusCode })));
      request.on('error', error => finish(undefined, error));
      request.setHeader('Accept', 'text/html');
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        request.end();
      }
    });
  };
}
