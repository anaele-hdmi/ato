// The sea-cut cliff at the very end: a curved rock face at CLIFF_R whose height bands
// are the ruler's own strata, sampled straight off its canvas. See cliff-shape.ts for
// the shared geometry constants and terrain.ts for the matching sea-floor carve.
import * as THREE from 'three';
import { shared } from '../render/shared';
import { COMMON, TERRAIN_FN } from '../render/glsl';
import { CLIFF_AZ, CLIFF_FLOOR, CLIFF_HALF_ARC, CLIFF_R, CLIFF_STRATA_DEPTH } from './cliff-shape';

const SEGS_ANGLE = 96;
const SEGS_VERT = 24;
// Same angular taper as cliff-shape.ts's cliffCarve(), so the rock face collapses
// into the slope exactly where the terrain carve does, with no seam between them.
const TAPER_IN = CLIFF_HALF_ARC + 0.25;
const TAPER_OUT = CLIFF_HALF_ARC - 0.1;

function buildGeometry(): THREE.BufferGeometry {
  const cols = SEGS_ANGLE + 1;
  const rows = SEGS_VERT + 1;
  const pos: number[] = [];
  const aAngle: number[] = [];
  const aT: number[] = [];
  for (let j = 0; j < rows; j++) {
    const t = j / SEGS_VERT;
    for (let i = 0; i < cols; i++) {
      const aLocal = (i / SEGS_ANGLE - 0.5) * 2 * CLIFF_HALF_ARC;
      const theta = CLIFF_AZ + aLocal;
      pos.push(Math.sin(theta) * CLIFF_R, 0, Math.cos(theta) * CLIFF_R);
      aAngle.push(aLocal);
      aT.push(t);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < SEGS_VERT; j++) {
    for (let i = 0; i < SEGS_ANGLE; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAngle', new THREE.Float32BufferAttribute(aAngle, 1));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
  g.setIndex(idx);
  return g;
}

const vert = /* glsl */ `
${COMMON}
${TERRAIN_FN}
attribute float aAngle;
attribute float aT;
uniform float uCliffOriginH;
varying vec3 vWorld;
varying float vF;
varying float vFace;
varying float vAngle;

float smoothCarve(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  // same taper as the terrain's cliffCarve(): 1 mid-face, 0 where it runs into the slope
  float faceAmt = smoothCarve(${TAPER_IN.toFixed(6)}, ${TAPER_OUT.toFixed(6)}, abs(aAngle));

  // irregular in/out bulge -- overhangs and notches, not a flat wall -- fading out
  // with the face so the taper stays a clean seam against the carved terrain
  float bulge = (fbm3(vec2(aAngle * 6.0, aT * 5.0)) - 0.5) * 0.55
    + (fbm3(vec2(aAngle * 14.0 + 5.0, aT * 11.0 + 2.0)) - 0.5) * 0.25;
  // the carve slope sits just inside CLIFF_R; the face only ever bulges outward of it,
  // so the coarse terrain slope is always behind the rock and never in front of it
  float r = ${CLIFF_R.toFixed(3)} + (0.35 + bulge * 0.8) * faceAmt;
  float theta = ${CLIFF_AZ.toFixed(6)} + aAngle;
  vec2 xz = vec2(sin(theta), cos(theta)) * r;

  float groundY = terrainHeight(xz);
  float baseFloorY = uCliffOriginH - ${CLIFF_FLOOR.toFixed(3)};
  // the skyline is ragged, not a straight cut -- roughen just the top of the face
  float ragged = (fbm3(vec2(aAngle * 9.0 + 3.0, 7.0)) - 0.5) * 0.7 * smoothstep(0.78, 1.0, aT);
  float faceY = mix(baseFloorY, groundY + ragged, aT);
  float y = mix(groundY, faceY, faceAmt);

  vWorld = vec3(xz.x, y, xz.y);
  vF = clamp((y - (uCliffOriginH - ${CLIFF_STRATA_DEPTH.toFixed(3)})) / ${CLIFF_STRATA_DEPTH.toFixed(3)}, 0.0, 1.0);
  vFace = faceAmt;
  vAngle = aAngle;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const frag = /* glsl */ `
${COMMON}
${TERRAIN_FN}
uniform sampler2D uStrata;
uniform float uStripV;
uniform float uKnobFrac;
varying vec3 vWorld;
varying float vF;
varying float vFace;
varying float vAngle;

void main() {
  // the noise-bulged face has no clean analytic normal; read it back off the
  // triangles themselves, then make sure it points out of the hill, not into it
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec2 outDir = vec2(sin(${CLIFF_AZ.toFixed(6)} + vAngle), cos(${CLIFF_AZ.toFixed(6)} + vAngle));
  if (dot(n.xz, outDir) < 0.0) n = -n;

  // fine sedimentary lamination: thin sub-layers, a little wavy along the face
  float lamP = vWorld.y * 9.0 + fbm3(vec2(vAngle * 20.0, vWorld.y * 0.6)) * 3.0;
  float lam = 0.5 + 0.5 * sin(lamP);
  float grain = 0.85 + 0.3 * fbm3(vec2(vAngle * 40.0 + 11.0, vWorld.y * 3.0));
  vec3 rockDark = vec3(0.20, 0.18, 0.15);
  vec3 rockLight = vec3(0.35, 0.31, 0.25);
  vec3 rock = mix(rockDark, rockLight, lam) * grain;

  vec4 strip = texture2D(uStrata, vec2(vF * uKnobFrac, uStripV));
  // the ruler's colours are screen colours; take them to linear and let the rock's
  // own lamination run through them so each band reads as sediment, not paint
  vec3 band = pow(strip.rgb, vec3(2.2)) * 1.7;
  vec3 col = mix(rock, band * (0.9 + 0.2 * lam) * mix(1.0, grain, 0.5), step(0.02, strip.a));
  // bedding planes: a dark seam wherever the ruler changes colour
  float px = 2.5 / 512.0;
  vec4 sa = texture2D(uStrata, vec2(vF * uKnobFrac - px, uStripV));
  vec4 sb = texture2D(uStrata, vec2(vF * uKnobFrac + px, uStripV));
  float seam = clamp(length(sa - sb) * 4.0, 0.0, 1.0);
  col *= 1.0 - 0.7 * seam;
  // below the ruler's span: plain darker bedrock, no bands
  col = mix(rockDark * 0.8 * grain, col, smoothstep(0.0, 0.03, vF));

  // wet darkening and a slight sheen close to the current tide line
  float wetBand = 1.0 - smoothstep(0.0, 0.5, abs(vWorld.y - uSeaLevel));
  col = mix(col, col * 0.55, wetBand * 0.8);

  float sh = sampleShadow(vWorld, n);
  vec3 c = shade(col, n, vWorld, 0.2, sh);
  vec3 v = normalize(cameraPosition - vWorld);
  c += uSunColor * pow(clamp(dot(reflect(-uSunDir, n), v), 0.0, 1.0), 40.0) * wetBand * 0.5;
  // the taper into the slope reads a touch duller, not a hard seam
  c *= mix(0.75, 1.0, vFace);
  gl_FragColor = finalOut(applyFog(c, vWorld));
}
`;

export class Cliff {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.CanvasTexture;

  constructor() {
    const blank = document.createElement('canvas');
    blank.width = blank.height = 1;
    this.tex = this.makeTex(blank);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uCliffOriginH: { value: 0 },
        uStrata: { value: this.tex },
        uStripV: { value: 0.5 },
        uKnobFrac: { value: 0.82 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      // the fragment shader re-derives an outward normal, so either winding is fine
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(buildGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private makeTex(src: HTMLCanvasElement): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(src);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  update(amount: number, originH: number, strata: HTMLCanvasElement | null, strataDirty: boolean, stripV: number, knobFrac: number): void {
    this.mesh.visible = amount > 0.001;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    u.uCliffOriginH.value = originH;
    u.uStripV.value = stripV;
    u.uKnobFrac.value = knobFrac;
    if (strata && strata !== this.tex.image) {
      // WebGL2 texture storage is fixed at first upload, so a new source needs a new texture
      this.tex.dispose();
      this.tex = this.makeTex(strata);
      u.uStrata.value = this.tex;
    } else if (strataDirty) {
      this.tex.needsUpdate = true;
    }
    // fade in by sinking the face into the carved floor rather than blending alpha,
    // so there is never a transparency-sort question against the terrain or water
    this.mesh.position.y = -(1 - amount) * 40;
  }
}
