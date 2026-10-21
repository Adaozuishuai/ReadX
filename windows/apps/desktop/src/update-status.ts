import type { DesktopUpdateStatus } from '@cbct/shared';

export type UpdateOperation = 'check' | 'download' | 'install';

// A release may exist for Windows while macOS has no update feed yet.
// Missing release metadata must never be reported as "already up to date".
export function updateFailureStatus(
  error: unknown,
  currentVersion: string,
  operation: UpdateOperation,
  platform: NodeJS.Platform = process.platform,
): DesktopUpdateStatus {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  if (operation === 'check' && code === 'ENOENT' && /app-update\.yml/i.test(detail)) {
    return {
      state: 'unavailable', currentVersion,
      message: '此安装包缺少更新配置，请安装包含更新配置的完整安装包后重试。',
    };
  }
  if (operation === 'check' && [
    'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  ].includes(code)) {
    const platformName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '当前平台';
    return {
      state: 'unavailable', currentVersion,
      message: `更新源尚未提供 ${platformName} 更新清单，暂时无法检查更新。请等待发布者提供对应安装包后重试。`,
    };
  }

  const action = operation === 'download' ? '下载更新' : operation === 'install' ? '安装更新' : '检查更新';
  const networkError = /ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT)|ENOTFOUND|ECONN|ETIMEDOUT|TimeoutError|AbortError|timed?\s*out/i.test(`${code} ${detail}`);
  return {
    state: 'error', currentVersion, operation,
    message: networkError
      ? `${action}时无法连接更新服务器，请检查网络连接后重试。`
      : `${action}失败，请稍后重试。若持续失败，请联系发布者检查更新资源。`,
  };
}
