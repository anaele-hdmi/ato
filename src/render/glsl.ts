// GLSL shared by world materials. Everything is lit by one sun plus a sky/ground
// hemisphere: painted blocks, never glossy metal.

export const COMMON = /* glsl */ `
uniform float uTime;
uniform float uYear;
uniform float uL;
uniform float uSeason;
uniform float uSeasonality;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uMist;
uniform float uNight;
uniform float uLightPollution;
uniform float uExposure;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec3 uCamTarget;
uniform float uCamDist;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowTexel;
uniform float uShadowOn;
uniform float uShadowFade;
uniform float uArid;
uniform float uGravel;
uniform float uPaved;
uniform float uAvenue;
uniform float uFields;
uniform float uUrbanNear;
uniform float uRoadDecay;
uniform float uDecay;
uniform float uWild;
uniform float uForest;
uniform float uGlacial;
uniform float uChaos;
uniform float uIntro;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += vnoise(p) * a;
    p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.07;
    a *= 0.5;
  }
  return s / 0.875;
}
float win(float v, float a0, float a1, float b0, float b1) {
  return smoothstep(a0, a1, v) * (1.0 - smoothstep(b0, b1, v));
}

float sampleShadow(vec3 wp, vec3 n) {
  if (uShadowOn < 0.5) return 1.0;
  float ndl = dot(n, uSunDir);
  vec4 sc = uShadowMatrix * vec4(wp + n * 0.06 * (1.0 + uCamDist * 0.004), 1.0);
  vec3 c = sc.xyz / sc.w;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float bias = 0.0006 + 0.0015 * (1.0 - clamp(ndl, 0.0, 1.0));
  vec2 t = c.xy / uShadowTexel - 0.5;
  vec2 f = fract(t);
  vec2 b = (floor(t) + 0.5) * uShadowTexel;
  float s00 = step(c.z - bias, texture2D(uShadowMap, b).r);
  float s10 = step(c.z - bias, texture2D(uShadowMap, b + vec2(uShadowTexel, 0.0)).r);
  float s01 = step(c.z - bias, texture2D(uShadowMap, b + vec2(0.0, uShadowTexel)).r);
  float s11 = step(c.z - bias, texture2D(uShadowMap, b + vec2(uShadowTexel)).r);
  float s = mix(1.0, mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y), uShadowFade);
  // Fade out at the edge of the shadow frustum instead of cutting.
  vec2 e = smoothstep(0.0, 0.06, c.xy) * smoothstep(1.0, 0.94, c.xy);
  return mix(1.0, s, e.x * e.y);
}

vec3 shade(vec3 albedo, vec3 n, vec3 wp, float wrap, float shadow) {
  float ndl = dot(n, uSunDir);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  float sunUp = smoothstep(-0.05, 0.08, uSunDir.y);
  vec3 direct = uSunColor * diff * shadow * sunUp;
  vec3 amb = mix(uGroundAmb, uSkyAmb, n.y * 0.5 + 0.5);
  return albedo * (direct + amb);
}

// Optical depth of an exponential height layer between the eye and a point.
float heightFogDepth(vec3 wp, float base, float scale, float dens) {
  vec3 ro = cameraPosition;
  float t = length(wp - ro);
  float ry = (wp.y - ro.y) / max(t, 1e-3);
  float b = 1.0 / scale;
  float h0 = ro.y - base, h1 = wp.y - base;
  if (abs(ry) < 1e-3) return dens * exp(-b * h0) * t;
  return dens * scale * (exp(-b * h0) - exp(-b * h1)) / ry;
}

vec3 applyFog(vec3 c, vec3 wp) {
  float d = length(wp - cameraPosition);
  float od = heightFogDepth(wp, 0.0, 1400.0, uFogDensity);
  // morning mist lies in the low ground, in banks rather than an even sheet
  float bank = 0.35 + 1.3 * smoothstep(0.35, 0.75, vnoise(wp.xz * 0.0022 + uTime * 0.003));
  od += heightFogDepth(wp, 14.0, 9.0, uMist * 0.02 * bank);
  // distant air in layers: a few veils that step back one behind another
  od += uFogDensity * 0.9 * max(d - 250.0, 0.0) * smoothstep(0.3, 0.7, vnoise(vec2(d * 0.0016, 3.1)));
  float f = 1.0 - exp(-od);
  f = max(f, uIntro * smoothstep(0.0, 18.0, d));
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}

vec3 tonemap(vec3 x) {
  x *= uExposure;
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// Matte photographic print: colour held back, blacks lifted, shadows a little cool.
// Real places shot like models, never vivid.
vec3 grade(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.86);
  c = mix(c * vec3(0.93, 0.98, 1.05), c, smoothstep(0.0, 0.5, l));
  return c * 0.97 + vec3(0.01, 0.012, 0.014);
}
vec4 finalOut(vec3 c) {
  return vec4(pow(grade(tonemap(c)), vec3(1.0 / 2.2)), 1.0);
}

// Seasonal grass colour; seasonality pulls toward late spring while scrubbing.
vec3 grassColor(float var) {
  float s = uSeason;
  vec3 spring = vec3(0.18, 0.27, 0.13);
  vec3 summer = vec3(0.13, 0.2, 0.1);
  vec3 autumn = vec3(0.33, 0.28, 0.15);
  vec3 winter = vec3(0.27, 0.25, 0.19);
  vec3 c = winter;
  c = mix(c, spring, smoothstep(0.17, 0.30, s));
  c = mix(c, summer, smoothstep(0.42, 0.55, s));
  c = mix(c, autumn, smoothstep(0.66, 0.78, s));
  c = mix(c, winter, smoothstep(0.86, 0.97, s));
  c = mix(vec3(0.16, 0.24, 0.12), c, uSeasonality);
  // the dry age: ochre and dust
  c = mix(c, vec3(0.36, 0.3, 0.18), uArid * 0.85);
  // dry, yellower patches against lush, bluer ones
  c = mix(c * vec3(0.85, 0.95, 1.1), c * vec3(1.25, 1.1, 0.8), var);
  return c;
}
float snowCover() {
  float w = win(uSeason, -0.1, 0.0, 0.08, 0.14) + smoothstep(0.96, 1.0, uSeason);
  // not every winter brings snow
  float snowy = step(0.55, hash11(floor(uYear + 0.2) * 1.37));
  return clamp(w * uSeasonality * 0.85 * snowy + uGlacial, 0.0, 1.0);
}
`;

