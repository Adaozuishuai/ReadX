import type { DesktopUpdateStatus } from '@cbct/shared';
import { updateFailureStatus } from './update-status';

interface UpdateActions {
  currentVersion: string;
  supported: boolean;
  check(): Promise<DesktopUpdateStatus>;
  download(): Promise<unknown>;
  install(): void;
  publish(status: DesktopUpdateStatus): void;
  checkTimeoutMs?: number;
}

// The main process owns state, including when a window reloads or callers race.
export class UpdateController {
  private status: DesktopUpdateStatus;
  private checking?: Promise<DesktopUpdateStatus>;
  private downloading?: Promise<DesktopUpdateStatus>;
  private available?: DesktopUpdateStatus;
  private downloaded = false;
  private installing = false;

  constructor(private readonly actions: UpdateActions) {
    this.status = actions.supported ? { state: 'idle', currentVersion: actions.currentVersion } : {
      state: 'unsupported', currentVersion: actions.currentVersion,
      message: '请使用已发布的 Windows 或 macOS 安装版检查更新；开发版不会自动替换源码。',
    };
  }

  getStatus(): DesktopUpdateStatus { return { ...this.status }; }

  private publish(status: DesktopUpdateStatus): DesktopUpdateStatus {
    this.status = { ...status };
    this.actions.publish(this.getStatus());
    return this.getStatus();
  }

  check(): Promise<DesktopUpdateStatus> {
    if (!this.actions.supported || this.downloaded || this.downloading) return Promise.resolve(this.getStatus());
    if (this.checking) return this.checking;
    this.available = undefined;
    this.publish({ state: 'checking', currentVersion: this.actions.currentVersion });
    this.checking = this.runCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async runCheck(): Promise<DesktopUpdateStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        Promise.resolve().then(() => this.actions.check()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Update check timed out'), { code: 'ETIMEDOUT' })), this.actions.checkTimeoutMs ?? 30_000);
        }),
      ]);
      if (status.state === 'available' && status.version) this.available = { ...status };
      return this.publish(status);
    } catch (error) {
      return this.publish(updateFailureStatus(error, this.actions.currentVersion, 'check'));
    } finally {
      clearTimeout(timer);
    }
  }

  download(): Promise<DesktopUpdateStatus> {
    if (!this.actions.supported || this.downloaded || this.checking) return Promise.resolve(this.getStatus());
    if (this.downloading) return this.downloading;
    if (!this.available?.version) return Promise.resolve(this.publish({
      state: 'error', currentVersion: this.actions.currentVersion, operation: 'check', message: '请先检查是否有可用更新。',
    }));
    const available = { ...this.available };
    this.publish({ ...available, state: 'downloading', percent: 0 });
    this.downloading = Promise.resolve().then(() => this.actions.download()).then(() => {
      this.downloaded = true;
      return this.publish({ ...available, state: 'downloaded' });
    }, error => this.publish({
      ...available, ...updateFailureStatus(error, this.actions.currentVersion, 'download'),
    })).finally(() => { this.downloading = undefined; });
    return this.downloading;
  }

  onProgress(percent: number): void {
    if (this.status.state !== 'downloading' || !Number.isFinite(percent)) return;
    this.publish({ ...this.status, percent: Math.max(this.status.percent ?? 0, Math.min(100, Math.max(0, percent))) });
  }

  install(): DesktopUpdateStatus {
    if (!this.actions.supported || !this.downloaded || this.installing) return this.getStatus();
    this.installing = true;
    try {
      this.actions.install();
    } catch (error) {
      this.onError(error);
    }
    return this.getStatus();
  }

  onError(error: unknown): void {
    // Check/download rejections are handled by their own promises. Installation
    // may emit an asynchronous error, after quitAndInstall has already returned.
    if (!this.installing) return;
    this.installing = false;
    this.publish({ ...this.status, ...updateFailureStatus(error, this.actions.currentVersion, 'install') });
  }
}
