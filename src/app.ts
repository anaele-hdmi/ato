// Wires time, world, camera, post and audio together. Owns the frame loop only.
import * as THREE from 'three';
import { AudioEngine, type AudioFrame } from './audio/audio-engine';
import { BLOCK_DAMAGE } from './world/blocks';
import { Collider } from './camera/collider';
import { TouchCamera } from './camera/touch-camera';
import { DofPipeline } from './post/dof';
import { PerfGovernor } from './render/perf';
import { loadPhotoTextures } from './render/photo-tex';
import { SunShadow } from './render/shadow';
import { shared } from './render/shared';
import { Clock } from './time/clock';
import { type Env, evaluateEnv, win, yearToU } from './time/time-model';
import { Cliff } from './world/cliff';
import { EndSequence } from './ui/end-sequence';
import { CLIFF_AZ, CLIFF_FLOOR, CLIFF_R, cliffCarve } from './world/cliff-shape';
import { EndTitle } from './ui/end-title';
import { KNOB_FRAC, Scrubber } from './ui/scrubber';
import { clamp, lerp, smoothstep } from './util/rand';
import { Atmosphere } from './world/atmosphere';
import { Figures } from './world/figures';
import { Grass } from './world/grass';
import { Heightfield } from './world/heightfield';
import { HOUSE_BIRTH, HOUSE_DEATH, House } from './world/house';
import { Crowd } from './world/crowd';
import { Smoke } from './world/smoke';
import { Terrain } from './world/terrain';
import { Town } from './world/town';
import { Vegetation } from './world/vegetation';
import { Water } from './world/water';
import { Weather } from './world/weather';
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
  private crowd: Crowd;
  private smoke = new Smoke();
  private water = new Water();
  private endTitle: EndTitle;
  private endSeq: EndSequence;
  private cliff = new Cliff();
  private cliffAmount = 0;
  private seaLevel = -1e4;
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
  private weather = new Weather();
  private weatherFixed: number | null = null;
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

    // the eye knows where the sea has cut the hill away, and stays out of the water
    this.cam = new TouchCamera(canvas, (x, z) =>
      Math.max(this.hf.height(x, z, this.disp) - cliffCarve(x, z) * this.cliffAmount * CLIFF_FLOOR, this.seaLevel + 0.4));
    this.veg = new Vegetation(this.shadow);
    this.house = new House(this.shadow);
    this.figures = new Figures((x, z) => this.hf.height(x, z, this.disp), this.shadow);
    this.town = new Town((x, z) => this.hf.height(x, z, 0), this.shadow);
    this.crowd = new Crowd(this.shadow);
    this.scene.add(this.atmos.sky, this.terrain.mesh, this.grass.mesh, this.veg.group, this.house.group, this.figures.group, this.town.group, this.crowd.group, this.smoke.points, this.water.mesh, this.cliff.mesh);
    const collider = new Collider(this.town.data.boxes, [
      ...this.town.data.cottages,
      { x: 0, y: this.house.position.y, z: 0, rot: 0, scale: 1, birth: HOUSE_BIRTH, death: HOUSE_DEATH, color: new THREE.Color(), seed: 0 },
    ], this.veg.trees.filter((t) => t.death < 1e9).map((t) => ({ ...t, y: this.hf.height(t.x, t.z) })));
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
    this.endSeq = new EndSequence(stage);

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
    this.clock.settle();
    if (q.has('reach')) this.clock.reach = Math.max(this.clock.u, yearToU(parseFloat(q.get('reach') as string)));
    if (q.has('d')) this.cam.logDist = Math.log(parseFloat(q.get('d') as string));
    (this.cam as unknown as { logTarget: number }).logTarget = this.cam.logDist;
    if (q.has('az')) this.cam.azimuth = parseFloat(q.get('az') as string);
    if (q.has('el')) this.cam.elevation = parseFloat(q.get('el') as string);
    if (q.has('tx')) this.cam.target.x = parseFloat(q.get('tx') as string);
    if (q.has('tz')) this.cam.target.z = parseFloat(q.get('tz') as string);
    if (q.has('day')) this.clock.day = parseFloat(q.get('day') as string);
    if (q.has('speed')) this.clock.speed = parseInt(q.get('speed') as string, 10);
    if (q.has('nointro')) this.intro = 0;
    if (q.has('overcast')) this.weatherFixed = parseFloat(q.get('overcast') as string);
    // photographic materials are the default look; ?nophoto shows the bare procedural world
    if (!q.has('nophoto')) {
      void loadPhotoTextures(this.renderer).catch(() => undefined);
      void this.veg.photo.load().catch(() => undefined);
    }
    if (q.has('phototex')) {
      const load = (f: string) => {
        const t = new THREE.TextureLoader().load(`./textures-test/${f}`);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        return t;
      };
      shared.uTexGrass.value = load('grass.png');
      shared.uTexGravel.value = load('gravel.png');
      shared.uPhoto.value = 1;
    }
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

    const eo = this.endSeq.out;
    if (eo.steer > 0) {
      const tx = Math.sin(CLIFF_AZ) * (CLIFF_R + 2), tz = Math.cos(CLIFF_AZ) * (CLIFF_R + 2);
      this.cam.steer(tx, tz, CLIFF_AZ, 0.04, 22, eo.steer * (1 - Math.exp(-dt * 0.8)));
    }
    this.cam.update(dt);
    const camera = this.cam.camera;
    const dist = this.cam.dist;
    const alt = this.cam.altitude;

    this.wind.update(dt, 0.45 + 0.25 * env.stems.wind + 0.3 * env.glacial);
    this.weather.update(dt, c.exposure);
    this.atmos.overcast = this.weatherFixed ?? this.weather.cloud;
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
    // The sea arrives over the site and stays; at the very end it breathes as a
    // slow tide, the hill surfacing and going under.
    const originH = this.hf.height(0, 0, env.terrainDisp);
    const transgress = smoothstep(6.9, 8.25, env.L);
    // left alone at the end, the tide goes out and stays out, baring the cut face
    const tide = env.terminal * 3.2 * lerp(Math.sin((this.elapsed / 46) * Math.PI * 2), -1.6, eo.ebb);
    const seaLevel = lerp(env.seaLevel, originH + 1.2 + tide, transgress);
    s.uSeaLevel.value = seaLevel;
    this.seaLevel = seaLevel;
    this.cliffAmount = env.terminal;
    s.uCliff.value = env.terminal;
    // the face is laid from the ruler's own pixels: the strip sits centred in its canvas
    this.cliff.update(env.terminal, originH, this.ui.canvas, env.terminal > 0.001, 0.5, KNOB_FRAC);
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
    s.uArid.value = env.arid;
    s.uChaos.value = env.chaos;
    s.uIntro.value = smoothstep(0, 1, this.intro);

    this.atmos.update(env, mist, c.exposure);
    // the air clears over the face while the end plays out, so its bands can be read
    s.uFogDensity.value *= 1 - 0.75 * eo.steer;
    s.uMist.value *= 1 - eo.steer;
    this.grass.update(camera.position, this.cam.target, dist);
    const projScale = (this.renderer.getDrawingBufferSize(this.tmpV2).y / 2) / Math.tan((camera.fov * Math.PI) / 360);
    this.veg.update(env.year, env.year < 2330 + 3000 ? 1 : env.forest * (1 - env.glacial), projScale);
    this.house.update(env.year, c.season, c.seasonality, c.day);
    this.figures.update(dt, env.year, env.people);
    this.town.update(env.year, env.dots, projScale);
    this.smoke.update(env.year, projScale);
    // streets fill as the city matures and empty through the bad years
    this.crowd.update(win(env.year, 1985, 2040, 2298, 2330) * (1 - 0.5 * env.chaos), this.cam.target);
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
      memory: smoothstep(0.02, 0.75, c.reach - c.u),
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

    this.ui.update(c.season, c.seasonality, 1 - eo.hideHud, env.year, c.exposure);
    this.endSeq.update(dt, env.terminal, this.cam.idle, c.scrubbing, camera, originH,
      this.ui.canvas, this.ui.track, KNOB_FRAC);
    // it always lands over the dark cut rock, so it is always pale
    this.endTitle.update(dt, eo.title, false);

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
