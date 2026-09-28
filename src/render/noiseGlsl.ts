// Shared value-noise GLSL (hash, noise, fbm) used by the ground, clouds and the cloud-map bake.
export const NOISE_GLSL = /* glsl */ `
float cloudHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float cloudNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = cloudHash(i + vec3(0.0, 0.0, 0.0));
  float n100 = cloudHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = cloudHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = cloudHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = cloudHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = cloudHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = cloudHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = cloudHash(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

float cloudFbm4(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 4; i++) {
    sum += cloudNoise(p * freq) * amp;
    freq *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

float cloudFbm2(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 2; i++) {
    sum += cloudNoise(p * freq) * amp;
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

`;
