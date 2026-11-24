import {
  HintEntry,
  MinigameSpark,
  MinigameState,
  PlayerSlot,
  PuzzleId,
  WorldState,
} from '../shared/types.js';
import { PUZZLE_HINTS } from '../shared/puzzles.js';

export const HINT_COOLDOWN_MS = 10 * 60 * 1000; // Exactly 10 minutes
export const MINIGAME_DURATION_MS = 35_000; // 35 seconds (within 30-60s spec!)
export const MINIGAME_TARGET_SCORE = 12;

export function createIdleMinigameState(): MinigameState {
  return {
    phase: 'idle',
    readyPlayers: [],
    targetPuzzleId: null,
    startedAt: 0,
    endsAt: 0,
    durationMs: MINIGAME_DURATION_MS,
    score: 0,
    targetScore: MINIGAME_TARGET_SCORE,
    integrity: 100,
    p1Angle: 0,
    p2Angle: Math.PI,
    p1PulseAt: 0,
    p2PulseAt: 0,
    sparks: [],
    syncTargetAngle: null,
    syncCompleted: 0,
    casketVotes: {},
    winningCaskets: [],
    chosenCasket: null,
    wonClue: null,
    awardedHint: null,
    resultMessage: '',
  };
}

// Normalize angle difference to [0, PI]
function angleDiff(a: number, b: number): number {
  let d = Math.abs((a - b) % (Math.PI * 2));
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

// Pick the next progressive hint (Tier 1 -> Tier 2 -> Tier 3) for the target (or earliest unsolved) puzzle
export function selectNextHint(state: WorldState, requestedPuzzleId: PuzzleId | null): HintEntry | null {
  const ordered = [...PUZZLE_HINTS].sort((a, b) => a.order - b.order);

  // Pick requested puzzle if it's still unsolved, else earliest unsolved puzzle
  let track =
    requestedPuzzleId && !state.solvedPuzzles[requestedPuzzleId]
      ? ordered.find((t) => t.puzzleId === requestedPuzzleId)
      : undefined;

  if (!track) {
    track = ordered.find((t) => !state.solvedPuzzles[t.puzzleId]);
  }
  if (!track) return null;

  const existingCount = state.unlockedHints.filter((h) => h.puzzleId === track!.puzzleId).length;
  const tier = Math.min(3, existingCount + 1) as 1 | 2 | 3;

  return {
    id: `hint_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    puzzleId: track.puzzleId,
    puzzleTitle: track.title,
    tier,
    text: track.tiers[tier - 1],
    unlockedAt: Date.now(),
  };
}

// Generate 2 winning caskets out of 3 (exact 2/3 = 66.67% probability for any chosen casket!)
export function rollTwoOfThreeCaskets(rng: () => number = Math.random): number[] {
  const emptyCasket = Math.floor(rng() * 3); // 0, 1, or 2 uniformly -> 1/3 empty, 2/3 winning!
  return [0, 1, 2].filter((idx) => idx !== emptyCasket);
}

export class MinigameRunner {
  private nextSparkId = 1;
  private lastSpawnAt = 0;
  private lastSyncSpawnAt = 0;

  reset(): void {
    this.nextSparkId = 1;
    this.lastSpawnAt = 0;
    this.lastSyncSpawnAt = 0;
  }

  startPlaying(state: WorldState, now: number): void {
    this.reset();
    const mg = state.minigame;
    mg.phase = 'playing';
    mg.startedAt = now;
    mg.endsAt = now + MINIGAME_DURATION_MS;
    mg.durationMs = MINIGAME_DURATION_MS;
    mg.score = 0;
    mg.targetScore = MINIGAME_TARGET_SCORE;
    mg.integrity = 100;
    mg.p1Angle = 0;
    mg.p2Angle = Math.PI;
    mg.p1PulseAt = 0;
    mg.p2PulseAt = 0;
    mg.sparks = [];
    mg.syncTargetAngle = null;
    mg.syncCompleted = 0;
    mg.casketVotes = {};
    mg.winningCaskets = [];
    mg.chosenCasket = null;
    mg.wonClue = null;
    mg.awardedHint = null;
    mg.resultMessage = '';
    this.lastSpawnAt = now;
    this.lastSyncSpawnAt = now + 7000;
  }

  applyInput(state: WorldState, slot: PlayerSlot, angle: number, pulse: boolean | undefined, now: number): void {
    const mg = state.minigame;
    if (mg.phase !== 'playing') return;
    if (slot === 1) {
      mg.p1Angle = angle;
      if (pulse && now - mg.p1PulseAt > 900) {
        mg.p1PulseAt = now;
      }
    } else {
      mg.p2Angle = angle;
      if (pulse && now - mg.p2PulseAt > 900) {
        mg.p2PulseAt = now;
      }
    }
  }

  // Called at ~20Hz while minigame.phase === 'playing'. Returns event notifications if any.
  tick(
    state: WorldState,
    dtSec: number,
    now: number,
  ): { sfx?: string; phaseChanged?: boolean } {
    const mg = state.minigame;
    if (mg.phase !== 'playing') return {};

    let sfx: string | undefined;

    // 1. Spawn incoming Aether Sparks & Jam-Cogs
    const spawnIntervalMs = 1150;
    if (now - this.lastSpawnAt >= spawnIntervalMs) {
      this.lastSpawnAt = now;
      const roll = Math.random();
      let kind: MinigameSpark['kind'] = 'gold';
      let layer: MinigameSpark['layer'] = 'inner';
      if (roll < 0.38) {
        kind = 'gold';
        layer = 'inner'; // Player 1 catches on inner ring
      } else if (roll < 0.72) {
        kind = 'silver';
        layer = 'outer'; // Player 2 catches on outer ring
      } else {
        kind = 'cog';
        layer = 'outer'; // Either player deflects before core!
      }
      mg.sparks.push({
        id: this.nextSparkId++,
        angle: Math.random() * Math.PI * 2,
        radius: 1.02,
        speed: kind === 'cog' ? 0.30 : 0.27,
        kind,
        layer,
      });
    }

    // 2. Periodically trigger a Coop Sync Beam where BOTH players align to the same golden angle
    if (mg.syncTargetAngle === null && now - this.lastSyncSpawnAt > 11_000 && mg.syncCompleted < 2) {
      mg.syncTargetAngle = Math.random() * Math.PI * 2;
      this.lastSyncSpawnAt = now;
    }

    if (mg.syncTargetAngle !== null) {
      const p1Aligned = angleDiff(mg.p1Angle, mg.syncTargetAngle) < 0.48;
      const p2Aligned = angleDiff(mg.p2Angle, mg.syncTargetAngle) < 0.48;
      if (p1Aligned && p2Aligned) {
        mg.score += 3;
        mg.syncCompleted += 1;
        mg.syncTargetAngle = null;
        this.lastSyncSpawnAt = now;
        sfx = 'minigame_sync';
      }
    }

    // 3. Advance sparks inward and check ring collisions
    const OUTER_RING_R = 0.68;
    const INNER_RING_R = 0.38;
    const ARC_HALF_WIDTH = 0.52; // generous & fun ~60 deg total catcher arc

    const p1Pulsing = now - mg.p1PulseAt < 350;
    const p2Pulsing = now - mg.p2PulseAt < 350;

    const remaining: MinigameSpark[] = [];
    for (const sp of mg.sparks) {
      const prevR = sp.radius;
      sp.radius -= sp.speed * dtSec;

      // Outer ring intersection (Player 2)
      if (prevR >= OUTER_RING_R && sp.radius < OUTER_RING_R) {
        const hitP2 = angleDiff(sp.angle, mg.p2Angle) <= ARC_HALF_WIDTH + (p2Pulsing ? 0.25 : 0);
        if (sp.kind === 'silver' && hitP2) {
          mg.score += 1;
          sfx = 'minigame_catch';
          continue;
        }
        if (sp.kind === 'cog' && hitP2) {
          // Deflected safely!
          sfx = 'dial_click';
          continue;
        }
      }

      // Inner ring intersection (Player 1)
      if (prevR >= INNER_RING_R && sp.radius < INNER_RING_R) {
        const hitP1 = angleDiff(sp.angle, mg.p1Angle) <= ARC_HALF_WIDTH + (p1Pulsing ? 0.25 : 0);
        if (sp.kind === 'gold' && hitP1) {
          mg.score += 1;
          sfx = 'minigame_catch';
          continue;
        }
        if (sp.kind === 'cog' && hitP1) {
          // Deflected safely by P1!
          sfx = 'dial_click';
          continue;
        }
      }

      // Reached core center
      if (sp.radius <= 0.1) {
        if (sp.kind === 'cog') {
          mg.integrity = Math.max(0, mg.integrity - 18);
          sfx = 'minigame_cog';
        }
        continue;
      }

      remaining.push(sp);
    }
    mg.sparks = remaining;

    // 4. Check win / loss / timeout conditions
    if (mg.integrity <= 0) {
      this.finishAsFailed(state, now, 'Too many Jam-Cogs hit the Oracle core! Cooldown started.');
      return { sfx: 'oracle_miss', phaseChanged: true };
    }

    if (mg.score >= mg.targetScore) {
      // Players BEAT the coop minigame! Advance to the 2/3 luck-based Mystery Casket Fate Draw!
      mg.phase = 'fate_draw';
      mg.casketVotes = {};
      mg.winningCaskets = rollTwoOfThreeCaskets();
      mg.sparks = [];
      mg.syncTargetAngle = null;
      return { sfx: 'puzzle_solved', phaseChanged: true };
    }

    if (now >= mg.endsAt) {
      if (mg.score >= mg.targetScore) {
        mg.phase = 'fate_draw';
        mg.casketVotes = {};
        mg.winningCaskets = rollTwoOfThreeCaskets();
        mg.sparks = [];
        return { sfx: 'puzzle_solved', phaseChanged: true };
      } else {
        this.finishAsFailed(
          state,
          now,
          `Time ran out with ${mg.score}/${mg.targetScore} Aether Sparks! The Oracle rests for 10 minutes.`,
        );
        return { sfx: 'oracle_miss', phaseChanged: true };
      }
    }

    return { sfx };
  }

  private finishAsFailed(state: WorldState, now: number, reason: string): void {
    const mg = state.minigame;
    mg.phase = 'result';
    mg.wonClue = false;
    mg.awardedHint = null;
    mg.resultMessage = reason;
    mg.readyPlayers = [];
    state.hintAttemptsCount += 1;
    state.hintCooldownEndsAt = now + HINT_COOLDOWN_MS;
  }

  pickCasket(
    state: WorldState,
    slot: PlayerSlot,
    casketIndex: 0 | 1 | 2,
    now: number,
  ): { resolved: boolean; won: boolean; hint: HintEntry | null } {
    const mg = state.minigame;
    if (mg.phase !== 'fate_draw') {
      return { resolved: false, won: false, hint: null };
    }

    mg.casketVotes[slot] = casketIndex;

    const connectedSlots = Object.values(state.players)
      .filter((p) => p.connected)
      .map((p) => p.slot);

    const allVoted =
      connectedSlots.length > 0 && connectedSlots.every((s) => mg.casketVotes[s] !== undefined);

    if (!allVoted) {
      return { resolved: false, won: false, hint: null };
    }

    // If both players chose different caskets, pick fairly between their votes (still exact 2/3!)
    const votes = connectedSlots.map((s) => mg.casketVotes[s]!);
    const chosen = votes[0] === votes[votes.length - 1] ? votes[0] : votes[Math.floor(Math.random() * votes.length)];

    mg.chosenCasket = chosen;
    const won = mg.winningCaskets.includes(chosen);
    mg.wonClue = won;
    mg.phase = 'result';
    mg.readyPlayers = [];
    state.hintAttemptsCount += 1;
    state.hintCooldownEndsAt = now + HINT_COOLDOWN_MS;

    if (won) {
      const hint = selectNextHint(state, mg.targetPuzzleId);
      if (hint) {
        state.unlockedHints.push(hint);
        state.hintWinsCount += 1;
        mg.awardedHint = hint;
        mg.resultMessage = `The Casket springs open — a Radiant Clue Scroll for "${hint.puzzleTitle}" (Tier ${hint.tier})!`;
      } else {
        mg.awardedHint = null;
        mg.resultMessage = 'You have already solved every puzzle in Solstice Manor!';
      }
      return { resolved: true, won: true, hint };
    } else {
      mg.awardedHint = null;
      mg.resultMessage =
        'Puff! A whimsical cloud of golden steam escapes — this casket held only a brass feather! (2 in 3 caskets held a clue.) Try again in 10 minutes!';
      return { resolved: true, won: false, hint: null };
    }
  }
}

// Sanitize minigame state before sending to clients so winningCaskets aren't leaked during fate_draw!
export function sanitizeMinigameForClient(mg: MinigameState): MinigameState {
  if (mg.phase === 'fate_draw') {
    return {
      ...mg,
      winningCaskets: [],
    };
  }
  return mg;
}
