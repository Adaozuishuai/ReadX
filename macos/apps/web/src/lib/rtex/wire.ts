import type { RtexEvent, Reply, LayoutUpdateEvent } from './protocol';
import type { FontResource, ImageResource } from './fontKey';

export interface RealtimeRuntime {
  version: string;
  ready: boolean;
  installed: boolean;
  canInstall: boolean;
  reason?: string;
}
export type WireFont = Exclude<FontResource, { kind: 'sfnt' }> | { kind: 'sfnt'; dataBase64: string };
export type WireImage = Exclude<ImageResource, { data: Uint8Array }> | { kind: 'bitmap' | 'pdf'; mime: string; dataBase64: string };
export type RealtimeEvent = Exclude<RtexEvent, LayoutUpdateEvent> | (LayoutUpdateEvent & { pdfBase64?: string }) | Reply
  | { event: 'ReadXReady'; sessionId: string }
  | { event: 'ReadXResources'; fonts: [string, WireFont][]; images: [string, WireImage][] }
  | { event: 'ReadXError'; message: string }
  | { event: 'ReadXStopped'; code: number | null };

export function decodeBase64(text: string): Uint8Array {
  const raw = atob(text);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