export const TERRAIN_FN = /* glsl */ `
uniform sampler2D uHeightNear;
uniform sampler2D uHeightFar;
uniform float uNearExt;
uniform float uFarExt;
uniform float uDisp;
uniform float uSeaLevel;

vec4 terrainRaw(vec2 xz) {
  vec4 far = texture2D(uHeightFar, xz / (2.0 * uFarExt) + 0.5);
  vec2 a = abs(xz);
  float m = max(a.x, a.y);
  if (m > uNearExt) return far;
  vec4 near = texture2D(uHeightNear, xz / (2.0 * uNearExt) + 0.5);
  return mix(near, far, smoothstep(uNearExt * 0.85, uNearExt * 0.98, m));
}
float heightOf(vec4 s) {
  return s.x + uDisp * (s.w * 28.0 - (s.x - 18.0) * 0.35);
}
float terrainHeight(vec2 xz) {
  return heightOf(terrainRaw(xz));
}
vec3 terrainNormal(vec4 s) {
  vec2 g = s.yz * (1.0 - uDisp * 0.35);
  return normalize(vec3(g.x, sqrt(max(1.0 - dot(s.yz, s.yz), 0.05)), g.y));
}
`;

export const ROADS_FN = /* glsl */ `
uniform sampler2D uRoads;
uniform float uRoadExt;
// r: distance to main road, g: distance to lanes, b: lane birth (norm), a: urban year (norm)
vec4 roadRaw(vec2 xz) {
  vec2 uv = xz / (2.0 * uRoadExt) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    // beyond the baked area the city front is the smooth part of urbanYear()
    vec2 dc = xz - vec2(-900.0, -640.0);
    float a = atan(dc.y, dc.x) - 0.6181442259351873;
    float lobe = 1.0 + 0.2 * sin(3.0 * a) + 0.13 * sin(5.0 * a) + 0.08 * sin(8.0 * a);
    float uy = 1936.0 + length(dc) * lobe / 19.5;
    return vec4(999.0, 999.0, 9.0, (uy - 1900.0) / 400.0);
  }
  return texture2D(uRoads, uv);
}
float yearN(float n) { return 1900.0 + n * 400.0; }
`;
