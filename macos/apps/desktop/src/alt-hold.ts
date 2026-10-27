/** Only a sustained, unmodified Alt press opens the wheel. Alt+Tab/shortcuts cancel it. */
export class AltHold {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  private visible = false;
  constructor(private callbacks: { show(): void; release(): void; cancel(): void }, private delay = 260) {}

  press(blocked = false): void {
    if (this.held) return;
    this.held = true;
    if (blocked) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.visible = true;
      this.callbacks.show();
    }, this.delay);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const visible = this.visible;
    this.visible = false;
    if (visible) this.callbacks.cancel();
  }

  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    const visible = this.visible;
    this.visible = false;
    if (visible) this.callbacks.release();
  }

  dispose(): void { this.cancel(); this.held = false; }
}
