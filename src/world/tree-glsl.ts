// Shader pieces shared by the drawn and the photographed trees.
export const CROWN_ATTR = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aLife;
attribute vec3 aMeta;
uniform float uCover;
uniform float uLodDist;
float treeHidden(float gy) {
  if (uYear < aLife.x || uYear >= aLife.y) return 1.0;
  if (aMeta.z > 0.5 && hash11(aMeta.y * 713.1) > uCover) return 1.0;
  if (gy < uSeaLevel + 0.4) return 1.0;
  return 0.0;
}
float treeGrow() { return 0.3 + 0.7 * smoothstep(aLife.x, aLife.x + 30.0, uYear); }
vec4 blobOf(float kind, float i, float seed) {
  vec3 j = vec3(hash11(seed * 31.0 + i) - 0.5, hash11(seed * 57.0 + i) - 0.5, hash11(seed * 91.0 + i) - 0.5) * 0.12;
  if (kind > 0.5 && kind < 1.5) {
    if (i < 0.5) return vec4(vec3(0.0, 0.36, 0.0) + j * 0.3, 0.25);
    if (i < 1.5) return vec4(vec3(0.0, 0.58, 0.0) + j * 0.3, 0.19);
    return vec4(vec3(0.0, 0.8, 0.0) + j * 0.3, 0.12);
  }
  if (kind > 2.5) {
    if (i < 0.5) return vec4(vec3(-0.25, 0.32, 0.0) + j, 0.4);
    if (i < 1.5) return vec4(vec3(0.25, 0.36, 0.05) + j, 0.42);
    return vec4(vec3(0.0, 0.5, -0.05) + j, 0.34);
  }
  if (kind > 1.5) {
    if (i < 0.5) return vec4(vec3(0.0, 0.58, 0.0) + j, 0.36);
    if (i < 1.5) return vec4(vec3(0.24, 0.64, 0.06) + j, 0.25);
    return vec4(vec3(-0.22, 0.66, -0.07) + j, 0.26);
  }
  if (i < 0.5) return vec4(vec3(0.0, 0.62, 0.0) + j, 0.31);
  if (i < 1.5) return vec4(vec3(0.17, 0.74, 0.1) + j, 0.24);
  return vec4(vec3(-0.15, 0.8, -0.08) + j, 0.23);
}
`;

export const CROWN_COLOR = /* glsl */ `
vec3 crownColor(float kind, float seed) {
  float s = uSeason;
  if (kind > 0.5 && kind < 1.5) return vec3(0.11, 0.16, 0.11) * (0.85 + 0.3 * seed);
  vec3 spring = vec3(0.3, 0.38, 0.17);
  vec3 summer = vec3(0.15, 0.22, 0.1);
  vec3 autumn = mix(vec3(0.46, 0.3, 0.15), vec3(0.5, 0.42, 0.2), seed);
  vec3 winter = vec3(0.27, 0.23, 0.19);
  vec3 c = winter;
  c = mix(c, spring, smoothstep(0.2, 0.32, s));
  c = mix(c, summer, smoothstep(0.42, 0.56, s));
  c = mix(c, autumn, smoothstep(0.68, 0.8, s));
  c = mix(c, winter, smoothstep(0.86, 0.95, s));
  c = mix(vec3(0.21, 0.28, 0.13), c, uSeasonality);
  c = mix(c, vec3(0.32, 0.28, 0.17), uArid * 0.6);
  return c * (0.85 + 0.3 * seed);
}
float bareness(float kind) {
  if (kind > 0.5 && kind < 1.5) return 0.0;
  float w = smoothstep(0.86, 0.95, uSeason) + 1.0 - smoothstep(0.14, 0.26, uSeason);
  return clamp(w, 0.0, 1.0) * uSeasonality;
}
`;

