import { DoorId, FloorMaterial, HarpColor, ZoneId } from './types.js';

export interface BoxCollider {
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  doorId?: DoorId; // if present, collider is disabled when doors[doorId] === true
}

export interface ZoneDefinition {
  id: ZoneId;
  name: string;
  subtitle: string;
  outdoor: boolean;
  material: FloorMaterial;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface FloorPlateZone {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  harpColor?: HarpColor;
}

// ============================================================
// SEAMLESS 3D ESTATE COORDINATE SYSTEM (in meters)
// Ground Level: Y = 0
// Observatory Sky-Deck: Y = 4.6 (connected via wide walkable ramp at X: 8.5..11.5, Z: -13.5..-22.5)
// ============================================================

export const PLAYER_SPAWNS = {
  1: { x: -2.4, y: 0, z: 14.5, yaw: 0 }, // facing North (-Z) into the Foyer & Lectern
  2: { x: 2.4, y: 0, z: 14.5, yaw: 0 },
};

export const ZONES: ZoneDefinition[] = [
  {
    id: 'observatory',
    name: 'Starlight Observatory Deck',
    subtitle: 'Upper Sky-Deck • Planetary Orrery & Wind-Harp',
    outdoor: true,
    material: 'metal',
    minX: -10,
    maxX: 10,
    minY: 3.4,
    maxY: 12,
    minZ: -21,
    maxZ: -12,
  },
  {
    id: 'foyer',
    name: 'Grand Foyer',
    subtitle: "Indoor • Master Vance's Entry Parlor",
    outdoor: false,
    material: 'wood',
    minX: -8,
    maxX: 8,
    minY: -1,
    maxY: 5,
    minZ: 6,
    maxZ: 18,
  },
  {
    id: 'tea_south',
    name: 'Tea Parlor — South Booth',
    subtitle: 'Indoor • Cipher Console & Apothecary Table',
    outdoor: false,
    material: 'wood',
    minX: 8,
    maxX: 20,
    minY: -1,
    maxY: 5,
    minZ: 11,
    maxZ: 18,
  },
  {
    id: 'tea_north',
    name: 'Tea Parlor — North Booth',
    subtitle: 'Indoor • Botanical Mural Observation Booth',
    outdoor: false,
    material: 'wood',
    minX: 8,
    maxX: 20,
    minY: -1,
    maxY: 5,
    minZ: 5,
    maxZ: 11,
  },
  {
    id: 'study',
    name: "Alchemist's Study",
    subtitle: 'Indoor • UV Gallery & Harmonic Organ',
    outdoor: false,
    material: 'wood',
    minX: -20,
    maxX: -8,
    minY: -1,
    maxY: 5,
    minZ: 5,
    maxZ: 18,
  },
  {
    id: 'courtyard',
    name: 'Sunlit Fountain Courtyard',
    subtitle: 'Outdoor • Central Garden & Solar Relay',
    outdoor: true,
    material: 'stone',
    minX: -12,
    maxX: 12,
    minY: -1,
    maxY: 3.5,
    minZ: -14,
    maxZ: 6,
  },
  {
    id: 'conservatory',
    name: 'Botanical Conservatory',
    subtitle: 'Glasshouse • Koi Pond & Glass Lotus',
    outdoor: false,
    material: 'glass',
    minX: -26,
    maxX: -12,
    minY: -1,
    maxY: 7,
    minZ: -14,
    maxZ: 2,
  },
  {
    id: 'workshop',
    name: 'Clockwork Workshop',
    subtitle: 'Indoor • Gear Foundry & Bellows Forge',
    outdoor: false,
    material: 'metal',
    minX: 12,
    maxX: 26,
    minY: -1,
    maxY: 6,
    minZ: -14,
    maxZ: 2,
  },
  {
    id: 'skygarden',
    name: 'Sky-Garden Terrace',
    subtitle: 'Outdoor • Grand Solstice Gate Amphitheater',
    outdoor: true,
    material: 'grass',
    minX: -13,
    maxX: 13,
    minY: -1,
    maxY: 3.4,
    minZ: -30,
    maxZ: -14,
  },
];

export function detectZone(x: number, y: number, z: number): ZoneDefinition {
  for (const zone of ZONES) {
    if (
      x >= zone.minX &&
      x <= zone.maxX &&
      y >= zone.minY &&
      y <= zone.maxY &&
      z >= zone.minZ &&
      z <= zone.maxZ
    ) {
      return zone;
    }
  }
  return ZONES[5]; // fallback courtyard
}

// Pressure plates & floor resonance stones checked authoritatively by the server!
export const FLOOR_PLATES: Record<string, FloorPlateZone> = {
  foyer_booth_plate: { id: 'foyer_booth_plate', x: 5.5, y: 0, z: 14.5, radius: 1.15 },
  courtyard_sun_pad: { id: 'courtyard_sun_pad', x: 3.2, y: 0, z: 1.8, radius: 1.2 },
  terrace_azure: { id: 'terrace_azure', x: -5.4, y: 0, z: -20.5, radius: 1.25, harpColor: 'azure' },
  terrace_amber: { id: 'terrace_amber', x: -1.8, y: 0, z: -20.5, radius: 1.25, harpColor: 'amber' },
  terrace_violet: {
    id: 'terrace_violet',
    x: 1.8,
    y: 0,
    z: -20.5,
    radius: 1.25,
    harpColor: 'violet',
  },
  terrace_emerald: {
    id: 'terrace_emerald',
    x: 5.4,
    y: 0,
    z: -20.5,
    radius: 1.25,
    harpColor: 'emerald',
  },
  finale_pad_left: { id: 'finale_pad_left', x: -3.2, y: 0, z: -24.8, radius: 1.25 },
  finale_pad_right: { id: 'finale_pad_right', x: 3.2, y: 0, z: -24.8, radius: 1.25 },
};

// Walkable ramp geometry connecting Courtyard (X: 8.8..11.9, Z: -10.5, Y: 0)
// up to a wide 2.7m top landing on the Observatory Sky-Deck (Z: -20.5..-17.8, Y: 4.6)
export const SKYLIFT_RAMP = {
  minX: 8.8,
  maxX: 11.9,
  zStart: -10.5, // Y = 0
  zEnd: -17.8, // Y = 4.6 (leaves Z: -20.5..-17.8 as a full flat 3.1m x 2.7m top landing!)
  topY: 4.6,
};

export const OBSERVATORY_DECK = {
  minX: -9.8,
  maxX: 11.9,
  minZ: -20.5,
  maxZ: -13.2,
  y: 4.6,
};

// Compute ground/deck height Y for a player at (x, currentY, z)
export function computeFloorHeight(x: number, currentY: number, z: number): number {
  // On the ramp going up/down to Observatory
  if (
    x >= SKYLIFT_RAMP.minX &&
    x <= SKYLIFT_RAMP.maxX &&
    z <= SKYLIFT_RAMP.zStart &&
    z >= SKYLIFT_RAMP.zEnd
  ) {
    const t = (SKYLIFT_RAMP.zStart - z) / (SKYLIFT_RAMP.zStart - SKYLIFT_RAMP.zEnd);
    const rampY = Math.max(0, Math.min(SKYLIFT_RAMP.topY, t * SKYLIFT_RAMP.topY));
    if (Math.abs(rampY - currentY) < 1.35 || currentY > 2.2) {
      return rampY;
    }
  }

  // On top of the Observatory Sky-Deck (only if player is already elevated near deck height!)
  if (
    currentY >= 3.2 &&
    x >= OBSERVATORY_DECK.minX &&
    x <= OBSERVATORY_DECK.maxX &&
    z >= OBSERVATORY_DECK.minZ &&
    z <= OBSERVATORY_DECK.maxZ
  ) {
    return OBSERVATORY_DECK.y;
  }

  return 0;
}

// ============================================================
// STATIC + DOOR AABB COLLIDERS (matches 3D wall geometry 1:1!)
// Wall thickness = 0.5m
// ============================================================
const T = 0.35; // half-thickness of walls

export const WORLD_COLLIDERS: BoxCollider[] = [
  // --- GRAND FOYER (X: -8..8, Z: 6..18) ---
  // South wall (solid)
  { id: 'foyer_s', minX: -8.3, maxX: 8.3, minY: 0, maxY: 4.8, minZ: 18 - T, maxZ: 18 + T },
  // North wall (doorway X: -2..2 at Z=6 -> courtyard_door)
  { id: 'foyer_n_l', minX: -8.3, maxX: -2.0, minY: 0, maxY: 4.8, minZ: 6 - T, maxZ: 6 + T },
  { id: 'foyer_n_r', minX: 2.0, maxX: 8.3, minY: 0, maxY: 4.8, minZ: 6 - T, maxZ: 6 + T },
  {
    id: 'door_courtyard',
    minX: -2.0,
    maxX: 2.0,
    minY: 0,
    maxY: 4.0,
    minZ: 6 - T,
    maxZ: 6 + T,
    doorId: 'courtyard_door',
  },
  // West wall of Foyer / East wall of Study (doorway Z: 10.5..13.5 at X=-8 -> study_door)
  { id: 'foyer_w_n', minX: -8 - T, maxX: -8 + T, minY: 0, maxY: 4.8, minZ: 5, maxZ: 10.5 },
  { id: 'foyer_w_s', minX: -8 - T, maxX: -8 + T, minY: 0, maxY: 4.8, minZ: 13.5, maxZ: 18.3 },
  {
    id: 'door_study',
    minX: -8 - T,
    maxX: -8 + T,
    minY: 0,
    maxY: 3.6,
    minZ: 10.5,
    maxZ: 13.5,
    doorId: 'study_door',
  },
  // East wall of Foyer / West wall of Tea Parlor
  // South doorway (OPEN ALWAYS): Z: 13.5..16.2
  // North grille (tea_north_grille): Z: 7.2..9.8
  { id: 'foyer_e_1', minX: 8 - T, maxX: 8 + T, minY: 0, maxY: 4.8, minZ: 5, maxZ: 7.2 },
  {
    id: 'door_tea_north',
    minX: 8 - T,
    maxX: 8 + T,
    minY: 0,
    maxY: 3.6,
    minZ: 7.2,
    maxZ: 9.8,
    doorId: 'tea_north_grille',
  },
  { id: 'foyer_e_2', minX: 8 - T, maxX: 8 + T, minY: 0, maxY: 4.8, minZ: 9.8, maxZ: 13.5 },
  { id: 'foyer_e_3', minX: 8 - T, maxX: 8 + T, minY: 0, maxY: 4.8, minZ: 16.2, maxZ: 18.3 },

  // --- TEA PARLOR (X: 8..20, Z: 5..18) ---
  { id: 'tea_n', minX: 8, maxX: 20.3, minY: 0, maxY: 4.8, minZ: 5 - T, maxZ: 5 + T },
  { id: 'tea_s', minX: 8, maxX: 20.3, minY: 0, maxY: 4.8, minZ: 18 - T, maxZ: 18 + T },
  { id: 'tea_e', minX: 20 - T, maxX: 20 + T, minY: 0, maxY: 4.8, minZ: 5, maxZ: 18.3 },
  // Glass partition dividing North & South booths at Z=11
  { id: 'tea_glass_wall', minX: 8, maxX: 20, minY: 0, maxY: 4.6, minZ: 11 - 0.2, maxZ: 11 + 0.2 },

  // --- ALCHEMIST'S STUDY (X: -20..-8, Z: 5..18) ---
  { id: 'study_n', minX: -20.3, maxX: -8, minY: 0, maxY: 4.8, minZ: 5 - T, maxZ: 5 + T },
  { id: 'study_s', minX: -20.3, maxX: -8, minY: 0, maxY: 4.8, minZ: 18 - T, maxZ: 18 + T },
  { id: 'study_w', minX: -20 - T, maxX: -20 + T, minY: 0, maxY: 4.8, minZ: 5, maxZ: 18.3 },

  // --- COURTYARD PERIMETER (X: -12..12, Z: -14..6) ---
  // Courtyard south wing connectors (-12..-8 and 8..12 at Z=6)
  { id: 'cy_s_w', minX: -12.3, maxX: -8, minY: 0, maxY: 4.8, minZ: 6 - T, maxZ: 6 + T },
  { id: 'cy_s_e', minX: 8, maxX: 12.3, minY: 0, maxY: 4.8, minZ: 6 - T, maxZ: 6 + T },
  // West Courtyard Wall (doorway to Conservatory at Z: -7.5..-4.5 -> conservatory_door)
  { id: 'cy_w_s', minX: -12 - T, maxX: -12 + T, minY: 0, maxY: 5.0, minZ: -4.5, maxZ: 6.3 },
  { id: 'cy_w_n', minX: -12 - T, maxX: -12 + T, minY: 0, maxY: 5.0, minZ: -14.3, maxZ: -7.5 },
  {
    id: 'door_conservatory',
    minX: -12 - T,
    maxX: -12 + T,
    minY: 0,
    maxY: 3.8,
    minZ: -7.5,
    maxZ: -4.5,
    doorId: 'conservatory_door',
  },
  // East Courtyard Wall (doorway to Workshop at Z: -7.5..-4.5 -> workshop_door)
  { id: 'cy_e_s', minX: 12 - T, maxX: 12 + T, minY: 0, maxY: 5.0, minZ: -4.5, maxZ: 6.3 },
  { id: 'cy_e_n', minX: 12 - T, maxX: 12 + T, minY: 0, maxY: 5.0, minZ: -14.3, maxZ: -7.5 },
  {
    id: 'door_workshop',
    minX: 12 - T,
    maxX: 12 + T,
    minY: 0,
    maxY: 3.8,
    minZ: -7.5,
    maxZ: -4.5,
    doorId: 'workshop_door',
  },
  // Central Fountain Base (X: -2.4..2.4, Z: -6.4..-1.6)
  { id: 'cy_fountain', minX: -2.3, maxX: 2.3, minY: 0, maxY: 2.5, minZ: -6.3, maxZ: -1.7 },

  // Sky-Lift Ramp Gate at bottom of ramp (X: 8.8..11.8, Z: -10.4) -> skylift_door
  {
    id: 'door_skylift',
    minX: 8.7,
    maxX: 11.9,
    minY: 0,
    maxY: 3.2,
    minZ: -10.6,
    maxZ: -10.1,
    doorId: 'skylift_door',
  },
  // Ramp inner wall separating ramp from courtyard ground
  { id: 'ramp_inner_wall', minX: 8.5, maxX: 8.9, minY: 0, maxY: 4.5, minZ: -17.8, maxZ: -10.4 },

  // --- BOTANICAL CONSERVATORY (X: -26..-12, Z: -14..2) ---
  { id: 'cons_n', minX: -26.3, maxX: -12, minY: 0, maxY: 5.5, minZ: -14 - T, maxZ: -14 + T },
  { id: 'cons_s', minX: -26.3, maxX: -12, minY: 0, maxY: 5.5, minZ: 2 - T, maxZ: 2 + T },
  { id: 'cons_w', minX: -26 - T, maxX: -26 + T, minY: 0, maxY: 5.5, minZ: -14, maxZ: 2.3 },
  // Koi pond central basin (players walk around north or south side!)
  { id: 'cons_pond', minX: -22.2, maxX: -15.8, minY: 0, maxY: 1.2, minZ: -7.4, maxZ: -4.6 },

  // --- CLOCKWORK WORKSHOP (X: 12..26, Z: -14..2) ---
  { id: 'ws_n', minX: 12, maxX: 26.3, minY: 0, maxY: 5.5, minZ: -14 - T, maxZ: -14 + T },
  { id: 'ws_s', minX: 12, maxX: 26.3, minY: 0, maxY: 5.5, minZ: 2 - T, maxZ: 2 + T },
  { id: 'ws_e', minX: 26 - T, maxX: 26 + T, minY: 0, maxY: 5.5, minZ: -14, maxZ: 2.3 },

  // --- SKY-GARDEN TERRACE (X: -12..12, Z: -29..-14) ---
  // North Courtyard Arch pillars leaving wide open center (-5..5)
  { id: 'sg_arch_w', minX: -12.3, maxX: -5.2, minY: 0, maxY: 4.5, minZ: -14.3, maxZ: -13.7 },
  { id: 'sg_arch_e', minX: 5.2, maxX: 8.6, minY: 0, maxY: 4.5, minZ: -14.3, maxZ: -13.7 },
  // Sky-Garden low stone balustrades (West, East, North behind Solstice Gate)
  { id: 'sg_w', minX: -12.4, maxX: -11.8, minY: 0, maxY: 3.5, minZ: -29.5, maxZ: -14 },
  { id: 'sg_e', minX: 11.8, maxX: 12.4, minY: 0, maxY: 3.5, minZ: -29.5, maxZ: -14 },
  { id: 'sg_n_l', minX: -12.4, maxX: -3.2, minY: 0, maxY: 4.5, minZ: -28.0, maxZ: -27.2 },
  { id: 'sg_n_r', minX: 3.2, maxX: 12.4, minY: 0, maxY: 4.5, minZ: -28.0, maxZ: -27.2 },
  {
    id: 'door_solstice_gate',
    minX: -3.2,
    maxX: 3.2,
    minY: 0,
    maxY: 5.5,
    minZ: -28.0,
    maxZ: -27.2,
    doorId: 'solstice_gate',
  },

  // --- OBSERVATORY SKY-DECK RAILINGS (Y: 4.6..6.2) ---
  { id: 'obs_rail_w', minX: -10.1, maxX: -9.6, minY: 4.5, maxY: 6.5, minZ: -20.6, maxZ: -13.1 },
  { id: 'obs_rail_n', minX: -10.1, maxX: 12.1, minY: 4.5, maxY: 6.5, minZ: -20.7, maxZ: -20.2 },
  { id: 'obs_rail_s', minX: -10.1, maxX: 8.8, minY: 4.5, maxY: 6.5, minZ: -13.5, maxZ: -13.0 },
  { id: 'obs_rail_ramp_guard', minX: 8.55, maxX: 8.9, minY: 4.5, maxY: 6.5, minZ: -17.8, maxZ: -13.0 },
  { id: 'obs_rail_e', minX: 11.8, maxX: 12.2, minY: 4.5, maxY: 6.5, minZ: -20.6, maxZ: -10.4 },
];

// Slab-method ray-vs-AABB intersection returning entry distance t >= 0, or null if no hit
export function rayIntersectBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: BoxCollider,
): number | null {
  let tmin = 0;
  let tmax = Infinity;

  const axes: [number, number, number, number][] = [
    [ox, dx, box.minX, box.maxX],
    [oy, dy, box.minY, box.maxY],
    [oz, dz, box.minZ, box.maxZ],
  ];

  for (const [o, d, bmin, bmax] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < bmin || o > bmax) return null;
    } else {
      let t1 = (bmin - o) / d;
      let t2 = (bmax - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/**
 * Returns true if any solid wall, closed door, glass partition, or blocking hedge
 * lies strictly between ray origin and `targetDist` (with a small margin for wall-mounted items).
 */
export function isLineOfSightBlocked(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  targetDist: number,
  doors: Record<DoorId, boolean>,
  extraOccluders: BoxCollider[] = [],
  ignoreDoorId?: DoorId,
): boolean {
  const limit = Math.max(0, targetDist - 0.16);
  if (limit <= 0) return false;

  const checkList = (list: BoxCollider[]): boolean => {
    for (const box of list) {
      if (box.doorId) {
        if (doors[box.doorId]) continue; // Open door doesn't block
        if (ignoreDoorId && box.doorId === ignoreDoorId) continue; // Can click the locked door itself
      }
      const t = rayIntersectBox(ox, oy, oz, dx, dy, dz, box);
      if (t !== null && t > 0.02 && t < limit) {
        return true;
      }
    }
    return false;
  };

  return checkList(WORLD_COLLIDERS) || checkList(extraOccluders);
}
