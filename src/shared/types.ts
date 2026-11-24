export type PlayerSlot = 1 | 2;

export type ZoneId =
  | 'foyer'
  | 'tea_south'
  | 'tea_north'
  | 'study'
  | 'courtyard'
  | 'conservatory'
  | 'workshop'
  | 'skygarden'
  | 'observatory';

export type FloorMaterial = 'wood' | 'stone' | 'glass' | 'metal' | 'grass';

export type ItemId =
  // One-and-done keys (consumed immediately when unlocking their matching lock)
  | 'key_study'
  | 'key_conservatory'
  | 'key_skylift'
  // Reusable tools (stay forever)
  | 'tool_uv_lamp'
  | 'tool_prism'
  // Puzzle parts / Cores (placed into mechanisms)
  | 'item_gear_18t'
  | 'core_sun'
  | 'core_gear'
  | 'core_star'
  | 'core_wind';

export type ItemCategory = 'key' | 'tool' | 'part' | 'core';

export interface ItemDef {
  id: ItemId;
  name: string;
  shortName: string;
  category: ItemCategory;
  icon: string;
  description: string;
  consumable: boolean; // true for one-and-done keys & placed cores/parts; false for reusable tools
}

export type DoorId =
  | 'courtyard_door'
  | 'tea_north_grille'
  | 'study_door'
  | 'conservatory_door'
  | 'workshop_door'
  | 'skylift_door'
  | 'solstice_gate';

export type PuzzleId =
  | 'p1_foyer_clock'
  | 'p1_twin_levers'
  | 'p2_tea_cipher'
  | 'p3_tea_balance'
  | 'p4_uv_safe'
  | 'p5_pipe_organ'
  | 'p6_sundial'
  | 'p7_light_relay'
  | 'p8_irrigation'
  | 'p9_gear_train'
  | 'p10_foundry_sync'
  | 'p11_orrery'
  | 'p12_wind_harp'
  | 'p13_solstice_gate';

export type CipherSymbol =
  | 'sun'
  | 'leaf'
  | 'gear'
  | 'moon'
  | 'bell'
  | 'drop'
  | 'star'
  | 'key'
  | 'feather';

export type CardinalDir = 'N' | 'E' | 'S' | 'W';
export type HarpColor = 'amber' | 'emerald' | 'azure' | 'violet';

export interface PlayerTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  moving: boolean;
  zone: ZoneId;
  uvOn: boolean;
  heldItem: ItemId | null;
}

export interface PlayerInfo {
  id: string;
  slot: PlayerSlot;
  name: string;
  connected: boolean;
  transform: PlayerTransform;
  color: string;
}

export interface CoopPing {
  id: string;
  playerSlot: PlayerSlot;
  playerName: string;
  x: number;
  y: number;
  z: number;
  createdAt: number;
}

export interface HintEntry {
  id: string;
  puzzleId: PuzzleId;
  puzzleTitle: string;
  tier: 1 | 2 | 3;
  text: string;
  unlockedAt: number;
}

export interface ClueRecord {
  id: string;
  title: string;
  zone: string;
  body: string;
  discoveredAt: number;
}

export interface MinigameSpark {
  id: number;
  angle: number; // radians 0..2PI
  radius: number; // 1.0 (outer edge) down to 0.0 (center)
  speed: number;
  kind: 'gold' | 'silver' | 'cog' | 'sync';
  layer: 'inner' | 'outer';
}

export interface MinigameState {
  phase: 'idle' | 'lobby' | 'playing' | 'fate_draw' | 'result';
  readyPlayers: PlayerSlot[];
  targetPuzzleId: PuzzleId | null;
  startedAt: number;
  endsAt: number;
  durationMs: number;
  score: number;
  targetScore: number;
  integrity: number; // 0..100
  p1Angle: number; // inner ring radians
  p2Angle: number; // outer ring radians
  p1PulseAt: number;
  p2PulseAt: number;
  sparks: MinigameSpark[];
  syncTargetAngle: number | null;
  syncCompleted: number;
  // Fate Draw (exact 2/3 luck-based chance after beating the coop minigame!)
  casketVotes: Partial<Record<PlayerSlot, 0 | 1 | 2>>;
  winningCaskets: number[]; // length 2 out of [0,1,2] — kept hidden on client until reveal!
  chosenCasket: number | null;
  wonClue: boolean | null;
  awardedHint: HintEntry | null;
  resultMessage: string;
}

export interface WorldPuzzleStates {
  // P1: Foyer clock [0..9]x4 + Twin Levers
  clockDigits: [number, number, number, number];
  foyerLeverLeftAt: number;
  foyerLeverLeftBy: PlayerSlot | null;
  foyerLeverRightAt: number;
  foyerLeverRightBy: PlayerSlot | null;

  // P2: Tea Parlor Split-Booth Cipher
  teaCipherDials: [CipherSymbol, CipherSymbol, CipherSymbol, CipherSymbol];
  foyerPlatePressedBy: PlayerSlot[];

