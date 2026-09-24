// Wires time, world, camera, post and audio together. Owns the frame loop only.
import * as THREE from 'three';
import { AudioEngine, type AudioFrame } from './audio/audio-engine';
import { BLOCK_DAMAGE } from './world/blocks';
import { Collider } from './camera/collider';
import { TouchCamera } from './camera/touch-camera';
import { DofPipeline } from './post/dof';
import { PerfGovernor } from './render/perf';
import { SunShadow } from './render/shadow';
import { shared } from './render/shared';
import { Clock } from './time/clock';
import { type Env, ORIGIN_GROUND, evaluateEnv, win, yearToU } from './time/time-model';
import { EndTitle } from './ui/end-title';
import { Scrubber } from './ui/scrubber';
import { clamp, lerp, smoothstep } from './util/rand';
import { Atmosphere } from './world/atmosphere';
import { Figures } from './world/figures';
import { Grass } from './world/grass';
import { Heightfield } from './world/heightfield';
import { HOUSE_BIRTH, HOUSE_DEATH, House } from './world/house';
import { Smoke } from './world/smoke';
import { Terrain } from './world/terrain';
import { Town } from './world/town';
import { Vegetation } from './world/vegetation';
import { Water } from './world/water';
import { Wind } from './world/wind';

export class App {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam: TouchCamera;
  private clock = new Clock();
  private hf = new Heightfield();
  private atmos = new Atmosphere();
  private shadow: SunShadow;
  private dof = new DofPipeline();
  private terrain = new Terrain();
  private grass = new Grass();
  private veg: Vegetation;
  private house: House;
  private figures: Figures;
  private town: Town;
  private smoke = new Smoke();
  private water = new Water();
  private endTitle: EndTitle;
  private wind = new Wind();
  private audio = new AudioEngine();
  private ui: Scrubber;
  private perf: PerfGovernor;
  private env!: Env;
  private last = performance.now();
  private elapsed = 0;
  private intro = 1;
  private debugEl: HTMLDivElement | null = null;
  private disp = 0;
  private tmpV2 = new THREE.Vector2();
  private fwd = new THREE.Vector3();
  private poleNear = 0;
  private poleTimer = 0;

  constructor(canvas: HTMLCanvasElement, private stage: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);
    this.perf = new PerfGovernor(() => this.resize());
    this.shadow = new SunShadow(isSmallScreen() ? 1536 : 2048);

    const s = shared;
    s.uHeightNear.value = this.hf.nearTex;
    s.uHeightFar.value = this.hf.farTex;
    s.uRoads.value = this.hf.roadTex;

    this.cam = new TouchCamera(canvas, (x, z) => this.hf.height(x, z, this.disp));
    this.veg = new Vegetation(this.shadow);
    this.house = new House(this.shadow);
    this.figures = new Figures((x, z) => this.hf.height(x, z, this.disp), this.shadow);
    this.town = new Town((x, z) => this.hf.height(x, z, 0), this.shadow);
    this.scene.add(this.atmos.sky, this.terrain.mesh, this.grass.mesh, this.veg.group, this.house.group, this.figures.group, this.town.group, this.smoke.points, this.water.mesh);
    const collider = new Collider(this.town.data.boxes, [
      ...this.town.data.cottages,
      { x: 0, y: this.house.position.y, z: 0, rot: 0, scale: 1, birth: HOUSE_BIRTH, death: HOUSE_DEATH, color: new THREE.Color(), seed: 0 },
    ]);
    this.cam.setClip((a, b) => collider.clip(a.x, a.y, a.z, b.x, b.y, b.z, this.clock.year));

    this.ui = new Scrubber(stage, {
      getU: () => this.clock.u,
      setU: (u) => this.clock.setU(u),
      setScrubbing: (b) => { this.clock.scrubbing = b; },
      cycleSpeed: () => this.clock.cycleSpeed(),
      getSpeed: () => this.clock.speed,
      toggleMute: () => { this.audio.setMuted(!this.audio.isMuted()); return this.audio.isMuted(); },
      isMuted: () => this.audio.isMuted(),
    });

