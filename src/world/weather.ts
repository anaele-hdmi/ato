// Cloud cover. The piece lives mostly under low grey sky; clear spells come and go
// slowly and never last. In long exposure the weather averages to its usual grey.
import { clamp } from '../util/rand';

export class Weather {
  cloud = 0.8;
  private target = 0.8;
  private timer = 20;

  update(dt: number, exposure: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      const clearing = Math.random() < 0.25;
      this.target = clearing ? 0.35 + Math.random() * 0.2 : 0.7 + Math.random() * 0.3;
      this.timer = clearing ? 25 + Math.random() * 30 : 60 + Math.random() * 90;
    }
    const want = exposure > 0.5 ? 0.75 : this.target;
    this.cloud += (want - this.cloud) * (1 - Math.exp(-dt / 20));
    this.cloud = clamp(this.cloud, 0, 1);
  }
}
