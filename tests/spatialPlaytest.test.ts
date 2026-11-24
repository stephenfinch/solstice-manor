import { describe, it, expect } from 'vitest';
import {
  BoxCollider,
  computeFloorHeight,
  FLOOR_PLATES,
  PLAYER_SPAWNS,
  WORLD_COLLIDERS,
} from '../src/shared/worldLayout.js';
import { DoorId } from '../src/shared/types.js';

// Extract DECOR_COLLIDERS coords mirror check: test full 3D walkability & anti-bypass
// using the exact FirstPersonController collision rules!
const PLAYER_RADIUS = 0.38;

function collidesAt(
  x: number,
  y: number,
  z: number,
  doors: Record<DoorId, boolean>,
  colliders: BoxCollider[],
): boolean {
  const pMinY = y + 0.18;
  const pMaxY = y + 1.75;
  for (const box of colliders) {
    if (box.doorId && doors[box.doorId]) continue;
    if (pMaxY <= box.minY || pMinY >= box.maxY) continue;
    if (
      x + PLAYER_RADIUS > box.minX &&
      x - PLAYER_RADIUS < box.maxX &&
      z + PLAYER_RADIUS > box.minZ &&
      z - PLAYER_RADIUS < box.maxZ
    ) {
      return true;
    }
  }
  return false;
}

// Grid flood-fill with elevation tracking (0.4m step) simulating FirstPersonController movement!
function floodReachable(
  startX: number,
  startY: number,
  startZ: number,
  doors: Record<DoorId, boolean>,
  colliders: BoxCollider[],
): Set<string> {
  const STEP = 0.4;
  const key = (gx: number, gy: number, gz: number) => `${gx},${gy},${gz}`;
  const toGrid = (v: number) => Math.round(v / STEP);

  const visited = new Set<string>();
  const queue: [number, number, number][] = [[startX, startY, startZ]];
  visited.add(key(toGrid(startX), Math.round(startY), toGrid(startZ)));

  const dirs = [
    [STEP, 0],
    [-STEP, 0],
    [0, STEP],
    [0, -STEP],
  ];

  while (queue.length > 0) {
    const [cx, cy, cz] = queue.shift()!;
    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < -27 || nx > 27 || nz < -30 || nz > 19) continue;
      const ny = computeFloorHeight(nx, cy, nz);
      // Reject sheer vertical cliffs (> 0.9m step in 0.4m horizontal)
      if (Math.abs(ny - cy) > 0.9) continue;
      if (collidesAt(nx, ny, nz, doors, colliders)) continue;

      const k = key(toGrid(nx), Math.round(ny), toGrid(nz));
      if (!visited.has(k)) {
        visited.add(k);
        queue.push([nx, ny, nz]);
      }
    }
  }
  return visited;
}

function canReachNear(
  visited: Set<string>,
  tx: number,
  ty: number,
  tz: number,
  maxDist = 1.6,
): boolean {
  const STEP = 0.4;
  for (const k of visited) {
    const [gx, gy, gz] = k.split(',').map(Number);
    const x = gx * STEP;
    const y = gy;
    const z = gz * STEP;
    if (Math.abs(y - ty) <= 1.1 && Math.hypot(x - tx, z - tz) <= maxDist) {
      return true;
    }
  }
  return false;
}