    this.endTitle = new EndTitle(stage);

    // The first touch anywhere opens the sound; later touches keep it alive.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.suspend();
    });
    // iOS still pinch-zooms the page on gesture events unless told not to.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
    }
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.applyDebugParams();
    this.resize();
  }

  private applyDebugParams(): void {
    const q = new URLSearchParams(location.search);
    if (q.has('t')) this.clock.setU(yearToU(parseFloat(q.get('t') as string)));
    if (q.has('u')) this.clock.setU(parseFloat(q.get('u') as string));
    if (q.has('d')) this.cam.logDist = Math.log(parseFloat(q.get('d') as string));
    (this.cam as unknown as { logTarget: number }).logTarget = this.cam.logDist;
    if (q.has('az')) this.cam.azimuth = parseFloat(q.get('az') as string);
    if (q.has('el')) this.cam.elevation = parseFloat(q.get('el') as string);
    if (q.has('tx')) this.cam.target.x = parseFloat(q.get('tx') as string);
    if (q.has('tz')) this.cam.target.z = parseFloat(q.get('tz') as string);
    if (q.has('day')) this.clock.day = parseFloat(q.get('day') as string);
    if (q.has('speed')) this.clock.speed = parseInt(q.get('speed') as string, 10);
    if (q.has('nointro')) this.intro = 0;
    if (q.has('debug')) {
      (window as unknown as { __ato: App }).__ato = this;
      this.debugEl = document.createElement('div');
      this.debugEl.className = 'debug';
      this.stage.appendChild(this.debugEl);
    }
  }

  private resize(): void {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.perf.dpr);
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.dof.setSize(size.x, size.y);
    this.cam.resize(w, h);
    this.ui.layout();
  }

  start(): void {
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
    const veil = document.getElementById('veil');
    requestAnimationFrame(() => veil?.classList.add('gone'));
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.elapsed += dt;
    this.perf.sample(dt);
    this.renderer.info.reset();

    const prevTerminal = this.env?.terminal ?? 0;
    this.clock.update(dt, prevTerminal);
    const c = this.clock;
    const env = evaluateEnv(c.year, c.season, c.seasonality, c.day);
    this.env = env;
    this.disp = env.terrainDisp;

    this.cam.update(dt);
    const camera = this.cam.camera;
    const dist = this.cam.dist;
    const alt = this.cam.altitude;

    this.wind.update(dt, 0.45 + 0.25 * env.stems.wind + 0.3 * env.glacial);
    this.intro = Math.max(0, this.intro - dt / 5.5);

    const spring = win(c.season, 0.12, 0.2, 0.4, 0.5) * c.seasonality + 0.3 * (1 - c.seasonality);
    const morning = Math.exp(-(((c.day - 0.31) / 0.07) ** 2));
    const mist = clamp(morning * spring * (1 - env.urbanNear) * (1 - env.chaos) * 0.9 + env.glacial * 0.4, 0, 1);

    const s = shared;
    s.uTime.value = this.elapsed;
    s.uYear.value = env.year;
    s.uL.value = env.L;
    s.uSeason.value = c.season;
    s.uSeasonality.value = c.seasonality;
    s.uWind.value = this.wind.value;
    s.uWindDir.value.set(Math.cos(this.wind.angle), Math.sin(this.wind.angle));
    s.uCamTarget.value.copy(this.cam.target);
    s.uCamDist.value = dist;
    s.uDisp.value = env.terrainDisp;
    // At the end the sea is there for whoever looks from high enough.
    const endSea = env.terminal * smoothstep(0.52, 0.78, alt);
    const seaLevel = lerp(env.seaLevel, ORIGIN_GROUND + 2.5, endSea);
    s.uSeaLevel.value = seaLevel;
    env.stems.water = clamp(1 - (this.hf.height(this.cam.target.x, this.cam.target.z, env.terrainDisp) - seaLevel) / 25, 0, 1) * 0.9 + 0.15 * alt * smoothstep(3.5, 4.5, env.L);
    s.uGravel.value = env.gravel;
    s.uPaved.value = env.paved;
    s.uAvenue.value = env.avenue;
    s.uFields.value = env.fields;
    s.uUrbanNear.value = env.urbanNear;
    s.uRoadDecay.value = env.roadDecay;
    s.uDecay.value = env.decay;
    s.uWild.value = env.wild;
    s.uForest.value = env.forest;
    s.uGlacial.value = env.glacial;
    s.uChaos.value = env.chaos;
    s.uIntro.value = smoothstep(0, 1, this.intro);

    this.atmos.update(env, mist);
    this.grass.update(camera.position, this.cam.target, dist);
    const projScale = (this.renderer.getDrawingBufferSize(this.tmpV2).y / 2) / Math.tan((camera.fov * Math.PI) / 360);
    this.veg.update(env.year, env.year < 2330 + 3000 ? 1 : env.forest * (1 - env.glacial), projScale);
    this.house.update(env.year, c.season, c.seasonality, c.day);
    this.figures.update(dt, env.year, env.people);
    this.town.update(env.year, env.dots, projScale);
    this.smoke.update(env.year, projScale);
    this.water.update(camera.position);
    BLOCK_DAMAGE.value = smoothstep(2300, 2326, env.year);

    this.shadow.render(this.renderer, this.scene, this.cam.target, dist, this.atmos.sunDir);

    const eye = this.cam.eyeDist;
    const ld = Math.log10(eye);
    this.dof.render(this.renderer, this.scene, camera, {
      focus: eye,
      cocFrac: lerp(0.024, 0.0055, smoothstep(0.1, 3.0, ld)),
      tilt: 0.022 * smoothstep(1.9, 3.5, ld),
      maxFrac: lerp(0.05, 0.026, smoothstep(0.5, 2.5, ld)),
      grain: 0.028,
      ca: 0.55,
      // contrast breaks before anything else does
      contrast: 1 + 0.38 * win(env.year, 2284, 2300, 2330, 2350),
      time: this.elapsed,
    });

    // Sound
    const summer = win(c.season, 0.36, 0.46, 0.7, 0.8) * c.seasonality + 0.35 * (1 - c.seasonality);
    const fwd = camera.getWorldDirection(this.fwd);
    // the nearest pole only matters for a slow hum; a few checks a second is plenty
    this.poleTimer -= dt;
    if (this.poleTimer <= 0) {
      this.poleTimer = 0.3;
      this.poleNear = this.town.utilities.nearness(camera.position, env.year);
    }
    const frameA: AudioFrame = {
      env, altitude: alt, scrubRate: c.scrubRate, night: this.atmos.night, morning, summer,
      wind: this.wind.value, poleNear: this.poleNear,
      listener: { x: camera.position.x, y: camera.position.y, z: camera.position.z, fx: fwd.x, fy: fwd.y, fz: fwd.z },
      house: {
        x: 1.5, y: this.house.position.y + 4, z: -0.9,
        hearth: env.year < 2070 ? (this.house as unknown as { smokeMat: THREE.ShaderMaterial }).smokeMat.uniforms.uAmount.value : 0,
        well: env.year < 2080 ? 1 : 0,
      },
    };
    this.audio.update(frameA);

    const hudFade = 1 - smoothstep(6, 10, this.cam.idle) * env.terminal;
    this.ui.update(c.season, c.seasonality, hudFade);
    const fc = shared.uFogColor.value;
    this.endTitle.update(dt, env.terminal, this.atmos.night < 0.3 && fc.r * 0.3 + fc.g * 0.59 + fc.b * 0.11 > 0.5);

    if (this.debugEl) {
      const info = this.renderer.info.render;
      this.debugEl.textContent = `${(1 / dt).toFixed(0)}fps calls ${info.calls} tris ${(info.triangles / 1000).toFixed(0)}k dpr ${this.perf.dpr}\n` +
        `y ${env.year.toFixed(1)} L ${env.L.toFixed(2)} u ${c.u.toFixed(3)} d ${dist.toFixed(1)} day ${c.day.toFixed(2)} audio ${this.audio.running}`;
    }
  }
}

function isSmallScreen(): boolean {
  return Math.min(window.screen.width, window.screen.height) < 600;
}
