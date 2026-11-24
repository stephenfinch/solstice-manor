import {
  CardinalDir,
  CipherSymbol,
  DoorId,
  HarpColor,
  ItemId,
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
} from './minigameEngine.js';

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

  constructor(roomCode: string, hooks: BroadcastHooks) {
    this.hooks = hooks;
    this.state = {
      roomCode,
      startedAt: Date.now(),
      completedAt: null,
      players: {},
      doors: createInitialDoors(),
      solvedPuzzles: createInitialSolved(),
      inventory: [],
      collectedWorldItems: [],
      consumedKeys: [],
      puzzles: createInitialPuzzleStates(),
      discoveredClues: [],
      unlockedHints: [],
      sharedNotes:
        'SOLSTICE MANOR — SHARED FIELD NOTES\n• Work together across indoor & outdoor rooms!\n• Keys are single-use; tools like the UV Lamp & Prism are reusable.\n',
      hintCooldownEndsAt: 0, // Starts UNLOCKED!
      hintAttemptsCount: 0,
      hintWinsCount: 0,
      minigame: createIdleMinigameState(),
      pings: [],
    };
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

  public addOrReconnectPlayer(playerName: string, requestedPlayerId?: string): PlayerInfo | null {
    const cleanName = (playerName || 'Apprentice').trim().slice(0, 18) || 'Apprentice';

    // Try reconnect by id
    if (requestedPlayerId && this.state.players[requestedPlayerId]) {
      const existing = this.state.players[requestedPlayerId];
      existing.connected = true;
      existing.name = cleanName;
      return existing;
    }

    // Try taking over a disconnected slot
    const disconnected = Object.values(this.state.players).find((p) => !p.connected);
    if (disconnected) {
      disconnected.connected = true;
      disconnected.name = cleanName;
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
      transform: {
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: spawn.yaw,
        pitch: 0,
        moving: false,
        zone: 'foyer',
        uvOn: false,
        heldItem: null,
      },
    };
    this.state.players[id] = player;
    return player;
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
      if (!this.state.solvedPuzzles.p2_tea_cipher) {
        this.state.doors.tea_north_grille = foyerPlate.length > 0;
        if (wasEmpty && foyerPlate.length > 0) {
          this.emitEvent(
            'coop_prompt',
            'Foyer Brass Plate depressed — North Tea Booth grille is held open!',
            'plate_step',
          );
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
          this.emitEvent(
            'coop_prompt',
            'Courtyard Sun-Pad held! Mirror 2 clutch is engaged — align the mirrors!',
            'plate_step',
          );
          this.checkLightRelaySolved();
        } else if (sunPad.length === 0 && pz.mirrorAngles[1] !== 0) {
          // Spring-loaded Mirror 2 drifts back when pad is released before latching!
          pz.mirrorAngles[1] = 0;
          this.emitEvent(
            'info',
            'Mirror 2 sprang back! Keep one apprentice on the Courtyard Sun-Pad while aligning the beam.',
            'dial_click',
          );
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

  // === PICKUP WORLD ITEMS ===
  public handlePickup(playerId: string, itemId: ItemId): void {
    if (!this.state.players[playerId]) return;
    if (!ITEMS[itemId]) return;
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
    this.state.inventory.push(itemId);

    const def = ITEMS[itemId];
    this.emitEvent(
      'item_picked',
      `Acquired ${def.icon} ${def.name}${def.consumable && def.category === 'key' ? ' (Single-Use Key)' : !def.consumable ? ' (Reusable Tool)' : ''}!`,
      'pickup',
      { itemId },
    );
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
      const keyIdx = this.state.inventory.indexOf(requiredKey);
      if (keyIdx === -1) {
        const keyDef = ITEMS[requiredKey];
        this.hooks.sendTo(playerId, {
          type: 'world_event',
          event: 'error',
          message: `Locked! Requires the ${keyDef.name}.`,
          sfx: 'error',
        });
        return;
      }

      // CONSUME KEY (one-and-done!)
      this.state.inventory.splice(keyIdx, 1);
      this.state.consumedKeys.push(requiredKey);
      // Clear heldItem if any player was holding this consumed key
      for (const p of Object.values(this.state.players)) {
        if (p.transform.heldItem === requiredKey) {
          p.transform.heldItem = null;
        }
      }
      this.state.doors[doorId] = true;

      const keyDef = ITEMS[requiredKey];
      this.emitEvent(
        'key_consumed',
        `🔓 Used ${keyDef.name} — door unlocked! (Key consumed in lock.)`,
        'key_unlock',
        { doorId, keyId: requiredKey },
      );
      this.syncAll();
      return;
    }

    // Non-key mechanical doors give helpful diegetic feedback
    const lockedHints: Record<DoorId, string> = {
      courtyard_door:
        'Sealed by the Foyer Awakening Clock and Twin Courtyard Levers!',
      tea_north_grille:
        'Controlled by the Brass Floor Plate in the Foyer (or solve the Tea Parlor Cipher to latch it open!).',
      study_door: 'Requires the Brass Study Key.',
      conservatory_door: 'Requires the Conservatory Glass Key.',
      workshop_door: 'Sealed by the Equinox Sundial in the Sunlit Courtyard!',
      skylift_door: 'Requires the Sky-Lift Brass Key.',
      solstice_gate:
        'Insert & align all 4 Resonance Cores, then stand on BOTH Twin Solstice Pads together!',
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
      this.emitEvent(
        'info',
        `✨ Invisible Aether Ink revealed on Study Frame #${frameIndex + 1}! Logged to Notebook.`,
        'uv_toggle',
      );
      this.syncAll();
    }
  }

  public handleUpdateNotes(text: string): void {
    this.state.sharedNotes = text.slice(0, 6000);
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
    this.emitEvent('coop_ping', `📍 ${p.name} pinged a location!`, 'ping');
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
      // --- P1A: Grand Foyer Clock ---
      case 'p1_clock_set': {
        if (solved.p1_foyer_clock) return;
        const digits = payload.digits as number[];
        if (!Array.isArray(digits) || digits.length !== 4) return;
        pz.clockDigits = digits.map((d) => ((Math.floor(Number(d)) % 10) + 10) % 10) as [
          number,
          number,
          number,
          number,
        ];
        if (pz.clockDigits.every((d, i) => d === SOLUTIONS.p1_clock[i])) {
          solved.p1_foyer_clock = true;
          this.emitEvent(
            'puzzle_solved',
            '🔔 09:35! The Grandfather Clock chimes — Twin Courtyard Levers are now energized!',
            'puzzle_solved',
          );
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
            message: 'The lever has no power yet — set the Foyer Grandfather Clock first!',
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
          this.emitEvent(
            'puzzle_solved',
            '☀️ Twin Levers synchronized! The Grand Courtyard Doors swing open — and the Brass Study Key dropped onto the Foyer pedestal!',
            'door_open',
          );
        } else {
          this.emitEvent(
            'coop_prompt',
            `⚡ ${player.name} pulled the ${isLeft ? 'LEFT' : 'RIGHT'} Entry Lever! Pull the ${isLeft ? 'RIGHT' : 'LEFT'} Lever within 2.5s!`,
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
          this.emitEvent(
            'puzzle_solved',
            '✨ Botanical Cipher solved! North Booth grille locked open & the Aether UV Lantern is now available in the Supply Cabinet!',
            'puzzle_solved',
          );
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
            '⚖️ Tea Scale balanced! Secret drawer popped open — Solstice Plaque I (Sun Core: EAST) added to your Notebook!',
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
          this.emitEvent(
            'puzzle_solved',
            '🔓 Study Wall Safe unlocked! Claim the Conservatory Glass Key & Pocket Brass Prism from the safe!',
            'puzzle_solved',
          );
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
            '🎵 Pure harmony! The Organ Compartment opens — 18-Tooth Brass Gear & Solstice Plaque II (Gear Core: SOUTH) revealed!',
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
          this.emitEvent(
            'puzzle_solved',
            '☀️ Equinox Sundial aligned (6 • 4 • 10)! The East Clockwork Workshop Doors unseal!',
            'door_open',
          );
        } else {
          this.emitEvent('sfx', '', 'dial_click');
        }
        this.syncAll();
        return;
      }

      // --- P7: Courtyard Solar Beam Mirror Relay (2P Coop!) ---
      case 'insert_prism': {
        if (pz.prismInserted) {
          this.emitEvent('info', 'The Sun-Emitter is already focusing golden light across the courtyard!', 'mirror_rotate');
          return;
        }
        if (!this.state.inventory.includes('tool_prism')) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: 'The Sun-Emitter socket is empty — find the Pocket Brass Prism in the Study Safe!',
            sfx: 'error',
          });
          return;
        }
        // Reusable tool: DO NOT consume tool_prism!
        pz.prismInserted = true;
        this.emitEvent(
          'info',
          '💎 Solar Emitter aligned with your Brass Prism! Now rotate Mirrors 1, 2 & 3 into the Conservatory Roof Receptor!',
          'mirror_rotate',
        );
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
            message: 'Mirror 2 is spring-loaded! Have your partner stand on the Courtyard Sun-Pad to lock its clutch while you rotate it!',
            sfx: 'error',
          });
          return;
        }
        pz.mirrorAngles[idx] = (pz.mirrorAngles[idx] + 1) % 8;
        this.emitEvent(
          'sfx',
          `Mirror ${idx + 1} rotated to notch ${pz.mirrorAngles[idx]}`,
          'mirror_rotate',
        );
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
          if (solved.p7_light_relay) {
            this.emitEvent(
              'puzzle_solved',
              '🌺 All 6 irrigation gauges balanced & sunlight streaming! The Glass Lotus blooms — claim the Sun Resonance Core!',
              'puzzle_solved',
            );
          } else {
            this.emitEvent(
              'puzzle_solved',
              '💧 Irrigation network balanced! Now route the Courtyard Solar Beam into the Conservatory roof to bloom the Glass Lotus!',
              'puzzle_solved',
            );
          }
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
        // Validate 18T gear cannot be mounted unless collected!
        if (slots.includes('18') && !this.state.collectedWorldItems.includes('item_gear_18t')) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: 'You do not have the 18-Tooth Brass Gear yet! Check the Alchemist\'s Study.',
            sfx: 'error',
          });
          return;
        }
        pz.gearSlots = [slots[0] ?? null, slots[1] ?? null, slots[2] ?? null];
        if (pz.gearSlots.every((g, i) => g === SOLUTIONS.p9_gears[i])) {
          solved.p9_gear_train = true;
          // Consume item_gear_18t from inventory since it's mounted in the machine!
          const gIdx = this.state.inventory.indexOf('item_gear_18t');
          if (gIdx !== -1) this.state.inventory.splice(gIdx, 1);
          this.emitEvent(
            'puzzle_solved',
            '⚙️ Gear Train spinning at 30 / 40 / 20 RPM! The Foundry Forge lights up & the Sky-Lift Brass Key is released!',
            'puzzle_solved',
          );
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
            message: 'The Foundry Bellows are cold — assemble and start the Workshop Gear-Train first!',
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
            this.emitEvent(
              'puzzle_solved',
              '🔥 Strike 3/3! The Gear Resonance Core is forged and glowing on the central anvil!',
              'puzzle_solved',
            );
          } else {
            this.emitEvent(
              'coop_prompt',
              `🔨 Synchronized Forge Strike ${pz.foundryStage}/3! Pull both levers together again!`,
              'puzzle_solved',
            );
          }
        } else {
          this.emitEvent(
            'coop_prompt',
            `🔥 ${player.name} pulled the ${isNorth ? 'NORTH-EAST' : 'SOUTH-EAST'} Foundry Lever! Pull the opposite lever within 2.5s! (${pz.foundryStage}/3)`,
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
          this.emitEvent(
            'puzzle_solved',
            '✨ Celestial alignment achieved! Claim the Star Resonance Core — Solstice Plaque III (Star Core: NORTH) logged!',
            'puzzle_solved',
          );
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
            this.emitEvent(
              'puzzle_solved',
              '🎶 All 4 Wind-Harp harmonies complete! Claim the Wind Resonance Core at the Sky-Garden Spire — Solstice Plaque IV (Wind Core: WEST) logged!',
              'puzzle_solved',
            );
          } else {
            this.emitEvent(
              'coop_prompt',
              `🎶 Harmonic Chord ${pz.windHarpStep}/4 resonated (${color.toUpperCase()})! Continue the Under-Arch sequence!`,
              `harp_${color}`,
            );
          }
        } else if (color === expected && !partnerOnStone) {
          this.emitEvent(
            'coop_prompt',
            `Wind-Harp ${color.toUpperCase()} chimes, but your partner must stand on the glowing ${color.toUpperCase()} Terrace Stone below at the same time!`,
            `harp_${color}`,
          );
        } else {
          pz.windHarpStep = 0;
          this.emitEvent(
            'error',
            `Discordant note (${color.toUpperCase()})! Sequence reset to Step 1 — have your partner read the Under-Arch Relief from below!`,
            'error',
          );
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
        const invIdx = this.state.inventory.indexOf(itemId);
        if (invIdx === -1) {
          this.hooks.sendTo(playerId, {
            type: 'world_event',
            event: 'error',
            message: `You haven't recovered the ${ITEMS[itemId].name} yet!`,
            sfx: 'error',
          });
          return;
        }
        this.state.inventory.splice(invIdx, 1);
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
      if (this.state.solvedPuzzles.p8_irrigation) {
        this.emitEvent(
          'puzzle_solved',
          '☀️ Solar Beam locked into the Conservatory! The Glass Lotus blooms — claim the Sun Resonance Core!',
          'puzzle_solved',
        );
      } else {
        this.emitEvent(
          'puzzle_solved',
          '☀️ Solar Beam locked! Mirror 2 permanently latched — now balance the Conservatory Irrigation Valves to bloom the Glass Lotus!',
          'puzzle_solved',
        );
      }
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
      this.emitEvent(
        'victory',
        '☀️ THE GRAND SOLSTICE GATE OPENS! Congratulations, Master Horologists!',
        'victory',
      );
    } else if (leftSlot || rightSlot) {
      this.emitEvent(
        'coop_prompt',
        '✨ All 4 Resonance Cores aligned! Stand on BOTH Twin Solstice Pads simultaneously to open the Grand Gate!',
        'plate_step',
      );
    }
  }

  // ============================================================
  // 2-PLAYER COOP HINT MINIGAME (CLOCKWORK ORACLE)
  // ============================================================
  public handleMinigameReady(playerId: string, targetPuzzleId?: PuzzleId): void {
    const player = this.state.players[playerId];
    if (!player) return;
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
      this.emitEvent(
        'info',
        '🔮 Clockwork Oracle Aether-Gear Challenge STARTED! Charge 12 Sparks together!',
        'puzzle_solved',
      );
    } else {
      this.emitEvent(
        'coop_prompt',
        `🔮 ${player.name} is ready for the Clockwork Oracle Hint Minigame! Press [H] to join!`,
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
