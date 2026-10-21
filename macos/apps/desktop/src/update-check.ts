import type { DesktopUpdateStatus } from '@cbct/shared';
import type { UpdateInfo } from 'electron-updater';
import { updateFailureStatus } from './update-status';

// Keep this read-only fallback aligned with build.publish in both desktop packages.
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/Leechion/ReadX/releases/latest';

type CheckResult = { isUpdateAvailable: boolean; updateInfo: UpdateInfo } | null;

export async function checkForUpdateStatus(
  currentVersion: string,
  check: () => Promise<CheckResult>,
  readLatestRelease: () => Promise<unknown>,
  platform: NodeJS.Platform = process.platform,
): Promise<DesktopUpdateStatus> {
  try {
    const result = await check();
    if (!result || typeof result.isUpdateAvailable !== 'boolean' || typeof result.updateInfo?.version !== 'string' || !result.updateInfo.version.trim()) {
      throw new Error('Updater returned no valid check result');
    }
    return {
      state: result.isUpdateAvailable ? 'available' : 'current', currentVersion,
      version: result.updateInfo.version,
      releaseNotes: releaseNotesText(result.updateInfo.releaseNotes),
    };
  } catch (error) {
    const status = updateFailureStatus(error, currentVersion, 'check', platform);
    if (status.state !== 'unavailable') return status;
    // A published version and an installable platform update are separate facts.
    // Release metadata may identify the version, but never enables download/install.
    try {
      const release = await readLatestRelease();
      if (!release || typeof release !== 'object') return status;
      const { tag_name: tag, draft, prerelease, body } = release as Record<string, unknown>;
      if (draft === true || prerelease === true || typeof tag !== 'string') return status;
      const version = tag.replace(/^v/, '');
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version)) return status;
      return { ...status, version, releaseNotes: typeof body === 'string' ? body : undefined };
    } catch (releaseError) {
      const failure = updateFailureStatus(releaseError, currentVersion, 'check', platform);
      return { ...status, message: `${status.message} 另未能获取最新发布版本。${failure.message}` };
    }
  }
}

export function releaseNotesText(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined;
  if (!Array.isArray(notes)) return undefined;
  return notes.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.note !== 'string') return '';
    const note = entry.note.trim();
    return note ? (typeof entry.version === 'string' ? `v${entry.version}\n${note}` : note) : '';
  })
    .filter(Boolean).join('\n\n') || undefined;
}
