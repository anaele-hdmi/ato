// The only words ever shown. They come once the end has been held for a while,
// fade to almost nothing, and vanish the moment time is pulled back.

// The brief names the end title 「定点」 while also asking for 「跡」 as the only
// on-screen text; change this one constant if the latter is meant.
export const END_TITLE = '定点';

const HOLD_SECONDS = 4.5;

export class EndTitle {
  private el: HTMLDivElement;
  private held = 0;
  private shown = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'end-title';
    this.el.textContent = END_TITLE;
    parent.appendChild(this.el);
  }

  update(dt: number, terminal: number, dark: boolean): void {
    if (terminal < 0.98) {
      this.held = 0;
      this.shown = 0;
      this.el.style.transition = 'none';
      this.el.style.opacity = '0';
      return;
    }
    this.held += dt;
    if (this.held < HOLD_SECONDS) return;
    this.shown += dt;
    // up slowly, then settle to a trace of itself
    const t = this.shown;
    const o = Math.min(1, t / 3.5) * (t < 9 ? 0.85 : Math.max(0.18, 0.85 - (t - 9) * 0.08));
    this.el.style.transition = '';
    this.el.style.opacity = o.toFixed(3);
    this.el.style.color = dark ? 'rgba(20,20,22,0.9)' : 'rgba(250,248,244,0.95)';
  }
}
