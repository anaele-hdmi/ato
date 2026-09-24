// Assembles everything people build around the house and keeps draw counts to
// what already exists at the current year.
import * as THREE from 'three';
import type { SunShadow } from '../render/shadow';
import { bornBy, buildBlocks } from './blocks';
import { buildCottages, cottageMaterials } from './cottage';
import { type Settlement, buildSettlement } from './settlement';
import { StreetDots } from './street-dots';
import { Utilities } from './utilities';

export class Town {
  readonly group = new THREE.Group();
  readonly utilities: Utilities;
  private cottages: THREE.InstancedMesh;
  private blocks: THREE.InstancedMesh;
  private blockBirths: number[];
  private cottageBirths: number[];
  private dots: StreetDots;
  readonly data: Settlement;

  constructor(ground: (x: number, z: number) => number, shadow: SunShadow) {
    const s = buildSettlement(ground);
    this.data = s;
    const cm = cottageMaterials();
    this.cottages = buildCottages(s.cottages, cm);
    this.cottageBirths = this.cottages.userData.births as number[];
    shadow.add(this.cottages, cm.depth);
    const b = buildBlocks(s.boxes);
    this.blocks = b.mesh;
    this.blockBirths = b.births;
    shadow.add(this.blocks, b.depth);
    this.utilities = new Utilities(s.poles, shadow);
    this.dots = new StreetDots(s.streets);
    this.group.add(this.cottages, this.blocks, this.utilities.group, this.dots.points);
  }

  update(year: number, dots: number, projScale: number): void {
    this.cottages.count = bornBy(this.cottageBirths, year);
    this.blocks.count = bornBy(this.blockBirths, year);
    this.cottages.visible = this.cottages.count > 0;
    this.blocks.visible = this.blocks.count > 0;
    this.dots.update(dots, projScale);
  }
}
