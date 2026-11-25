import {
  CardinalDir,
  CipherSymbol,
  DoorId,
  HarpColor,
  HatStyle,
  HintMode,
  ItemId,
  PlayerAppearance,
  PlayerInfo,
  PlayerSlot,
  PlayerTransform,
  PuzzleId,
  ServerMessage,
  WorldState,
} from '../shared/types.js';
import {
  computeIrrigationGauges,
  createInitialPuzzleStates,
  DOOR_KEY_REQUIREMENTS,
  isPipeOrganValid,
  ITEMS,
  SOLUTIONS,
  WORLD_CLUES,
} from '../shared/puzzles.js';
import { detectZone, FLOOR_PLATES, PLAYER_SPAWNS } from '../shared/worldLayout.js';
import {
  createIdleMinigameState,
  MinigameRunner,
  sanitizeMinigameForClient,
  selectNextHint,
} from './minigameEngine.js';

const VALID_HATS = new Set<HatStyle>(['tophat', 'beret', 'aviator', 'none']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function defaultAppearance(slot: PlayerSlot): PlayerAppearance {
  return slot === 1
    ? { coatColor: '#2c6e58', hatStyle: 'tophat', goggleColor: '#f5b942' }
    : { coatColor: '#7d3448', hatStyle: 'beret', goggleColor: '#6ec5e9' };
}

function sanitizeAppearance(
  input: Partial<PlayerAppearance> | undefined,
  fallback: PlayerAppearance,
): PlayerAppearance {
  if (!input) return { ...fallback };
  return {
    coatColor:
      typeof input.coatColor === 'string' && HEX_COLOR_RE.test(input.coatColor)
        ? input.coatColor
        : fallback.coatColor,
    hatStyle:
      input.hatStyle && VALID_HATS.has(input.hatStyle) ? input.hatStyle : fallback.hatStyle,
    goggleColor:
      typeof input.goggleColor === 'string' && HEX_COLOR_RE.test(input.goggleColor)
        ? input.goggleColor
        : fallback.goggleColor,
  };
}

export interface BroadcastHooks {
  broadcast: (msg: ServerMessage, excludePlayerId?: string) => void;
  sendTo: (playerId: string, msg: ServerMessage) => void;
}

const SYNC_WINDOW_MS = 2600; // 2.6 seconds for 2-player simultaneous lever pulls!

function createInitialDoors(): Record<DoorId, boolean> {
  return {
    courtyard_door: false,
    tea_north_grille: false,
    study_door: false,
    conservatory_door: false,
    workshop_door: false,
    skylift_door: false,
    solstice_gate: false,
  };
}

function createInitialSolved(): Record<PuzzleId, boolean> {
  return {
    p1_foyer_clock: false,
    p1_twin_levers: false,
    p2_tea_cipher: false,
    p3_tea_balance: false,
    p4_uv_safe: false,
    p5_pipe_organ: false,
    p6_sundial: false,
    p7_light_relay: false,
    p8_irrigation: false,
    p9_gear_train: false,
    p10_foundry_sync: false,
    p11_orrery: false,
    p12_wind_harp: false,
    p13_solstice_gate: false,
  };
}

export class GameRoom {
  public state: WorldState;
  public minigameRunner = new MinigameRunner();
  private hooks: BroadcastHooks;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();
  private debugUnlocked = false;

  constructor(roomCode: string, hooks: BroadcastHooks, hintMode: HintMode = 'oracle') {
    this.hooks = hooks;
    const validHintMode: HintMode =
      hintMode === 'unlimited' || hintMode === 'none' ? hintMode : 'oracle';
    this.state = {
      roomCode,
      hintMode: validHintMode,
      startedAt: Date.now(),
      completedAt: null,
      players: {},
      doors: createInitialDoors(),
      solvedPuzzles: createInitialSolved(),
      inventory: [],
      droppedItems: [],
      collectedWorldItems: [],
      consumedKeys: [],
      props: {
        prop_study_lamp: true,
      },
      puzzles: createInitialPuzzleStates(),
      discoveredClues: [],
      unlockedHints: [],
      sharedNotes: '',
      hintCooldownEndsAt: 0, // Starts UNLOCKED!
      hintAttemptsCount: 0,
      hintWinsCount: 0,
      minigame: createIdleMinigameState(),
      pings: [],
    };
  }

  private syncTeamInventory(): void {
    const union: ItemId[] = [];
    for (const p of Object.values(this.state.players)) {
      for (const item of p.inventory) {
        if (!union.includes(item)) union.push(item);
      }
    }
    this.state.inventory = union;
  }

  private findPartner(playerId: string): PlayerInfo | undefined {
    return Object.values(this.state.players).find((p) => p.id !== playerId && p.connected);
  }

  public startLoop(): void {
    if (this.tickTimer) return;
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.onTick(), 50); // 20 Hz server tick
  }

  public stopLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  public getSanitizedState(): WorldState {
    return {
      ...this.state,
      minigame: sanitizeMinigameForClient(this.state.minigame),
    };
  }

  public syncAll(): void {
    this.hooks.broadcast({ type: 'state_sync', state: this.getSanitizedState() });
  }

  public emitEvent(
    event: Extract<ServerMessage, { type: 'world_event' }>['event'],
    message: string,
    sfx?: string,
    data?: Record<string, unknown>,
  ): void {
    this.hooks.broadcast({ type: 'world_event', event, message, sfx, data });
  }

  public addOrReconnectPlayer(
    playerName: string,
    requestedPlayerId?: string,
    requestedAppearance?: Partial<PlayerAppearance>,
  ): PlayerInfo | null {
    const cleanName = (playerName || 'Apprentice').trim().slice(0, 18) || 'Apprentice';

    // Try reconnect by id
    if (requestedPlayerId && this.state.players[requestedPlayerId]) {
      const existing = this.state.players[requestedPlayerId];
      existing.connected = true;
      existing.name = cleanName;
      if (requestedAppearance) {
        existing.appearance = sanitizeAppearance(requestedAppearance, existing.appearance);
      }
      return existing;
    }

    // Try taking over a disconnected slot
    const disconnected = Object.values(this.state.players).find((p) => !p.connected);
    if (disconnected) {
      disconnected.connected = true;
      disconnected.name = cleanName;
      if (requestedAppearance) {
        disconnected.appearance = sanitizeAppearance(requestedAppearance, disconnected.appearance);
      }
      return disconnected;
    }

    const existingCount = Object.keys(this.state.players).length;
    if (existingCount >= 2) {
      return null; // Room full
    }

    const usedSlots = new Set(Object.values(this.state.players).map((p) => p.slot));
    const slot: PlayerSlot = usedSlots.has(1) ? 2 : 1;
    const spawn = PLAYER_SPAWNS[slot];
    const id = `p_${slot}_${Math.random().toString(36).slice(2, 8)}`;

    const player: PlayerInfo = {
      id,
      slot,
      name: cleanName,
      connected: true,
      color: slot === 1 ? '#f5b942' : '#4ecdc4',
      appearance: sanitizeAppearance(requestedAppearance, defaultAppearance(slot)),
      inventory: [],
      transform: {
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: spawn.yaw,
        pitch: 0,
        moving: false,
        crouching: false,
        zone: 'foyer',
        uvOn: false,
        heldItem: null,
      },
    };
    this.state.players[id] = player;
    return player;
  }

  public handleUpdateAppearance(playerId: string, appearance: Partial<PlayerAppearance>): void {
    const p = this.state.players[playerId];
    if (!p) return;
    p.appearance = sanitizeAppearance(appearance, p.appearance);
    this.syncAll();
  }

  public disconnectPlayer(playerId: string): void {
    const p = this.state.players[playerId];
    if (!p) return;
    p.connected = false;
    // Clear ready status if in minigame lobby
    this.state.minigame.readyPlayers = this.state.minigame.readyPlayers.filter((s) => s !== p.slot);
    this.recomputeFloorPlates();
    this.syncAll();
  }

  public updatePlayerTransform(playerId: string, transform: PlayerTransform): void {
    const p = this.state.players[playerId];
    if (!p) return;
    const zone = detectZone(transform.x, transform.y, transform.z);
    p.transform = {
      ...transform,
      zone: zone.id,
    };
    this.hooks.broadcast({ type: 'player_moved', playerId, transform: p.transform }, playerId);

    const changed = this.recomputeFloorPlates();
    if (changed) {
      this.syncAll();
    }
  }

  // Server-authoritative pressure plates, mirror clutch, terrace stones, and finale pads!
  private recomputeFloorPlates(): boolean {
    const connected = Object.values(this.state.players).filter((p) => p.connected);
    const onPlate = (plateId: string): PlayerSlot[] => {
      const fp = FLOOR_PLATES[plateId];
      if (!fp) return [];
      const slots: PlayerSlot[] = [];
      for (const p of connected) {
        const dx = p.transform.x - fp.x;
        const dz = p.transform.z - fp.z;
        const dy = Math.abs(p.transform.y - fp.y);
        if (dy < 1.2 && dx * dx + dz * dz <= fp.radius * fp.radius) {
          slots.push(p.slot);
        }
      }
      return slots;
    };

    const pz = this.state.puzzles;
    let changed = false;

    const eqArr = (a: PlayerSlot[], b: PlayerSlot[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    // 1. Foyer Brass Plate -> holds Tea Parlor North Grille open (until P2 permanently unlocks it)
    const foyerPlate = onPlate('foyer_booth_plate');
    if (!eqArr(pz.foyerPlatePressedBy, foyerPlate)) {
      const wasEmpty = pz.foyerPlatePressedBy.length === 0;
      pz.foyerPlatePressedBy = foyerPlate;
      changed = true;
      if (!this.state.solvedPuzzles.p2_tea_cipher && !this.debugUnlocked) {
        this.state.doors.tea_north_grille = foyerPlate.length > 0;
        if (wasEmpty && foyerPlate.length > 0) {
          this.emitEvent('sfx', '', 'plate_step');
        }
      }
    }

    // 2. Courtyard Sun-Pad -> holds Mirror 2 clutch in place while aligning the Solar Beam!
    const sunPad = onPlate('courtyard_sun_pad');
    if (!eqArr(pz.mirror2ClutchHeldBy, sunPad)) {
      const wasEmpty = pz.mirror2ClutchHeldBy.length === 0;
      pz.mirror2ClutchHeldBy = sunPad;
      changed = true;
      if (!pz.mirror2Latched) {
        if (wasEmpty && sunPad.length > 0) {
          this.emitEvent('sfx', '', 'plate_step');
          this.checkLightRelaySolved();
        } else if (sunPad.length === 0 && pz.mirrorAngles[1] !== 0) {
          // Spring-loaded Mirror 2 drifts back when pad is released before latching!
          pz.mirrorAngles[1] = 0;
          this.emitEvent('sfx', '', 'dial_click');
        }
      }
    }

    // 3. Sky-Garden Terrace Resonance Floor Stones (P12)
    const colors: HarpColor[] = ['azure', 'amber', 'violet', 'emerald'];
    for (const c of colors) {
      const occ = onPlate(`terrace_${c}`);
      if (!eqArr(pz.terracePadOccupied[c], occ)) {
        pz.terracePadOccupied[c] = occ;
        changed = true;
        if (occ.length > 0) {
          this.emitEvent('sfx', '', 'plate_step');
        }
      }
    }

    // 4. Grand Solstice Gate Twin Finale Pads (P13)
    const leftFin = onPlate('finale_pad_left');
    const rightFin = onPlate('finale_pad_right');
    if (!eqArr(pz.finalePadLeftBy, leftFin) || !eqArr(pz.finalePadRightBy, rightFin)) {
      pz.finalePadLeftBy = leftFin;
      pz.finalePadRightBy = rightFin;
      changed = true;
      if (leftFin.length > 0 || rightFin.length > 0) {
        this.checkFinaleVictory();
      }
    }

    return changed;
  }

  // === PICKUP WORLD OR DROPPED ITEMS (SEPARATE PERSONAL INVENTORIES) ===
  public handlePickup(playerId: string, itemId: ItemId): void {
    const player = this.state.players[playerId];
    if (!player) return;
    if (!ITEMS[itemId]) return;

    const def = ITEMS[itemId];

    // 1. Check if picking up a partner-dropped item in the 3D world
    const dropIdx = this.state.droppedItems.findIndex((d) => d.itemId === itemId);
    if (dropIdx !== -1) {
      this.state.droppedItems.splice(dropIdx, 1);
      if (!player.inventory.includes(itemId)) {
        player.inventory.push(itemId);
      }
      this.syncTeamInventory();
      this.emitEvent('item_picked', `${player.name} picked up ${def.name}.`, 'pickup', {
        itemId,
        playerId,
      });
      this.syncAll();
      return;
    }

    // 2. Otherwise pick up original world spawn item
    if (this.state.collectedWorldItems.includes(itemId)) return;

    // Ensure prerequisite puzzle unlocked this item!
    if (!this.isItemSpawnedInWorld(itemId)) {
      this.hooks.sendTo(playerId, {
        type: 'world_event',
        event: 'error',
        message: 'That item is still sealed inside its mechanism.',
        sfx: 'error',
      });
      return;
    }

    this.state.collectedWorldItems.push(itemId);
    if (!player.inventory.includes(itemId)) {
      player.inventory.push(itemId);
    }
    this.syncTeamInventory();

    this.emitEvent(
      'item_picked',
      `${player.name} picked up ${def.name}${def.consumable && def.category === 'key' ? ' (single-use)' : !def.consumable ? ' (reusable)' : ''}.`,
      'pickup',
      { itemId, playerId },
    );
    this.syncAll();
  }

  // === HAND ITEM TO PARTNER OR DROP INTO 3D WORLD ===
  public handleGiveOrDropItem(
    playerId: string,
    itemId: ItemId,
    mode: 'partner' | 'drop',
    x?: number,
    y?: number,
    z?: number,
  ): void {
    const player = this.state.players[playerId];
    if (!player || !ITEMS[itemId]) return;
    const invIdx = player.inventory.indexOf(itemId);
    if (invIdx === -1) return;

    player.inventory.splice(invIdx, 1);
    if (player.transform.heldItem === itemId) {
      player.transform.heldItem = null;
    }
    if (itemId === 'tool_uv_lamp') {
      player.transform.uvOn = false;
    }

    const def = ITEMS[itemId];

    if (mode === 'partner') {
      const partner = this.findPartner(playerId);
      if (partner) {
        if (!partner.inventory.includes(itemId)) {
          partner.inventory.push(itemId);
        }
        this.syncTeamInventory();
        this.emitEvent(
          'item_picked',
          `${player.name} handed ${def.name} to ${partner.name}.`,
          'pickup',
          { itemId, from: player.slot, to: partner.slot },
        );
        this.syncAll();
        return;
      }
    }

    // Drop into 3D world in front of player (or fallback if partner isn't connected)
    const fx = -Math.sin(player.transform.yaw);
    const fz = -Math.cos(player.transform.yaw);
    const dropX = typeof x === 'number' && Number.isFinite(x) ? x : player.transform.x + fx * 1.1;
    const dropY = typeof y === 'number' && Number.isFinite(y) ? y : player.transform.y;
    const dropZ = typeof z === 'number' && Number.isFinite(z) ? z : player.transform.z + fz * 1.1;

    this.state.droppedItems.push({
      itemId,
      x: Math.round(dropX * 1000) / 1000,
      y: Math.round(dropY * 1000) / 1000,
      z: Math.round(dropZ * 1000) / 1000,
      droppedBy: player.slot,
    });
    this.syncTeamInventory();
    this.emitEvent('info', `${player.name} set down ${def.name}.`, 'dial_click', { itemId });
    this.syncAll();
  }

  // === INTERACTIVE EXPLORATION PROPS (DRAWERS, LAMPS, BELLS, GLOBES, WHISTLES) ===
  public handleToggleProp(playerId: string, propId: string): void {
    const player = this.state.players[playerId];
    if (!player || !propId) return;

    const toggleBool = (): boolean => {
      const next = !Boolean(this.state.props[propId]);
      this.state.props[propId] = next;
      return next;
    };
    const bumpCount = (): number => {
      const next = (Number(this.state.props[propId]) || 0) + 1;
      this.state.props[propId] = next;
      return next;
    };

    switch (propId) {
      case 'prop_foyer_drawer_1': {
        const open = toggleBool();
        this.emitEvent('sfx', '', open ? 'door_open' : 'dial_click');
        break;
      }
      case 'prop_foyer_drawer_2': {
        toggleBool();
        this.emitEvent('sfx', '', 'dial_click');
        break;
      }
      case 'prop_foyer_bell': {
        bumpCount();
        this.emitEvent('info', `${player.name} rang the brass foyer bell.`, 'ping');
        break;
      }
      case 'prop_study_drawer': {
        const open = toggleBool();
        this.emitEvent('sfx', '', open ? 'door_open' : 'dial_click');
        break;
      }
      case 'prop_study_book': {
        const pulled = toggleBool();
        this.emitEvent('sfx', '', pulled ? 'lever_pull' : 'dial_click');
        break;
      }
      case 'prop_study_lamp': {
        toggleBool();
        this.emitEvent('sfx', '', 'dial_click');
        break;
      }
      case 'prop_study_globe': {
        bumpCount();
        this.emitEvent('sfx', '', 'gear_place');
        break;
      }
      case 'prop_fountain_coin': {
        bumpCount();
        this.emitEvent('info', 'A copper coin splashes into the sunlit basin.', 'valve_turn');
        break;
      }
      case 'prop_courtyard_chimes': {
        bumpCount();
        this.emitEvent('sfx', '', 'harp_amber');
        break;
      }
      case 'prop_tea_kettle': {
        bumpCount();
        this.emitEvent('info', 'The kettle puffs a fragrant cloud of jasmine steam.', 'oracle_miss');
        break;
      }
      case 'prop_tea_cabinet': {
        const open = toggleBool();
        this.emitEvent('sfx', '', open ? 'door_open' : 'dial_click');
        break;
      }
      case 'prop_speaking_tube': {
        bumpCount();
        this.emitEvent(
          'coop_prompt',
          `${player.name} whistled through the brass speaking tube!`,
          'ping',
        );
        break;
      }
      case 'prop_cons_mist': {
        const on = toggleBool();
        this.emitEvent(
          'info',
          on ? 'Glasshouse misting sprayers hiss softly.' : 'Glasshouse misting sprayers shut off.',
          'valve_turn',
        );
        break;
      }
      case 'prop_ws_whistle': {
        bumpCount();
        this.emitEvent('coop_prompt', `${player.name} blew the workshop steam whistle!`, 'valve_turn');
        break;
      }
      case 'prop_ws_chime': {
        bumpCount();
        this.emitEvent('sfx', '', 'harp_emerald');
        break;
      }
      case 'prop_obs_spyglass': {
        bumpCount();
        this.emitEvent(
          'info',
          'Through the brass spyglass: golden windmills turning across sunlit hills.',
          'mirror_rotate',
        );
        break;
      }
      default: {
        toggleBool();
        this.emitEvent('sfx', '', 'dial_click');
        break;
      }
    }
    this.syncAll();
  }

  public isItemSpawnedInWorld(itemId: ItemId): boolean {
    const s = this.state.solvedPuzzles;
    switch (itemId) {
      case 'key_study':
        return s.p1_twin_levers;
      case 'tool_uv_lamp':
        return s.p2_tea_cipher;
      case 'key_conservatory':
      case 'tool_prism':
        return s.p4_uv_safe;
      case 'item_gear_18t':
        return s.p5_pipe_organ;
      case 'core_sun':
        return s.p7_light_relay && s.p8_irrigation;
      case 'key_skylift':
        return s.p9_gear_train;
      case 'core_gear':
        return s.p10_foundry_sync;
      case 'core_star':
        return s.p11_orrery;
      case 'core_wind':
        return s.p12_wind_harp;
      default:
        return false;
    }
  }

  // === ONE-AND-DONE KEY DOOR UNLOCKING ===
  public handleUnlockDoor(playerId: string, doorId: DoorId): void {
    const player = this.state.players[playerId];
    if (!player) return;

    if (this.state.doors[doorId]) return; // already open

    const requiredKey = DOOR_KEY_REQUIREMENTS[doorId];
    if (requiredKey) {
      const keyIdx = player.inventory.indexOf(requiredKey);
      if (keyIdx === -1) {
        const keyDef = ITEMS[requiredKey];
        const partner = this.findPartner(playerId);
        const partnerHas = partner?.inventory.includes(requiredKey);
        this.hooks.sendTo(playerId, {
          type: 'world_event',
          event: 'error',
          message: partnerHas
            ? `${partner!.name} carries the ${keyDef.name} — ask them to pass it [G] or unlock it.`
            : `Locked! Requires the ${keyDef.name}.`,
          sfx: 'error',
        });
        return;
      }

      // CONSUME KEY (one-and-done!)
      player.inventory.splice(keyIdx, 1);
      this.state.consumedKeys.push(requiredKey);
      if (player.transform.heldItem === requiredKey) {
        player.transform.heldItem = null;
      }
      this.syncTeamInventory();
      this.state.doors[doorId] = true;

      const keyDef = ITEMS[requiredKey];
      this.emitEvent(
        'key_consumed',
        `${player.name} unlocked with ${keyDef.name} (key consumed).`,
        'key_unlock',
        { doorId, keyId: requiredKey },
      );
      this.syncAll();
      return;
    }

    // Non-key mechanical doors give subtle diegetic feedback without spoiling the puzzle
    const lockedHints: Record<DoorId, string> = {
      courtyard_door: 'Sealed by a mechanism in the foyer.',
      tea_north_grille: 'Held shut by a counterweight latch.',
      study_door: 'Locked — requires the Brass Study Key.',
      conservatory_door: 'Locked — requires the Conservatory Glass Key.',
      workshop_door: 'Sealed by an outdoor mechanism.',
      skylift_door: 'Locked — requires the Sky-Lift Brass Key.',
      solstice_gate: 'The Solstice Gate remains sealed.',
    };
    this.hooks.sendTo(playerId, {
      type: 'world_event',
      event: 'info',
      message: lockedHints[doorId],
      sfx: 'error',
    });
  }

  public handleDiscoverClue(clueId: string): void {
    const def = WORLD_CLUES[clueId];
    if (!def) return;
    if (this.state.discoveredClues.some((c) => c.id === clueId)) return;
    this.state.discoveredClues.push({
      id: def.id,
      title: def.title,
      zone: def.zone,
      body: def.body,
      discoveredAt: Date.now(),
    });
    this.syncAll();
  }

  public handleUvReveal(frameIndex: number): void {
    if (frameIndex < 0 || frameIndex > 3) return;
    if (!this.state.puzzles.uvRevealedFrames.includes(frameIndex)) {
      this.state.puzzles.uvRevealedFrames.push(frameIndex);
      this.handleDiscoverClue(`clue_uv_frame_${frameIndex}`);
      this.emitEvent('info', 'Hidden ink revealed — saved to Notebook.', 'uv_toggle');
      this.syncAll();
    }
  }

  public handleUpdateNotes(text: string): void {
    this.state.sharedNotes = text.slice(0, 6000);
    this.syncAll();
  }

  public handleDebugUnlockAll(): void {
    this.debugUnlocked = true;
    // Open every interior/exterior wing door (keep solstice_gate closed so victory doesn't fire)
    this.state.doors.courtyard_door = true;
    this.state.doors.tea_north_grille = true;
    this.state.doors.study_door = true;
    this.state.doors.conservatory_door = true;
    this.state.doors.workshop_door = true;
    this.state.doors.skylift_door = true;

    // Grant reusable exploration tools to every player's personal inventory for testing
    for (const tool of ['tool_uv_lamp', 'tool_prism'] as const) {
      for (const p of Object.values(this.state.players)) {
        if (!p.inventory.includes(tool)) {
          p.inventory.push(tool);
        }
      }
      if (!this.state.collectedWorldItems.includes(tool)) {
        this.state.collectedWorldItems.push(tool);
      }
    }
    this.syncTeamInventory();

    this.emitEvent('info', 'Debug: all doors unlocked & tools granted.', 'door_open');
    this.syncAll();
  }

  public handleCoopPing(playerId: string, x: number, y: number, z: number): void {
    const p = this.state.players[playerId];
    if (!p) return;
    const now = Date.now();
    this.state.pings = this.state.pings.filter((pg) => now - pg.createdAt < 7000);
    this.state.pings.push({
      id: `ping_${now}_${Math.random().toString(36).slice(2, 6)}`,
      playerSlot: p.slot,
      playerName: p.name,
      x,
      y,
      z,
      createdAt: now,
    });
    this.emitEvent('coop_ping', `${p.name} pinged a location.`, 'ping');
    this.syncAll();
  }

  // ============================================================
  // ALL 13 PUZZLE INTERACTIONS (Authoritative Server Logic)
  // ============================================================
  public handleInteract(
    playerId: string,
    targetId: string,
    payload: Record<string, unknown> = {},
  ): void {
    const player = this.state.players[playerId];
    if (!player) return;
    const pz = this.state.puzzles;
    const solved = this.state.solvedPuzzles;
    const now = Date.now();

    switch (targetId) {
      // --- P1A: Grand Foyer Clock (valid 12-hour clock times: 01:00..12:59) ---
      case 'p1_clock_set': {
        if (solved.p1_foyer_clock) return;
        const digits = payload.digits as number[];
        if (!Array.isArray(digits) || digits.length !== 4) return;
        const raw = digits.map((d) => Math.floor(Number(d) || 0));
        const a = Math.max(0, Math.min(1, raw[0]));
        let b = Math.max(0, Math.min(9, raw[1]));
        if (a === 0 && b === 0) b = 1;
        if (a === 1 && b > 2) b = 2;
        const c = Math.max(0, Math.min(5, raw[2]));
        const d = Math.max(0, Math.min(9, raw[3]));
        pz.clockDigits = [a, b, c, d];
        if (pz.clockDigits.every((v, i) => v === SOLUTIONS.p1_clock[i])) {
          solved.p1_foyer_clock = true;
          this.emitEvent('puzzle_solved', 'The grandfather clock chimes.', 'puzzle_solved');
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P1B: Twin Courtyard Entry Levers (2P Synchronized!) ---
      case 'lever_foyer_left':
      case 'lever_foyer_right': {
        if (!solved.p1_foyer_clock) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: 'The lever has no power yet.',
            sfx: 'error',
          });
          return;
        }
        if (solved.p1_twin_levers) return;

        const isLeft = targetId === 'lever_foyer_left';
        if (isLeft) {
          pz.foyerLeverLeftAt = now;
          pz.foyerLeverLeftBy = player.slot;
        } else {
          pz.foyerLeverRightAt = now;
          pz.foyerLeverRightBy = player.slot;
        }

        const otherAt = isLeft ? pz.foyerLeverRightAt : pz.foyerLeverLeftAt;
        const otherBy = isLeft ? pz.foyerLeverRightBy : pz.foyerLeverLeftBy;

        if (otherAt > 0 && now - otherAt <= SYNC_WINDOW_MS && otherBy !== player.slot) {
          solved.p1_twin_levers = true;
          this.state.doors.courtyard_door = true;
          this.emitEvent('puzzle_solved', 'The courtyard doors unseal.', 'door_open');
        } else {
          this.emitEvent(
            'coop_prompt',
            `${player.name} pulled the ${isLeft ? 'left' : 'right'} lever — waiting for the other…`,
            'lever_pull',
          );
        }
        this.syncAll();
        return;
      }

      // --- P2: Tea Parlor Split-Booth Cipher ---
      case 'p2_cipher_set': {
        if (solved.p2_tea_cipher) return;
        const dials = payload.dials as CipherSymbol[];
        if (!Array.isArray(dials) || dials.length !== 4) return;
        pz.teaCipherDials = [dials[0], dials[1], dials[2], dials[3]];
        if (pz.teaCipherDials.every((sym, i) => sym === SOLUTIONS.p2_cipher[i])) {
          solved.p2_tea_cipher = true;
          this.state.doors.tea_north_grille = true; // permanently latched open!
          this.emitEvent('puzzle_solved', 'The cipher clicks into place.', 'puzzle_solved');
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P3: Apothecary Tea Balance ---
      case 'p3_tea_set': {
        if (solved.p3_tea_balance) return;
        const w = payload.weights as { amber: number; jade: number; rose: number; mint: number };
        if (!w) return;
        const clamp = (n: number) => Math.max(1, Math.min(15, Math.round(Number(n) || 1)));
        pz.teaWeights = {
          amber: clamp(w.amber),
          jade: clamp(w.jade),
          rose: clamp(w.rose),
          mint: clamp(w.mint),
        };
        const sol = SOLUTIONS.p3_tea;
        if (
          pz.teaWeights.amber === sol.amber &&
          pz.teaWeights.jade === sol.jade &&
          pz.teaWeights.rose === sol.rose &&
          pz.teaWeights.mint === sol.mint
        ) {
          solved.p3_tea_balance = true;
          this.handleDiscoverClue('clue_core_sun_cardinal');
          this.emitEvent(
            'puzzle_solved',
            'The scale balances — a hidden latch clicks open.',
            'puzzle_solved',
          );
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P4: Study UV Safe ---
      case 'p4_safe_set': {
        if (solved.p4_uv_safe) return;
        const digits = payload.digits as number[];
        if (!Array.isArray(digits) || digits.length !== 4) return;
        pz.studySafeDigits = digits.map((d) => ((Math.floor(Number(d)) % 10) + 10) % 10) as [
          number,
          number,
          number,
          number,
        ];
        if (pz.studySafeDigits.every((d, i) => d === SOLUTIONS.p4_safe[i])) {
          solved.p4_uv_safe = true;
          this.emitEvent('puzzle_solved', 'The study safe unlocks.', 'puzzle_solved');
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P5: Harmonic Brass Pipe Organ ---
      case 'p5_organ_set': {
        if (solved.p5_pipe_organ) return;
        const pipes = payload.pipes as [number, number, number, number, number];
        if (!Array.isArray(pipes) || pipes.length !== 5) return;
        pz.organPipes = [...pipes] as [number, number, number, number, number];
        if (isPipeOrganValid(pz.organPipes)) {
          solved.p5_pipe_organ = true;
          this.handleDiscoverClue('clue_core_gear_cardinal');
          this.emitEvent(
            'puzzle_solved',
            'A warm chord resonates — a hidden compartment opens.',
            'puzzle_solved',
          );
        }
        this.syncAll();
        return;
      }

      // --- P6: Courtyard Equinox Sundial ---
      case 'p6_sundial_set': {
        if (solved.p6_sundial) return;
        const clamp12 = (n: number) => Math.max(1, Math.min(12, Math.round(Number(n) || 1)));
        pz.sundial = {
          hour: clamp12(Number(payload.hour)),
          azimuth: clamp12(Number(payload.azimuth)),
          day: clamp12(Number(payload.day)),
        };
        const sol = SOLUTIONS.p6_sundial;
        if (
          pz.sundial.hour === sol.hour &&
          pz.sundial.azimuth === sol.azimuth &&
          pz.sundial.day === sol.day
        ) {
          solved.p6_sundial = true;
          this.state.doors.workshop_door = true;
          this.emitEvent('puzzle_solved', 'The sundial locks into alignment.', 'door_open');
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P7: Courtyard Solar Beam Mirror Relay (2P Coop!) ---
      case 'insert_prism': {
        if (pz.prismInserted) {
          this.emitEvent('sfx', '', 'mirror_rotate');
          return;
        }
        if (!player.inventory.includes('tool_prism')) {
          const partner = this.findPartner(playerId);
          const partnerHas = partner?.inventory.includes('tool_prism');
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: partnerHas
              ? `${partner!.name} carries the Crystal Prism — ask them to pass it [G] or insert it.`
              : 'An empty optical socket — something is missing.',
            sfx: 'error',
          });
          return;
        }
        // Reusable tool: DO NOT consume tool_prism!
        pz.prismInserted = true;
        this.emitEvent('info', 'The sun-emitter ignites.', 'mirror_rotate');
        this.checkLightRelaySolved();
        this.syncAll();
        return;
      }

      case 'rotate_mirror_0':
      case 'rotate_mirror_1':
      case 'rotate_mirror_2': {
        const idx = Number(targetId.slice(-1)) as 0 | 1 | 2;
        if (solved.p7_light_relay) return;
        if (idx === 1 && !pz.mirror2Latched && pz.mirror2ClutchHeldBy.length === 0) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: 'The mirror springs back — something needs to hold its clutch.',
            sfx: 'error',
          });
          return;
        }
        pz.mirrorAngles[idx] = (pz.mirrorAngles[idx] + 1) % 8;
        this.emitEvent('sfx', '', 'mirror_rotate');
        this.checkLightRelaySolved();
        this.syncAll();
        return;
      }

      // --- P8: Conservatory Cross-Wired Irrigation (2P Coop!) ---
      case 'p8_valves_a':
      case 'p8_valves_b': {
        if (solved.p8_irrigation) return;
        const vals = payload.valves as number[];
        if (!Array.isArray(vals) || vals.length !== 3) return;
        const clamped = vals.map((v) => Math.max(0, Math.min(4, Math.round(Number(v) || 0)))) as [
          number,
          number,
          number,
        ];
        if (targetId === 'p8_valves_a') {
          pz.valvesA = clamped;
        } else {
          pz.valvesB = clamped;
        }
        const { gaugesAtA, gaugesAtB } = computeIrrigationGauges(pz.valvesA, pz.valvesB);
        const matchA = gaugesAtA.every((v, i) => v === SOLUTIONS.p8_targetsG[i]);
        const matchB = gaugesAtB.every((v, i) => v === SOLUTIONS.p8_targetsH[i]);
        if (matchA && matchB) {
          solved.p8_irrigation = true;
          this.emitEvent(
            'puzzle_solved',
            solved.p7_light_relay
              ? 'The Glass Lotus blooms.'
              : 'Water pressure stabilizes across the glasshouse.',
            'puzzle_solved',
          );
        } else {
          this.emitEvent('sfx', '', 'valve_turn');
        }
        this.syncAll();
        return;
      }

      // --- P9: Clockwork Workshop Gear Train ---
      case 'p9_gears_set': {
        if (solved.p9_gear_train) return;
        const slots = payload.slots as (string | null)[];
        if (!Array.isArray(slots) || slots.length !== 3) return;
        // Validate 18T gear cannot be mounted unless this player carries it!
        if (slots.includes('18') && !player.inventory.includes('item_gear_18t')) {
          const partner = this.findPartner(playerId);
          const partnerHas = partner?.inventory.includes('item_gear_18t');
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: partnerHas
              ? `${partner!.name} carries the 18-Tooth Gear — ask them to pass it [G].`
              : 'Missing the 18-tooth gear.',
            sfx: 'error',
          });
          return;
        }
        pz.gearSlots = [slots[0] ?? null, slots[1] ?? null, slots[2] ?? null];
        if (pz.gearSlots.every((g, i) => g === SOLUTIONS.p9_gears[i])) {
          solved.p9_gear_train = true;
          // Consume item_gear_18t from acting player's inventory since it's mounted in the machine!
          const gIdx = player.inventory.indexOf('item_gear_18t');
          if (gIdx !== -1) player.inventory.splice(gIdx, 1);
          if (player.transform.heldItem === 'item_gear_18t') player.transform.heldItem = null;
          this.syncTeamInventory();
          this.emitEvent('puzzle_solved', 'The gear train hums to life.', 'puzzle_solved');
        } else {
          this.emitEvent('sfx', '', 'gear_place');
        }
        this.syncAll();
        return;
      }

      // --- P10: Synchronized Foundry Forging (2P Timed Coop, 3 stages!) ---
      case 'lever_foundry_north':
      case 'lever_foundry_south': {
        if (!solved.p9_gear_train) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: 'The bellows have no drive power yet.',
            sfx: 'error',
          });
          return;
        }
        if (solved.p10_foundry_sync) return;

        const isNorth = targetId === 'lever_foundry_north';
        if (isNorth) {
          pz.foundryLeverNorthAt = now;
          pz.foundryLeverNorthBy = player.slot;
        } else {
          pz.foundryLeverSouthAt = now;
          pz.foundryLeverSouthBy = player.slot;
        }

        const otherAt = isNorth ? pz.foundryLeverSouthAt : pz.foundryLeverNorthAt;
        const otherBy = isNorth ? pz.foundryLeverSouthBy : pz.foundryLeverNorthBy;

        if (otherAt > 0 && now - otherAt <= SYNC_WINDOW_MS && otherBy !== player.slot) {
          pz.foundryStage += 1;
          // Reset timestamps so each of the 3 strikes requires a fresh synchronized pull!
          pz.foundryLeverNorthAt = 0;
          pz.foundryLeverSouthAt = 0;

          if (pz.foundryStage >= 3) {
            solved.p10_foundry_sync = true;
            this.emitEvent('puzzle_solved', 'The forge cools — something gleams on the anvil.', 'puzzle_solved');
          } else {
            this.emitEvent('coop_prompt', `Forge strike ${pz.foundryStage}/3.`, 'puzzle_solved');
          }
        } else {
          this.emitEvent(
            'coop_prompt',
            `${player.name} pulled a foundry lever — waiting for the other… (${pz.foundryStage}/3)`,
            'lever_pull',
          );
        }
        this.syncAll();
        return;
      }

      // --- P11: Planetary Orrery ---
      case 'p11_orrery_set': {
        if (solved.p11_orrery) return;
        const o = payload.orrery as { sun: number; mars: number; moon: number; sea: number };
        if (!o) return;
        const wrap8 = (n: number) => ((((Math.round(Number(n) || 1) - 1) % 8) + 8) % 8) + 1;
        pz.orrery = {
          sun: wrap8(o.sun),
          mars: wrap8(o.mars),
          moon: wrap8(o.moon),
          sea: wrap8(o.sea),
        };
        const sol = SOLUTIONS.p11_orrery;
        if (
          pz.orrery.sun === sol.sun &&
          pz.orrery.mars === sol.mars &&
          pz.orrery.moon === sol.moon &&
          pz.orrery.sea === sol.sea
        ) {
          solved.p11_orrery = true;
          this.handleDiscoverClue('clue_core_star_cardinal');
          this.emitEvent('puzzle_solved', 'The planetary rings lock into alignment.', 'puzzle_solved');
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P12: Sky-Deck Wind-Harp & Terrace Resonance Relay (2P Vertical Coop!) ---
      case 'harp_azure':
      case 'harp_amber':
      case 'harp_violet':
      case 'harp_emerald': {
        const color = targetId.replace('harp_', '') as HarpColor;
        if (solved.p12_wind_harp) {
          this.emitEvent('sfx', '', `harp_${color}`);
          return;
        }
        const expected = SOLUTIONS.p12_sequence[pz.windHarpStep];
        const partnerOnStone = pz.terracePadOccupied[color].some((s) => s !== player.slot);

        if (color === expected && partnerOnStone) {
          pz.windHarpStep += 1;
          if (pz.windHarpStep >= 4) {
            solved.p12_wind_harp = true;
            this.handleDiscoverClue('clue_core_wind_cardinal');
            this.emitEvent('puzzle_solved', 'All four harmonies resonate across the terrace.', 'puzzle_solved');
          } else {
            this.emitEvent('coop_prompt', `Harmony ${pz.windHarpStep}/4.`, `harp_${color}`);
          }
        } else if (color === expected && !partnerOnStone) {
          this.emitEvent('sfx', '', `harp_${color}`);
        } else {
          pz.windHarpStep = 0;
          this.emitEvent('error', 'The note falls flat.', 'error');
        }
        this.syncAll();
        return;
      }

      // --- P13: Grand Solstice Gate Core Pedestals ---
      case 'p13_insert_core': {
        const core = payload.core as 'sun' | 'gear' | 'star' | 'wind';
        const itemId = `core_${core}` as ItemId;
        if (!['sun', 'gear', 'star', 'wind'].includes(core)) return;
        if (pz.gateCoresInserted[core]) return;
        const invIdx = player.inventory.indexOf(itemId);
        if (invIdx === -1) {
          const partner = this.findPartner(playerId);
          const partnerHas = partner?.inventory.includes(itemId);
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: partnerHas
              ? `${partner!.name} carries the ${ITEMS[itemId].name} — ask them to pass it [G] or place it.`
              : `You aren't carrying the ${ITEMS[itemId].name}.`,
            sfx: 'error',
          });
          return;
        }
        player.inventory.splice(invIdx, 1);
        if (player.transform.heldItem === itemId) player.transform.heldItem = null;
        this.syncTeamInventory();
        pz.gateCoresInserted[core] = true;
        this.emitEvent(
          'info',
          `✦ Placed the ${ITEMS[itemId].name} into the Grand Solstice Gate!`,
          'gear_place',
        );
        this.checkFinaleVictory();
        this.syncAll();
        return;
      }

      case 'p13_set_dial': {
        const core = payload.core as 'sun' | 'gear' | 'star' | 'wind';
        const dir = payload.dir as CardinalDir;
        if (!['sun', 'gear', 'star', 'wind'].includes(core)) return;
        if (!['N', 'E', 'S', 'W'].includes(dir)) return;
        pz.gateDials[core] = dir;
        this.emitEvent('sfx', '', 'dial_click');
        this.checkFinaleVictory();
        this.syncAll();
        return;
      }
    }
  }

  private checkLightRelaySolved(): void {
    const pz = this.state.puzzles;
    if (this.state.solvedPuzzles.p7_light_relay) return;
    if (!pz.prismInserted) return;
    const target = SOLUTIONS.p7_mirrors;
    const aligned =
      pz.mirrorAngles[0] === target[0] &&
      pz.mirrorAngles[1] === target[1] &&
      pz.mirrorAngles[2] === target[2] &&
      (pz.mirror2Latched || pz.mirror2ClutchHeldBy.length > 0);

    if (aligned) {
      pz.mirror2Latched = true;
      this.state.solvedPuzzles.p7_light_relay = true;
      this.emitEvent(
        'puzzle_solved',
        this.state.solvedPuzzles.p8_irrigation
          ? 'The Glass Lotus blooms.'
          : 'The solar beam locks into place.',
        'puzzle_solved',
      );
    }
  }

  public areAllGatePedestalsAligned(): boolean {
    const pz = this.state.puzzles;
    const c = SOLUTIONS.p13_cardinals;
    return (
      pz.gateCoresInserted.sun &&
      pz.gateCoresInserted.gear &&
      pz.gateCoresInserted.star &&
      pz.gateCoresInserted.wind &&
      pz.gateDials.sun === c.sun &&
      pz.gateDials.gear === c.gear &&
      pz.gateDials.star === c.star &&
      pz.gateDials.wind === c.wind
    );
  }

  private checkFinaleVictory(): void {
    if (this.state.solvedPuzzles.p13_solstice_gate) return;
    if (!this.areAllGatePedestalsAligned()) return;

    const pz = this.state.puzzles;
    // Both Twin Solstice Pads must be occupied simultaneously by the 2 players!
    const leftSlot = pz.finalePadLeftBy[0];
    const rightSlot = pz.finalePadRightBy[0];

    if (leftSlot && rightSlot && leftSlot !== rightSlot) {
      this.state.solvedPuzzles.p13_solstice_gate = true;
      this.state.doors.solstice_gate = true;
      this.state.completedAt = Date.now();
      this.emitEvent('victory', 'The Grand Solstice Gate opens.', 'victory');
    } else if (leftSlot || rightSlot) {
      this.emitEvent('sfx', '', 'plate_step');
    }
  }

  // ============================================================
  // HINT SYSTEM (UNLIMITED MODE + 2P CLOCKWORK ORACLE MINIGAME)
  // ============================================================
  public handleRequestUnlimitedHint(playerId: string, targetPuzzleId?: PuzzleId): void {
    const player = this.state.players[playerId];
    if (!player) return;
    if (this.state.hintMode !== 'unlimited') {
      this.hooks.sendTo(playerId, {
        type: 'world_event',
        event: 'error',
        message:
          this.state.hintMode === 'none'
            ? 'Hints are turned off for this session.'
            : 'Use the Clockwork Oracle minigame to earn hints.',
        sfx: 'error',
      });
      return;
    }

    const hint = selectNextHint(this.state, targetPuzzleId ?? null);
    if (!hint) {
      this.hooks.sendTo(playerId, {
        type: 'world_event',
        event: 'info',
        message: 'Every mechanism in Solstice Manor is already solved.',
        sfx: 'dial_click',
      });
      return;
    }

    this.state.unlockedHints.push(hint);
    this.state.hintAttemptsCount += 1;
    this.state.hintWinsCount += 1;
    this.emitEvent(
      'puzzle_solved',
      `Hint unlocked: "${hint.puzzleTitle}" (Tier ${hint.tier}) — saved to Notebook.`,
      'oracle_win',
    );
    this.syncAll();
  }

  public handleMinigameReady(playerId: string, targetPuzzleId?: PuzzleId): void {
    const player = this.state.players[playerId];
    if (!player) return;
    if (this.state.hintMode === 'none') {
      this.hooks.sendTo(playerId, {
        type: 'world_event',
        event: 'error',
        message: 'Hints are turned off for this session.',
        sfx: 'error',
      });
      return;
    }
    if (this.state.hintMode === 'unlimited') {
      this.handleRequestUnlimitedHint(playerId, targetPuzzleId);
      return;
    }
    const now = Date.now();
    const mg = this.state.minigame;

    if (mg.phase === 'playing' || mg.phase === 'fate_draw') return;

    if (now < this.state.hintCooldownEndsAt) {
      const remSec = Math.ceil((this.state.hintCooldownEndsAt - now) / 1000);
      const mins = Math.floor(remSec / 60);
      const secs = remSec % 60;
      this.hooks.sendTo(playerId, {
        type: 'world_event',
        event: 'error',
        message: `The Clockwork Oracle is recharging! Available in ${mins}:${String(secs).padStart(2, '0')}.`,
        sfx: 'error',
      });
      return;
    }

    if (mg.phase === 'idle' || mg.phase === 'result') {
      mg.phase = 'lobby';
      mg.readyPlayers = [];
      mg.resultMessage = '';
      mg.awardedHint = null;
      mg.wonClue = null;
    }

    if (targetPuzzleId) {
      mg.targetPuzzleId = targetPuzzleId;
    }

    if (!mg.readyPlayers.includes(player.slot)) {
      mg.readyPlayers.push(player.slot);
    }

    // Require BOTH players (2 players!) to ready up to start the 2P coop minigame!
    const connectedCount = Object.values(this.state.players).filter((p) => p.connected).length;
    if (connectedCount < 2) {
      this.emitEvent(
        'info',
        'The Clockwork Oracle requires BOTH apprentices (2 players) connected to start!',
        'dial_click',
      );
      this.syncAll();
      return;
    }

    if (mg.readyPlayers.includes(1) && mg.readyPlayers.includes(2)) {
      this.minigameRunner.startPlaying(this.state, now);
      this.emitEvent('sfx', '', 'puzzle_solved');
    } else {
      this.emitEvent(
        'coop_prompt',
        `${player.name} is ready at the Clockwork Oracle (press H to join).`,
        'ping',
      );
    }
    this.syncAll();
  }

  public handleMinigameCancel(playerId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;
    const mg = this.state.minigame;
    if (mg.phase === 'lobby' || mg.phase === 'result') {
      mg.readyPlayers = mg.readyPlayers.filter((s) => s !== player.slot);
      if (mg.readyPlayers.length === 0) {
        mg.phase = 'idle';
      }
      this.syncAll();
    }
  }

  public handleMinigameInput(playerId: string, angle: number, pulse?: boolean): void {
    const player = this.state.players[playerId];
    if (!player) return;
    this.minigameRunner.applyInput(this.state, player.slot, angle, pulse, Date.now());
  }

  public handleMinigamePickCasket(playerId: string, casketIndex: 0 | 1 | 2): void {
    const player = this.state.players[playerId];
    if (!player) return;
    const res = this.minigameRunner.pickCasket(this.state, player.slot, casketIndex, Date.now());
    if (res.resolved) {
      if (res.won && res.hint) {
        this.emitEvent(
          'puzzle_solved',
          `📜 Oracle Clue Won! "${res.hint.puzzleTitle}" (Tier ${res.hint.tier}) added to your Notebook!`,
          'oracle_win',
        );
      } else {
        this.emitEvent(
          'info',
          '💨 Puff of golden steam! No clue this draw (2/3 odds). Oracle recharges in 10:00.',
          'oracle_miss',
        );
      }
    }
    this.syncAll();
  }

  private onTick(): void {
    const now = Date.now();
    const dtSec = Math.min(0.15, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;

    // Expire old coop pings cleanly
    if (this.state.pings.length > 0) {
      const before = this.state.pings.length;
      this.state.pings = this.state.pings.filter((pg) => now - pg.createdAt < 7000);
      if (this.state.pings.length !== before) {
        this.syncAll();
      }
    }

    // Tick active 2-player Hint Minigame
    if (this.state.minigame.phase === 'playing') {
      const res = this.minigameRunner.tick(this.state, dtSec, now);
      if (res.sfx) {
        this.emitEvent('sfx', '', res.sfx);
      }
      if (res.phaseChanged) {
        this.syncAll();
      } else {
        this.hooks.broadcast({
          type: 'minigame_tick',
          minigame: sanitizeMinigameForClient(this.state.minigame),
          serverTime: now,
        });
      }
    }
  }
}
