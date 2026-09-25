// One wind for grass, smoke and the audio, so what moves and what is heard agree.
import { clamp } from '../util/rand';

export class Wind {
  value = 0.3;
  angle = 0.6;
  private target = 0.3;
  private timer = 0;
  private rate = 0.4;

  update(dt: number, base: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      const lull = Math.random() < 0.18;
      this.target = lull ? 0.02 : clamp(base * (0.3 + Math.random() * 1.1), 0.05, 1);
      this.timer = lull ? 4 + Math.random() * 9 : 1.5 + Math.random() * 6;
      this.rate = 0.25 + Math.random() * 0.9;
    }
    this.value += (this.target - this.value) * (1 - Math.exp(-dt * this.rate));
    this.angle += (Math.random() - 0.5) * dt * 0.05;
  }
}
