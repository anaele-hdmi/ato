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
  c += uSunColor * (pow(sd, 12.0) * 0.12 + pow(sd, 900.0) * 3.0) * smoothstep(-0.03, 0.02, uSunDir.y);
  // thin high cloud, drifting
  if (e > 0.0) {
    vec2 uv = d.xz / (e + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float cl = fbm3(uv) * 0.7 + fbm3(uv * 3.1 + 7.0) * 0.3;
    float cov = smoothstep(0.62 - uCloud * 0.35, 0.95, cl) * smoothstep(0.0, 0.18, e);
    vec3 cc = mix(uHorizon * 1.05, uSunColor * 0.35 + uZenith * 0.5, 0.5) + uSunColor * 0.12 * sd;
    c = mix(c, cc, cov * 0.75);
    // stars, fewer where the ground glows
    vec3 sp = floor(d * 380.0);
    float st = step(0.9975, hash12(sp.xy + sp.z * 7.1));
    c += vec3(0.8, 0.85, 1.0) * st * uStars * smoothstep(0.05, 0.3, e) * (1.0 - cov);
  }
  // ground glow of the city on the horizon at night
  c += vec3(0.5, 0.3, 0.14) * uLightPollution * uNight * exp(-max(e, 0.0) * 7.0) * 0.5;
  c = mix(c, uFogColor, smoothstep(0.02, -0.06, e));
  c = mix(c, uFogColor, uIntro);
  gl_FragColor = finalOut(c);
}
`;

export class Atmosphere {
  readonly sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  readonly sunDir = new THREE.Vector3();
  sunAlt = 0;
  night = 0;

  constructor() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uCloud: { value: 0.3 },
        uStars: { value: 0 },
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

  update(env: Env, mist: number): void {
    // sun position from the season and the hour
    const decNeutral = 0.2;
    const dec = lerp(decNeutral, 0.409 * Math.sin((env.season - 0.22) * Math.PI * 2), env.seasonality);
    const H = (env.day - 0.5) * Math.PI * 2;
    const x = -Math.cos(dec) * Math.sin(H);
    const y = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H);
    const north = Math.cos(LAT) * Math.sin(dec) - Math.sin(LAT) * Math.cos(dec) * Math.cos(H);
    this.sunDir.set(x, y, -north).normalize();
    this.sunAlt = this.sunDir.y;
    const day = smoothstep(-0.12, 0.12, this.sunAlt);
    const night = 1 - smoothstep(-0.14, 0.02, this.sunAlt);
    this.night = night;
    const low = 1 - smoothstep(0.02, 0.4, this.sunAlt);
    const turb = env.turbidity;
    const lp = env.lightPollution;
    const g = env.glacial;

    const zenith = new THREE.Color(0.16, 0.36, 0.78)
      .lerp(new THREE.Color(0.46, 0.55, 0.64), turb * 0.8)
      .lerp(new THREE.Color(0.55, 0.62, 0.72), g * 0.5);
    const horizon = new THREE.Color(0.66, 0.76, 0.86)
      .lerp(new THREE.Color(0.8, 0.76, 0.68), turb * 0.8)
      .lerp(new THREE.Color(0.95, 0.66, 0.42), low * 0.7 * day);
    const nz = new THREE.Color(0.01, 0.016, 0.034).lerp(new THREE.Color(0.06, 0.05, 0.05), lp * 0.8);
    const nh = new THREE.Color(0.028, 0.035, 0.055).lerp(new THREE.Color(0.2, 0.13, 0.08), lp);
    zenith.lerp(nz, night);
    horizon.lerp(nh, night);
    // chaos: the air goes brown and flat before anything else changes
    zenith.lerp(new THREE.Color(0.42, 0.38, 0.34).multiplyScalar(0.08 + 0.92 * day), env.chaos * 0.6);
    horizon.lerp(new THREE.Color(0.5, 0.43, 0.36).multiplyScalar(0.1 + 0.9 * day), env.chaos * 0.6);

    const sunCol = new THREE.Color(1.0, 0.94, 0.84)
      .lerp(new THREE.Color(1.0, 0.56, 0.26), low)
      .multiplyScalar(lerp(1.75, 1.1, turb) * day);

    const skyAmb = zenith.clone().lerp(horizon, 0.45).multiplyScalar(lerp(0.62, 0.7, turb));
    skyAmb.add(new THREE.Color(0.02, 0.03, 0.05).multiplyScalar(night));
    skyAmb.add(new THREE.Color(0.12, 0.08, 0.05).multiplyScalar(lp * night));
    const groundAmb = new THREE.Color(0.3, 0.28, 0.2).multiplyScalar(day * 0.55).add(new THREE.Color(0.02, 0.022, 0.03));

    const fog = horizon.clone().lerp(zenith, 0.15);

    const s = shared;
    s.uSunDir.value.copy(this.sunDir);
    s.uSunColor.value.copy(sunCol);
    s.uSkyAmb.value.copy(skyAmb);
    s.uGroundAmb.value.copy(groundAmb);
    s.uFogColor.value.copy(fog);
    s.uFogDensity.value = 0.00016 + turb * 0.0004 + env.smoke * 0.00015;
    s.uMist.value = mist;
    s.uNight.value = night;
    s.uLightPollution.value = lp;
    s.uExposure.value = lerp(0.68, 1.5, night);

    const u = this.skyMat.uniforms;
    (u.uZenith.value as THREE.Color).copy(zenith);
    (u.uHorizon.value as THREE.Color).copy(horizon);
    u.uCloud.value = clamp(0.25 + 0.4 * env.stems.rain + 0.3 * env.glacial + 0.3 * turb, 0, 1);
    u.uStars.value = night * (1 - lp) * (1 - env.smoke);
  }
}