  // P3: Tea Balance Apothecary
  teaWeights: { amber: number; jade: number; rose: number; mint: number };

  // P4: UV Safe
  uvRevealedFrames: number[]; // indices 0..3 discovered under UV
  studySafeDigits: [number, number, number, number];

  // P5: Harmonic Pipe Organ (lengths 1..5 in slots 0..4)
  organPipes: [number, number, number, number, number];

  // P6: Courtyard Sundial
  sundial: { hour: number; azimuth: number; day: number };

  // P7: Courtyard Light-Beam Relay
  prismInserted: boolean;
  mirrorAngles: [number, number, number]; // 0..7 (45 deg steps)
  mirror2ClutchHeldBy: PlayerSlot[];
  mirror2Latched: boolean;

  // P8: Conservatory Dual-Bank Irrigation (each valve 0..4)
  valvesA: [number, number, number];
  valvesB: [number, number, number];

  // P9: Clockwork Gear-Train (null or '16'|'18'|'24'|'36')
  gearSlots: [string | null, string | null, string | null];

  // P10: Foundry Synchronized Levers (3 stages)
  foundryStage: number; // 0..3
  foundryLeverNorthAt: number;
  foundryLeverNorthBy: PlayerSlot | null;
  foundryLeverSouthAt: number;
  foundryLeverSouthBy: PlayerSlot | null;

  // P11: Planetary Orrery (positions 1..8)
  orrery: { sun: number; mars: number; moon: number; sea: number };

  // P12: Sky-Deck Wind-Harp & Terrace Relay
  windHarpStep: number; // 0..4
  terracePadOccupied: Record<HarpColor, PlayerSlot[]>;

  // P13: Grand Solstice Gate Finale
  gateCoresInserted: { sun: boolean; gear: boolean; star: boolean; wind: boolean };
  gateDials: { sun: CardinalDir; gear: CardinalDir; star: CardinalDir; wind: CardinalDir };
  finalePadLeftBy: PlayerSlot[];
  finalePadRightBy: PlayerSlot[];
}

export interface WorldState {
  roomCode: string;
  startedAt: number;
  completedAt: number | null;
  players: Record<string, PlayerInfo>;
  doors: Record<DoorId, boolean>; // true = open
  solvedPuzzles: Record<PuzzleId, boolean>;
  // Shared team inventory (items available to the team; keys are deleted upon use!)
  inventory: ItemId[];
  // Items already picked up from world pedestals (so they disappear in 3D)
  collectedWorldItems: ItemId[];
  // Consumed one-and-done keys log
  consumedKeys: ItemId[];
  puzzles: WorldPuzzleStates;
  discoveredClues: ClueRecord[];
  unlockedHints: HintEntry[];
  sharedNotes: string;
  // Hint Minigame & 10-minute cooldown (starts unlocked at 0!)
  hintCooldownEndsAt: number; // epoch ms; 0 means unlocked/ready
  hintAttemptsCount: number;
  hintWinsCount: number;
  minigame: MinigameState;
  pings: CoopPing[];
}

// Client -> Server WebSocket Messages
export type ClientMessage =
  | { type: 'create_room'; playerName: string }
  | { type: 'join_room'; roomCode: string; playerName: string; playerId?: string }
  | { type: 'player_move'; transform: PlayerTransform }
  | { type: 'interact'; targetId: string; payload?: Record<string, unknown> }
  | { type: 'pickup_item'; itemId: ItemId }
  | { type: 'unlock_door'; doorId: DoorId }
  | { type: 'discover_clue'; clueId: string }
  | { type: 'uv_reveal'; frameIndex: number }
  | { type: 'update_notes'; text: string }
  | { type: 'coop_ping'; x: number; y: number; z: number }
  | { type: 'minigame_ready'; targetPuzzleId?: PuzzleId }
  | { type: 'minigame_cancel' }
  | { type: 'minigame_input'; angle: number; pulse?: boolean }
  | { type: 'minigame_pick_casket'; casketIndex: 0 | 1 | 2 }
  | { type: 'request_sync' };

// Server -> Client WebSocket Messages
export type ServerMessage =
  | {
      type: 'room_joined';
      roomCode: string;
      playerId: string;
      playerSlot: PlayerSlot;
      state: WorldState;
    }
  | { type: 'state_sync'; state: WorldState }
  | { type: 'player_moved'; playerId: string; transform: PlayerTransform }
  | { type: 'minigame_tick'; minigame: MinigameState; serverTime: number }
  | {
      type: 'world_event';
      event:
        | 'puzzle_solved'
        | 'door_opened'
        | 'key_consumed'
        | 'item_picked'
        | 'coop_prompt'
        | 'coop_ping'
        | 'sfx'
        | 'error'
        | 'info'
        | 'victory';
      message: string;
      sfx?: string;
      data?: Record<string, unknown>;
    }
  | { type: 'error'; message: string };
