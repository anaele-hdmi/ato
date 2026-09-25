// Drops the pixel ratio when frames run long (thermal throttling), never below 1.25.
export class PerfGovernor {
  dpr: number;
  private acc = 0;
  private n = 0;
  private cooldown = 3;

  constructor(private onChange: (dpr: number) => void) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }

  sample(dt: number): void {
    this.cooldown -= dt;
    this.acc += dt;
    this.n++;
    if (this.acc < 2.5) return;
    const avg = this.acc / this.n;
    this.acc = 0;
    this.n = 0;
    if (this.cooldown > 0) return;
    if (avg > 1 / 36 && this.dpr > 1.25) {
      this.dpr = Math.max(1.25, this.dpr - 0.25);
      this.cooldown = 4;
      this.onChange(this.dpr);
    }
  }
}
