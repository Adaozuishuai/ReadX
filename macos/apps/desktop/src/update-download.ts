import type { EventEmitter } from 'node:events';

type DownloadSource = Pick<EventEmitter, 'once' | 'removeListener'> & { downloadUpdate(): Promise<unknown> };

// On Mac the ZIP transfer can finish before Squirrel has verified/prepared it.
// Enable installation only after both transfer and update-downloaded complete.
export function downloadVerifiedUpdate(updater: DownloadSource): Promise<void> {
  return new Promise((resolve, reject) => {
    let transferred = false;
    let ready = false;
    const cleanup = () => {
      updater.removeListener('update-downloaded', onReady);
      updater.removeListener('error', onError);
    };
    const finish = () => { if (transferred && ready) { cleanup(); resolve(); } };
    const onReady = () => { ready = true; finish(); };
    const onError = (error: unknown) => { cleanup(); reject(error); };
    updater.once('update-downloaded', onReady);
    updater.once('error', onError);
    void Promise.resolve().then(() => updater.downloadUpdate()).then(() => {
      transferred = true;
      finish();
    }, onError);
  });
}
