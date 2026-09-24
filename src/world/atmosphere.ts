// Sun, sky dome and the shared light/fog uniforms derived from the environment.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON } from '../render/glsl';
import type { Env } from '../time/time-model';
import { clamp, lerp, smoothstep } from '../util/rand';

const LAT = (36 * Math.PI) / 180;

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = p.xyww;
}
`;

const skyFrag = /* glsl */ `
${COMMON}
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCloud;
uniform float uStars;
uniform float uExpo;
uniform vec3 uPole;
uniform vec2 uDeclBand;
uniform vec3 uTrailColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  vec3 c = mix(uHorizon, uZenith, pow(clamp(e, 0.0, 1.0), 0.55));
  // warm band where the sun sits low
  float toward = max(dot(normalize(d.xz + 1e-4), normalize(uSunDir.xz + 1e-4)), 0.0);
  float low = 1.0 - smoothstep(0.0, 0.35, uSunDir.y + 0.05);
  c += vec3(0.55, 0.22, 0.06) * low * pow(toward, 3.0) * exp(-max(e, 0.0) * 6.0) * smoothstep(-0.2, 0.0, uSunDir.y);
  float sd = max(dot(d, uSunDir), 0.0);
  // the air around the sun is brighter and warmer; a wide soft halo, then the disc
  c += uSunColor * (pow(sd, 4.0) * 0.16 + pow(sd, 32.0) * 0.22 + pow(sd, 900.0) * 3.0) * smoothstep(-0.03, 0.02, uSunDir.y) * (1.0 - uExpo);
  // Long exposure: the sun becomes the arc it draws; with years flying, a broad band
  // swept between the solstices.
  float pd = dot(d, uPole);
  float band = smoothstep(uDeclBand.x - 0.07, uDeclBand.x + 0.01, pd) * (1.0 - smoothstep(uDeclBand.y - 0.01, uDeclBand.y + 0.07, pd));
  float bw = max(uDeclBand.y - uDeclBand.x, 0.02);
  c += uTrailColor * band * uExpo * smoothstep(-0.02, 0.12, e) * mix(0.8, 0.25, smoothstep(0.03, 0.6, bw));
  // star trails: circles around the pole, faint through the averaged sky
  float ring = acos(clamp(pd, -1.0, 1.0));
  float trail = step(0.993, hash11(floor(ring * 700.0) * 1.37));
  c += vec3(0.75, 0.8, 0.95) * trail * uExpo * 0.18 * smoothstep(0.05, 0.3, e);
  // thin high cloud, drifting
  if (e > 0.0) {
    // clouds are pulled into streaks when time runs fast
    vec2 uv = d.xz / (e + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    uv.x *= 1.0 - 0.8 * uExpo;
    float cl = fbm3(uv) * 0.7 + fbm3(uv * 3.1 + 7.0) * 0.3;
    float cov = smoothstep(0.62 - uCloud * 0.35, 0.95, cl) * smoothstep(0.0, 0.18, e);
    vec3 cc = mix(uHorizon * 1.05, uSunColor * 0.35 + uZenith * 0.5, 0.5) + uSunColor * 0.12 * sd;
    c = mix(c, cc, cov * 0.75);
    // stars, fewer where the ground glows
    vec3 sp = floor(d * 380.0);
    float st = step(0.9975, hash12(sp.xy + sp.z * 7.1));
    c += vec3(0.8, 0.85, 1.0) * st * uStars * smoothstep(0.05, 0.3, e) * (1.0 - cov) * (1.0 - uExpo);
  }
  // ground glow of the city on the horizon at night
  c += vec3(0.5, 0.3, 0.14) * uLightPollution * uNight * exp(-max(e, 0.0) * 7.0) * 0.5;
  c = mix(c, uFogColor, smoothstep(0.02, -0.06, e));
  c = mix(c, uFogColor, uIntro);
  gl_FragColor = finalOut(c);
}
`;

interface Light {
  sunDir: THREE.Vector3;
  sun: THREE.Color;
  zenith: THREE.Color;
  horizon: THREE.Color;
  skyAmb: THREE.Color;
  groundAmb: THREE.Color;
  night: number;
}

function makeLight(): Light {
  return {
    sunDir: new THREE.Vector3(), sun: new THREE.Color(), zenith: new THREE.Color(), horizon: new THREE.Color(),
    skyAmb: new THREE.Color(), groundAmb: new THREE.Color(), night: 0,
  };
}

const AVG_SAMPLES = 16;
const tmp = new THREE.Color();

function sunDirection(out: THREE.Vector3, dec: number, dayPhase: number): THREE.Vector3 {
  const H = (dayPhase - 0.5) * Math.PI * 2;
  const x = -Math.cos(dec) * Math.sin(H);
  const y = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H);
  const north = Math.cos(LAT) * Math.sin(dec) - Math.sin(LAT) * Math.cos(dec) * Math.cos(H);
  return out.set(x, y, -north).normalize();
}

/** Light of the world at one hour. Writes into `o` without allocating. */
function lightAt(o: Light, env: Env, dec: number, dayPhase: number, oc = 0): Light {
  sunDirection(o.sunDir, dec, dayPhase);
  const alt = o.sunDir.y;
  const day = smoothstep(-0.12, 0.12, alt);
  const night = 1 - smoothstep(-0.14, 0.02, alt);
  const low = 1 - smoothstep(0.02, 0.4, alt);
  const turb = env.turbidity, lp = env.lightPollution, g = env.glacial;
  o.night = night;
  o.zenith.setRGB(0.11, 0.29, 0.74).lerp(tmp.setRGB(0.46, 0.55, 0.64), turb * 0.8).lerp(tmp.setRGB(0.55, 0.62, 0.72), g * 0.5);
  o.horizon.setRGB(0.66, 0.76, 0.86).lerp(tmp.setRGB(0.8, 0.76, 0.68), turb * 0.8).lerp(tmp.setRGB(0.95, 0.66, 0.42), low * 0.7 * day);
  o.zenith.lerp(tmp.setRGB(0.01, 0.016, 0.034).lerp(NIGHT_Z_LP, lp * 0.8), night);
  o.horizon.lerp(tmp.setRGB(0.028, 0.035, 0.055).lerp(NIGHT_H_LP, lp), night);
  // chaos: the air goes brown and flat before anything else changes
  o.zenith.lerp(tmp.setRGB(0.42, 0.38, 0.34).multiplyScalar(0.08 + 0.92 * day), env.chaos * 0.6);
  o.horizon.lerp(tmp.setRGB(0.5, 0.43, 0.36).multiplyScalar(0.1 + 0.9 * day), env.chaos * 0.6);
  // overcast: a pale cream sky over teal-grey cloud, the sun only a brightening in it
  o.zenith.lerp(tmp.setRGB(0.36, 0.44, 0.43).multiplyScalar(0.25 + 0.75 * day), oc);
  o.horizon.lerp(tmp.setRGB(0.86, 0.84, 0.66).multiplyScalar(0.2 + 0.8 * day), oc);
  o.sun.setRGB(1.0, 0.93, 0.8).lerp(tmp.setRGB(1.0, 0.56, 0.26), low).multiplyScalar(lerp(2.15, 1.2, turb) * day * (1 - 0.82 * oc));
  o.skyAmb.copy(o.zenith).lerp(o.horizon, 0.35 + 0.3 * oc).multiplyScalar(lerp(0.5, 0.66, turb) * (1 + 0.25 * oc));
  o.skyAmb.add(tmp.setRGB(0.02, 0.03, 0.05).multiplyScalar(night)).add(tmp.setRGB(0.12, 0.08, 0.05).multiplyScalar(lp * night));
  o.groundAmb.setRGB(0.3, 0.28, 0.2).multiplyScalar(day * 0.55).add(tmp.setRGB(0.02, 0.022, 0.03));
  return o;
}
const NIGHT_Z_LP = new THREE.Color(0.06, 0.05, 0.05);
const NIGHT_H_LP = new THREE.Color(0.2, 0.13, 0.08);

export class Atmosphere {
  readonly sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  readonly sunDir = new THREE.Vector3();
  /** 0 clear .. 1 low cloud and mist; the weather of the moment. */
  overcast = 0;
  sunAlt = 0;
  night = 0;
  private now = makeLight();
  private sample = makeLight();
  private avg = makeLight();
  private fog = new THREE.Color();

  constructor() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uCloud: { value: 0.3 },
        uStars: { value: 0 },
        uExpo: { value: 0 },
        uPole: { value: new THREE.Vector3(0, Math.sin(LAT), -Math.cos(LAT)) },
        uDeclBand: { value: new THREE.Vector2() },
        uTrailColor: { value: new THREE.Color() },
      },
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
  }

  /** `exposure` 0 = the hour as it is; 1 = all hours averaged, as in a long exposure. */
  update(env: Env, mist: number, exposure: number): void {
    const decNeutral = 0.2;
    const dec = lerp(decNeutral, 0.409 * Math.sin((env.season - 0.22) * Math.PI * 2), env.seasonality);
    const L = lightAt(this.now, env, dec, env.day, this.overcast);
    let sunDir = L.sunDir;
    if (exposure > 0.01) {
      // Average the whole day (and, with seasons blurred, the whole year).
      const a = this.avg;
      a.sun.setRGB(0, 0, 0); a.zenith.setRGB(0, 0, 0); a.horizon.setRGB(0, 0, 0);
      a.skyAmb.setRGB(0, 0, 0); a.groundAmb.setRGB(0, 0, 0); a.night = 0;
      const decSpread = (1 - env.seasonality) * 0.409;
      for (let i = 0; i < AVG_SAMPLES; i++) {
        const d = dec + decSpread * Math.sin((i * 2.399) % (Math.PI * 2));
        const sm = lightAt(this.sample, env, d, (i + 0.5) / AVG_SAMPLES, this.overcast);
        a.sun.add(sm.sun); a.zenith.add(sm.zenith); a.horizon.add(sm.horizon);
        a.skyAmb.add(sm.skyAmb); a.groundAmb.add(sm.groundAmb); a.night += sm.night;
      }
      const k = 1 / AVG_SAMPLES;
      for (const c of [a.sun, a.zenith, a.horizon, a.skyAmb, a.groundAmb]) c.multiplyScalar(k);
      a.night *= k;
      // the averaged sun lights from roughly noon, without hard shadows
      sunDirection(a.sunDir, dec, 0.5);
      L.sun.lerp(a.sun.multiplyScalar(1.6), exposure);
      L.zenith.lerp(a.zenith, exposure);
      L.horizon.lerp(a.horizon, exposure);
      L.skyAmb.lerp(a.skyAmb, exposure);
      L.groundAmb.lerp(a.groundAmb, exposure);
      L.night = lerp(L.night, a.night * 0.5, exposure);
      sunDir = this.sample.sunDir.copy(L.sunDir).lerp(a.sunDir, exposure).normalize();
    }
    this.sunDir.copy(sunDir);
    this.sunAlt = this.sunDir.y;
    this.night = L.night;
    const turb = env.turbidity;
    this.fog.copy(L.horizon).lerp(L.zenith, 0.15);

    const s = shared;
    s.uSunDir.value.copy(this.sunDir);
    s.uSunColor.value.copy(L.sun);
    s.uSkyAmb.value.copy(L.skyAmb);
    s.uGroundAmb.value.copy(L.groundAmb);
    s.uFogColor.value.copy(this.fog);
    s.uFogDensity.value = 0.00009 + turb * 0.00032 + env.smoke * 0.00015 + this.overcast * 0.0006;
    s.uMist.value = Math.max(mist, this.overcast * 0.85) * (1 - exposure);
    s.uNight.value = L.night;
    s.uLightPollution.value = env.lightPollution;
    s.uExposure.value = lerp(0.68, 1.5, L.night);
    s.uShadowFade.value = 1 - exposure;

    const u = this.skyMat.uniforms;
    (u.uZenith.value as THREE.Color).copy(L.zenith);
    (u.uHorizon.value as THREE.Color).copy(L.horizon);
    u.uCloud.value = clamp(0.25 + 0.4 * env.stems.rain + 0.3 * env.glacial + 0.3 * turb, 0, 1);
    u.uStars.value = L.night * (1 - env.lightPollution) * (1 - env.smoke);
    u.uExpo.value = exposure;
    const spread = (1 - env.seasonality) * 0.409;
    (u.uDeclBand.value as THREE.Vector2).set(Math.sin(dec - spread) - 0.012, Math.sin(dec + spread) + 0.012);
    (u.uTrailColor.value as THREE.Color).setRGB(1.0, 0.93, 0.82).multiplyScalar(0.55);
  }
}
