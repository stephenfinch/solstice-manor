import { describe, it, expect } from 'vitest';
import { GameRoom } from '../src/server/roomManager.js';
import { rollTwoOfThreeCaskets, HINT_COOLDOWN_MS } from '../src/server/minigameEngine.js';
import { computeGearSpeeds, computeIrrigationGauges, SOLUTIONS } from '../src/shared/puzzles.js';
import { FLOOR_PLATES } from '../src/shared/worldLayout.js';
import { ServerMessage } from '../src/shared/types.js';

function createTestRoom() {
  const events: ServerMessage[] = [];
  const room = new GameRoom('TEST', {
    broadcast: (msg) => events.push(msg),
    sendTo: (_id, msg) => events.push(msg),
  });
  const p1 = room.addOrReconnectPlayer('Alice')!;
  const p2 = room.addOrReconnectPlayer('Bob')!;
  return { room, p1, p2, events };
}

describe('Solstice Manor — Complete 2-Player Escape Room Verification', () => {
  it('completes the entire 13-puzzle cooperative playthrough from spawn to Victory', () => {
    const { room, p1, p2 } = createTestRoom();

    // Hint minigame starts UNLOCKED!
    expect(room.state.hintCooldownEndsAt).toBe(0);

    // P1A: Grandfather Clock enforces real 12-hour clock bounds (01:00..12:59)
    room.handleInteract(p1.id, 'p1_clock_set', { digits: [9, 9, 9, 9] });
    expect(room.state.puzzles.clockDigits).toEqual([1, 2, 5, 9]);
    room.handleInteract(p1.id, 'p1_clock_set', { digits: [0, 0, 6, 0] });
    expect(room.state.puzzles.clockDigits).toEqual([0, 1, 5, 0]);

    // P1A: Grand Foyer Clock (09:35)
    room.handleInteract(p1.id, 'p1_clock_set', { digits: [0, 9, 3, 5] });
    expect(room.state.solvedPuzzles.p1_foyer_clock).toBe(true);

    // P1B: Twin Courtyard Entry Levers require 2 DIFFERENT players within 2.6s!
    room.handleInteract(p1.id, 'lever_foyer_left');
    room.handleInteract(p1.id, 'lever_foyer_right'); // Same player shouldn't trigger!
    expect(room.state.solvedPuzzles.p1_twin_levers).toBe(false);

    room.handleInteract(p2.id, 'lever_foyer_right'); // Partner pulls right!
    expect(room.state.solvedPuzzles.p1_twin_levers).toBe(true);
    expect(room.state.doors.courtyard_door).toBe(true);

    // Pick up Brass Study Key (one-and-done!)
    room.handlePickup(p1.id, 'key_study');
    expect(room.state.inventory).toContain('key_study');

    // P2: Tea Parlor Asymmetric Coop — P1 steps on Foyer Plate -> North Grille opens!
    const fp = FLOOR_PLATES.foyer_booth_plate;
    room.updatePlayerTransform(p1.id, {
      ...p1.transform,
      x: fp.x,
      y: fp.y,
      z: fp.z,
    });
    expect(room.state.doors.tea_north_grille).toBe(true);

    // Solve Split-Booth Cipher -> unlocks UV Lamp (reusable tool) & permanently latches grille
    room.handleInteract(p1.id, 'p2_cipher_set', { dials: SOLUTIONS.p2_cipher });
    expect(room.state.solvedPuzzles.p2_tea_cipher).toBe(true);
    room.handlePickup(p2.id, 'tool_uv_lamp');
    expect(room.state.inventory).toContain('tool_uv_lamp');

    // P3: Tea Balance Apothecary
    room.handleInteract(p2.id, 'p3_tea_set', { weights: SOLUTIONS.p3_tea });
    expect(room.state.solvedPuzzles.p3_tea_balance).toBe(true);
    expect(room.state.discoveredClues.some((c) => c.id === 'clue_core_sun_cardinal')).toBe(true);

    // Unlock Study Door with Brass Study Key -> KEY MUST BE CONSUMED (one-and-done)!
    room.handleUnlockDoor(p1.id, 'study_door');
    expect(room.state.doors.study_door).toBe(true);
    expect(room.state.inventory).not.toContain('key_study');
    expect(room.state.consumedKeys).toContain('key_study');

    // P4: UV Invisible Ink Safe -> unlocks Conservatory Glass Key & Reusable Pocket Brass Prism
    for (let i = 0; i < 4; i++) room.handleUvReveal(i);
    expect(room.state.puzzles.uvRevealedFrames.length).toBe(4);
    room.handleInteract(p1.id, 'p4_safe_set', { digits: SOLUTIONS.p4_safe });
    expect(room.state.solvedPuzzles.p4_uv_safe).toBe(true);
    room.handlePickup(p1.id, 'key_conservatory');
    room.handlePickup(p2.id, 'tool_prism');
    expect(room.state.inventory).toContain('tool_prism');

    // P5: Harmonic Brass Pipe Organ -> 18T Gear + Gear Core Cardinal Clue
    room.handleInteract(p1.id, 'p5_organ_set', { pipes: SOLUTIONS.p5_organ });
    expect(room.state.solvedPuzzles.p5_pipe_organ).toBe(true);
    room.handlePickup(p1.id, 'item_gear_18t');

    // P6: Courtyard Sundial -> opens Clockwork Workshop
    room.handleInteract(p2.id, 'p6_sundial_set', SOLUTIONS.p6_sundial);
    expect(room.state.solvedPuzzles.p6_sundial).toBe(true);
    expect(room.state.doors.workshop_door).toBe(true);

    // P7: Courtyard Solar Beam Relay — Prism stays in inventory (reusable!)
    room.handleInteract(p2.id, 'insert_prism');
    expect(room.state.puzzles.prismInserted).toBe(true);
    expect(room.state.inventory).toContain('tool_prism'); // Reusable tool NOT consumed!

    // Mirror 2 requires Partner on Courtyard Sun-Pad
    room.handleInteract(p2.id, 'rotate_mirror_1');
    expect(room.state.puzzles.mirrorAngles[1]).toBe(0); // Rejected without pad!

    const sunPad = FLOOR_PLATES.courtyard_sun_pad;
    room.updatePlayerTransform(p1.id, { ...p1.transform, x: sunPad.x, y: sunPad.y, z: sunPad.z });
    for (let i = 0; i < SOLUTIONS.p7_mirrors[0]; i++) room.handleInteract(p2.id, 'rotate_mirror_0');
    for (let i = 0; i < SOLUTIONS.p7_mirrors[1]; i++) room.handleInteract(p2.id, 'rotate_mirror_1');
    for (let i = 0; i < SOLUTIONS.p7_mirrors[2]; i++) room.handleInteract(p2.id, 'rotate_mirror_2');
    expect(room.state.solvedPuzzles.p7_light_relay).toBe(true);
    expect(room.state.puzzles.mirror2Latched).toBe(true);

    // Unlock Botanical Conservatory with Conservatory Glass Key -> KEY CONSUMED!
    room.handleUnlockDoor(p1.id, 'conservatory_door');
    expect(room.state.doors.conservatory_door).toBe(true);
    expect(room.state.inventory).not.toContain('key_conservatory');
    expect(room.state.consumedKeys).toContain('key_conservatory');

    // P8: Conservatory Dual-Bank Irrigation -> Sun Resonance Core
    const gCheck = computeIrrigationGauges(SOLUTIONS.p8_valvesA, SOLUTIONS.p8_valvesB);
    expect(gCheck.gaugesAtA).toEqual(SOLUTIONS.p8_targetsG);
    expect(gCheck.gaugesAtB).toEqual(SOLUTIONS.p8_targetsH);

    room.handleInteract(p1.id, 'p8_valves_a', { valves: SOLUTIONS.p8_valvesA });
    room.handleInteract(p2.id, 'p8_valves_b', { valves: SOLUTIONS.p8_valvesB });
    expect(room.state.solvedPuzzles.p8_irrigation).toBe(true);
    room.handlePickup(p1.id, 'core_sun');

    // P9: Workshop Gear-Train -> Sky-Lift Key
    // Unmeshed gears after an empty shaft must stay stationary (0 RPM)!
    expect(computeGearSpeeds([null, '18', '36'])).toEqual([null, 0, 0]);
    expect(computeGearSpeeds(['24', null, '36'])).toEqual([30, null, 0]);
    expect(computeGearSpeeds(SOLUTIONS.p9_gears)).toEqual([30, 40, 20]);
    room.handleInteract(p1.id, 'p9_gears_set', { slots: SOLUTIONS.p9_gears });
    expect(room.state.solvedPuzzles.p9_gear_train).toBe(true);
    room.handlePickup(p1.id, 'key_skylift');

    // P10: Synchronized Foundry Forging (3 dual pulls) -> Gear Resonance Core
    for (let stage = 1; stage <= 3; stage++) {
      room.handleInteract(p1.id, 'lever_foundry_north');
      room.handleInteract(p2.id, 'lever_foundry_south');
      expect(room.state.puzzles.foundryStage).toBe(stage);
    }
    expect(room.state.solvedPuzzles.p10_foundry_sync).toBe(true);
    room.handlePickup(p2.id, 'core_gear');

    // Unlock Observatory Sky-Lift Gate with Sky-Lift Key -> KEY CONSUMED!
    room.handleUnlockDoor(p1.id, 'skylift_door');
    expect(room.state.doors.skylift_door).toBe(true);
    expect(room.state.inventory).not.toContain('key_skylift');
    expect(room.state.consumedKeys).toContain('key_skylift');

    // P11: Planetary Orrery -> Star Resonance Core
    room.handleInteract(p1.id, 'p11_orrery_set', { orrery: SOLUTIONS.p11_orrery });
    expect(room.state.solvedPuzzles.p11_orrery).toBe(true);
    room.handlePickup(p1.id, 'core_star');

    // P12: Sky-Deck Wind-Harp & Terrace Resonance Relay (4 coop steps) -> Wind Resonance Core
    for (const color of SOLUTIONS.p12_sequence) {
      const pad = FLOOR_PLATES[`terrace_${color}`];
      room.updatePlayerTransform(p2.id, { ...p2.transform, x: pad.x, y: pad.y, z: pad.z });
      room.handleInteract(p1.id, `harp_${color}`);
    }
    expect(room.state.solvedPuzzles.p12_wind_harp).toBe(true);
    room.handlePickup(p2.id, 'core_wind');

    // P13: Grand Solstice Gate Finale! (Separate inventories: each player inserts their own cores OR hands/drops them!)
    // Verify P1 cannot insert P2's Gear Core directly
    room.handleInteract(p1.id, 'p13_insert_core', { core: 'gear' });
    expect(room.state.puzzles.gateCoresInserted.gear).toBe(false);

    // P2 hands Gear Core directly to P1, and drops Wind Core on the ground for P1 to pick up
    room.handleGiveOrDropItem(p2.id, 'core_gear', 'partner');
    expect(p1.inventory).toContain('core_gear');
    expect(p2.inventory).not.toContain('core_gear');

    room.handleGiveOrDropItem(p2.id, 'core_wind', 'drop', 0, 0, -18);
    expect(room.state.droppedItems.some((d) => d.itemId === 'core_wind')).toBe(true);
    room.handlePickup(p1.id, 'core_wind');
    expect(room.state.droppedItems.length).toBe(0);
    expect(p1.inventory).toContain('core_wind');

    for (const core of ['sun', 'gear', 'star', 'wind'] as const) {
      room.handleInteract(p1.id, 'p13_insert_core', { core });
      room.handleInteract(p2.id, 'p13_set_dial', { core, dir: SOLUTIONS.p13_cardinals[core] });
    }
    expect(room.areAllGatePedestalsAligned()).toBe(true);
    expect(room.state.doors.solstice_gate).toBe(false); // Needs both players on Twin Finale Pads!

    const padL = FLOOR_PLATES.finale_pad_left;
    const padR = FLOOR_PLATES.finale_pad_right;
    room.updatePlayerTransform(p1.id, { ...p1.transform, x: padL.x, y: padL.y, z: padL.z });
    expect(room.state.doors.solstice_gate).toBe(false);
    room.updatePlayerTransform(p2.id, { ...p2.transform, x: padR.x, y: padR.y, z: padR.z });

    expect(room.state.solvedPuzzles.p13_solstice_gate).toBe(true);
    expect(room.state.doors.solstice_gate).toBe(true);
    expect(room.state.completedAt).not.toBeNull();
  });

  it('enforces the 2-player Clockwork Oracle Hint Minigame, exact 2/3 odds, and 10-minute cooldown', () => {
    // Verify statistical 2/3 distribution across 30,000 Fate Draws
    let wins = 0;
    const trials = 30000;
    for (let i = 0; i < trials; i++) {
      const winners = rollTwoOfThreeCaskets();
      expect(winners.length).toBe(2);
      const pick = i % 3;
      if (winners.includes(pick)) wins++;
    }
    const rate = wins / trials;
    expect(rate).toBeGreaterThan(0.64);
    expect(rate).toBeLessThan(0.69);

    // Verify 2-player ready requirement + 10-minute cooldown enforcement
    const { room, p1, p2 } = createTestRoom();
    expect(room.state.hintCooldownEndsAt).toBe(0); // Starts unlocked

    room.handleMinigameReady(p1.id);
    expect(room.state.minigame.phase).toBe('lobby'); // Still waiting for P2!

    room.handleMinigameReady(p2.id);
    expect(room.state.minigame.phase).toBe('playing'); // Started with 2 players!

    // Simulate beating the 35s minigame -> transitions to fate_draw
    room.state.minigame.score = room.state.minigame.targetScore;
    const tickRes = room.minigameRunner.tick(room.state, 0.05, Date.now());
    expect(tickRes.phaseChanged).toBe(true);
    expect(room.state.minigame.phase).toBe('fate_draw');
    expect(room.state.minigame.winningCaskets.length).toBe(2);

    // Verify sanitized state hides winningCaskets before reveal!
    expect(room.getSanitizedState().minigame.winningCaskets).toEqual([]);

    // Both players vote on casket 0 -> resolves and sets 10-minute cooldown
    const before = Date.now();
    room.handleMinigamePickCasket(p1.id, 0);
    expect(room.state.minigame.phase).toBe('fate_draw'); // Wait for P2 vote!
    room.handleMinigamePickCasket(p2.id, 0);
    expect(room.state.minigame.phase).toBe('result');
    expect(room.state.hintCooldownEndsAt).toBeGreaterThanOrEqual(before + HINT_COOLDOWN_MS - 50);

    // Trying to start again during 10-minute cooldown is blocked!
    room.handleMinigameReady(p1.id);
    expect(room.state.minigame.phase).toBe('result');
  });

  it('supports unlimited and disabled hint modes, separate inventories, interactive props, and character appearance', () => {
    // 1. Unlimited hints mode: instant hints with zero cooldown
    const unlimitedRoom = new GameRoom(
      'UNLM',
      { broadcast: () => {}, sendTo: () => {} },
      'unlimited',
    );
    const u1 = unlimitedRoom.addOrReconnectPlayer('Clara', undefined, {
      coatColor: '#2e4a73',
      hatStyle: 'aviator',
      goggleColor: '#68d391',
    })!;
    expect(unlimitedRoom.state.hintMode).toBe('unlimited');
    expect(u1.appearance).toEqual({
      coatColor: '#2e4a73',
      hatStyle: 'aviator',
      goggleColor: '#68d391',
    });

    unlimitedRoom.handleRequestUnlimitedHint(u1.id, 'p1_foyer_clock');
    unlimitedRoom.handleRequestUnlimitedHint(u1.id, 'p1_foyer_clock');
    expect(unlimitedRoom.state.unlockedHints.length).toBe(2);
    expect(unlimitedRoom.state.unlockedHints[0].tier).toBe(1);
    expect(unlimitedRoom.state.unlockedHints[1].tier).toBe(2);
    expect(unlimitedRoom.state.hintCooldownEndsAt).toBe(0);

    // 2. Disabled hints mode ('none'): blocks both unlimited hints & Oracle minigame
    const noHintRoom = new GameRoom('NONE', { broadcast: () => {}, sendTo: () => {} }, 'none');
    const n1 = noHintRoom.addOrReconnectPlayer('Theo')!;
    const n2 = noHintRoom.addOrReconnectPlayer('Maya')!;
    noHintRoom.handleRequestUnlimitedHint(n1.id);
    noHintRoom.handleMinigameReady(n1.id);
    noHintRoom.handleMinigameReady(n2.id);
    expect(noHintRoom.state.unlockedHints.length).toBe(0);
    expect(noHintRoom.state.minigame.phase).toBe('idle');

    // 3. Interactive props toggle & increment cleanly
    noHintRoom.handleToggleProp(n1.id, 'prop_foyer_drawer_1');
    expect(noHintRoom.state.props.prop_foyer_drawer_1).toBe(true);
    noHintRoom.handleToggleProp(n1.id, 'prop_foyer_drawer_1');
    expect(noHintRoom.state.props.prop_foyer_drawer_1).toBe(false);
    noHintRoom.handleToggleProp(n2.id, 'prop_foyer_bell');
    noHintRoom.handleToggleProp(n2.id, 'prop_foyer_bell');
    expect(noHintRoom.state.props.prop_foyer_bell).toBe(2);
  });
});