describe('Solstice Manor — 3D Walkability, Ramp Elevation & Anti-Softlock Audit', () => {
  // Include ramp_end blocker matching DECOR_COLLIDERS[0] in worldBuilder.ts
  const rampEndCollider: BoxCollider = {
    id: 'decor_ramp_end',
    minX: 10.35 - 1.55,
    maxX: 10.35 + 1.55,
    minY: 0,
    maxY: 3.9,
    minZ: -19.45 - 0.15,
    maxZ: -19.45 + 0.15,
  };
  const colliders = [...WORLD_COLLIDERS, rampEndCollider];

  const allClosed: Record<DoorId, boolean> = {
    courtyard_door: false,
    tea_north_grille: false,
    study_door: false,
    conservatory_door: false,
    workshop_door: false,
    skylift_door: false,
    solstice_gate: false,
  };

  it('spawns both players cleanly in Grand Foyer facing North with unobstructed access to starter puzzles', () => {
    expect(PLAYER_SPAWNS[1].yaw).toBe(0);
    expect(PLAYER_SPAWNS[2].yaw).toBe(0);
    expect(collidesAt(PLAYER_SPAWNS[1].x, 0, PLAYER_SPAWNS[1].z, allClosed, colliders)).toBe(false);
    expect(collidesAt(PLAYER_SPAWNS[2].x, 0, PLAYER_SPAWNS[2].z, allClosed, colliders)).toBe(false);

    const reached = floodReachable(PLAYER_SPAWNS[1].x, 0, PLAYER_SPAWNS[1].z, allClosed, colliders);
    // Can reach Foyer Floor Plate, Tea Parlor South Booth, Clock, Twin Levers
    expect(canReachNear(reached, FLOOR_PLATES.foyer_booth_plate.x, 0, FLOOR_PLATES.foyer_booth_plate.z, 0.7)).toBe(true);
    expect(canReachNear(reached, 11.4, 0, 12.6, 1.5)).toBe(true); // Tea South Cipher
    expect(canReachNear(reached, 18.2, 0, 14.9, 1.5)).toBe(true); // Tea Balance Scale
    // Cannot leak into locked Courtyard, Study, or Tea North Booth
    expect(canReachNear(reached, 0, 0, -4, 1.5)).toBe(false);
    expect(canReachNear(reached, -14, 0, 12, 1.5)).toBe(false);
    expect(canReachNear(reached, 14, 0, 8, 1.5)).toBe(false);
  });

  it('blocks Observatory Sky-Deck bypass when skylift_door is locked, and allows smooth ramp ascent when unlocked', () => {
    const courtyardOpen: Record<DoorId, boolean> = {
      ...allClosed,
      courtyard_door: true,
    };
    const reachedLocked = floodReachable(0, 0, 0, courtyardOpen, colliders);
    // Sky-Garden Terrace is reachable, but Observatory Deck (Y=4.6) MUST NOT be reachable!
    expect(canReachNear(reachedLocked, 0, 0, -22, 1.5)).toBe(true);
    expect(canReachNear(reachedLocked, 0, 4.6, -16.8, 2.5)).toBe(false);

    // Unlock Sky-Lift Door -> Player can smoothly walk UP the ramp onto the Observatory Deck!
    const liftOpen: Record<DoorId, boolean> = {
      ...courtyardOpen,
      skylift_door: true,
    };
    const reachedUnlocked = floodReachable(0, 0, 0, liftOpen, colliders);
    expect(canReachNear(reachedUnlocked, -1, 4.6, -16.8, 2.0)).toBe(true); // Planetary Orrery
    expect(canReachNear(reachedUnlocked, -4.5, 4.6, -19.2, 1.5)).toBe(true); // Wind-Harp Chimes
    expect(canReachNear(reachedUnlocked, 4.5, 4.6, -19.2, 1.5)).toBe(true); // East Wind-Harp Chime
  });

  it('reaches every floor plate, pond bank, workshop lever, and finale pad once wing doors unlock', () => {
    const allOpen: Record<DoorId, boolean> = {
      courtyard_door: true,
      tea_north_grille: true,
      study_door: true,
      conservatory_door: true,
      workshop_door: true,
      skylift_door: true,
      solstice_gate: false,
    };
    const reached = floodReachable(PLAYER_SPAWNS[1].x, 0, PLAYER_SPAWNS[1].z, allOpen, colliders);

    // Every single floor plate in the game must be directly steppable!
    for (const plate of Object.values(FLOOR_PLATES)) {
      expect(
        canReachNear(reached, plate.x, plate.y, plate.z, 0.7),
        `Floor plate ${plate.id} must be reachable`,
      ).toBe(true);
    }

    // Both Conservatory Valve Banks across the Koi Pond
    expect(canReachNear(reached, -19, 0, -11.5, 1.5)).toBe(true);
    expect(canReachNear(reached, -19, 0, -0.5, 1.5)).toBe(true);

    // Both Workshop Foundry Levers & Gear Workbench
    expect(canReachNear(reached, 23.5, 0, -12.0, 1.5)).toBe(true);
    expect(canReachNear(reached, 23.5, 0, -0.5, 1.5)).toBe(true);
    expect(canReachNear(reached, 17.4, 0, 0.0, 1.5)).toBe(true);

    // Study Safe & Pipe Organ
    expect(canReachNear(reached, -18.2, 0, 7.6, 1.5)).toBe(true);
    expect(canReachNear(reached, -14.0, 0, 15.0, 1.5)).toBe(true);

    // Tea Parlor North Booth Mural
    expect(canReachNear(reached, 16.4, 0, 7.5, 1.5)).toBe(true);
  });
});
