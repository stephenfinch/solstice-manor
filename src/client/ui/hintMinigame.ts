import { PUZZLE_HINTS } from '../../shared/puzzles.js';
import type {
  HintEntry,
  MinigameSpark,
  MinigameState,
  PlayerSlot,
  PuzzleId,
  WorldState,
} from '../../shared/types.js';
import { byId, el, formatDuration, isTypingTarget, releasePointer, svg } from './hud.js';

export interface HintMinigameController {
  isOpen(): boolean;
  open(state: WorldState, mySlot: PlayerSlot): void;
  close(): void;
  updateState(state: WorldState, mySlot: PlayerSlot): void;
  updateTick(minigame: MinigameState, mySlot: PlayerSlot, serverTime: number): void;
}

interface Callbacks {
  onReady: (targetPuzzleId?: PuzzleId) => void;
  onCancel: () => void;
  onInput: (angle: number, pulse?: boolean) => void;
  onPickCasket: (index: 0 | 1 | 2) => void;
  onRequestUnlimitedHint: (targetPuzzleId?: PuzzleId) => void;
  onSfx: (name: string) => void;
}

type ViewName = 'unlimited' | 'lobby' | 'playing' | 'fate' | 'result';

interface View {
  root: HTMLElement;
  update(): void;
  tick?(): void; // 4Hz clock
  dispose?(): void;
}

// --- Geometry & rules mirrored from the server's minigame engine ---
const SIZE = 520;
const CENTER = SIZE / 2;
const UNIT = 208; // canvas px for radius 1.0
const OUTER_R = 0.68;
const INNER_R = 0.38;
const ARC_HALF = 0.52;
const PULSE_BONUS = 0.25;
const PULSE_MS = 350;
const PULSE_COOLDOWN_MS = 900;
const SYNC_TOLERANCE = 0.48;
const SEND_MS = 40; // 25Hz

const TURN_SPEED = 4.4; // rad/s at full key hold
const DRAG_SPEED = 11; // rad/s while following the pointer

const TAU = Math.PI * 2;
const CASKET_NAMES = ['Left', 'Center', 'Right'] as const;
const P1_COLOR = '#f5b942';
const P2_COLOR = '#63b4f2';

const wrap = (a: number): number => ((a % TAU) + TAU) % TAU;
/** Signed shortest rotation from a to b. */
const turnTo = (a: number, b: number): number => {
  const d = wrap(b - a);
  return d > Math.PI ? d - TAU : d;
};

export function createHintMinigame(callbacks: Callbacks): HintMinigameController {
  const overlay = byId('minigame-overlay');

  let opened = false;
  let state: WorldState | null = null;
  let mg: MinigameState | null = null;
  let slot: PlayerSlot = 1;
  let view: View | null = null;
  let viewName: ViewName | null = null;
  let clockOffset = 0; // server clock minus ours
  let clockTimer = 0;
  let tickArrivedAt = 0;
  let pickedPuzzle: PuzzleId | null = null;

  // Partner leaving the result screen resets the server phase, so each player keeps their own copy.
  let latchedResult: MinigameState | null = null;
  let dismissedResult = '';

  const serverNow = (): number => Date.now() + clockOffset;
  const resultKey = (m: MinigameState): string => `${m.startedAt}:${m.endsAt}`;
  const cooldownLeft = (): number => (state ? state.hintCooldownEndsAt - serverNow() : 0);
  const partnerSlot = (): PlayerSlot => (slot === 1 ? 2 : 1);

  function nameOf(s: PlayerSlot): string {
    const p = state && Object.values(state.players).find((x) => x.slot === s);
    return p ? p.name : `Apprentice ${s}`;
  }
  function isConnected(s: PlayerSlot): boolean {
    return !!state && Object.values(state.players).some((x) => x.slot === s && x.connected);
  }

  // ==========================================================
  // View routing
  // ==========================================================
  function resolveView(): ViewName {
    if (state?.hintMode === 'unlimited') return 'unlimited';
    if (!mg) return 'lobby';
    if (mg.phase === 'playing' || mg.phase === 'fate_draw') {
      latchedResult = null;
      return mg.phase === 'playing' ? 'playing' : 'fate';
    }
    if (mg.phase === 'result' && resultKey(mg) !== dismissedResult) latchedResult = mg;
    return latchedResult ? 'result' : 'lobby';
  }

  function render(): void {
    if (!opened) return;
    const next = resolveView();
    if (next !== viewName) {
      view?.dispose?.();
      viewName = next;
      view =
        next === 'unlimited'
          ? unlimitedView()
          : next === 'lobby'
            ? lobbyView()
            : next === 'playing'
              ? playingView()
              : next === 'fate'
                ? fateView()
                : resultView(latchedResult!);
      overlay.replaceChildren(view.root);
      overlay.dataset.view = next;
    }
    view?.update();
    view?.tick?.();
  }

  function open(nextState: WorldState, mySlot: PlayerSlot): void {
    if (nextState.hintMode === 'none') return; // the host switched hints off
    state = nextState;
    mg = nextState.minigame;
    slot = mySlot;
    releasePointer();
    if (!opened) {
      opened = true;
      overlay.classList.remove('hidden');
      clockTimer = window.setInterval(() => view?.tick?.(), 250);
    }
    render();
  }

  function dismissResult(): void {
    if (!latchedResult) return;
    dismissedResult = resultKey(latchedResult);
    latchedResult = null;
    if (mg?.phase === 'result') callbacks.onCancel();
  }

  function close(): void {
    if (!opened) return;
    if (viewName === 'result') dismissResult();
    else if (mg?.phase === 'lobby' && mg.readyPlayers.includes(slot)) callbacks.onCancel();
    opened = false;
    window.clearInterval(clockTimer);
    view?.dispose?.();
    view = null;
    viewName = null;
    overlay.classList.add('hidden');
    overlay.replaceChildren();
  }

  // A pointer-lock request already in flight may land after we open.
  document.addEventListener('pointerlockchange', () => {
    if (opened) releasePointer();
  });

  window.addEventListener(
    'keydown',
    (ev) => {
      if (!opened || ev.key !== 'Escape' || ev.defaultPrevented) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (viewName === 'unlimited' || viewName === 'lobby' || viewName === 'result') close();
    },
    true,
  );

  function header(title: string, closable: boolean): HTMLElement {
    return el(
      'div',
      { class: 'oracle-header' },
      el('h2', {}, title),
      closable &&
        el('button', { class: 'modal-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: close }, '✕'),
    );
  }

  // ==========================================================
  // Unlimited hints
  // ==========================================================
  function unlimitedView(): View {
    const PENDING_MS = 1500;
    let pending: { puzzleId: string; count: number; until: number } | null = null;

    const select = el('select', { class: 'oracle-select', id: 'unlimited-target' });
    select.addEventListener('change', () => {
      pickedPuzzle = select.value as PuzzleId;
      callbacks.onSfx('dial_click');
      update();
    });
    // Letters and arrows in the dropdown must not reach the game.
    select.addEventListener('keydown', (ev) => ev.stopPropagation());

    const revealBtn = el(
      'button',
      {
        class: 'btn-primary oracle-ready',
        onClick: () => {
          if (revealBtn.disabled) return;
          callbacks.onSfx('gear_place');
          // One click reveals one tier, so ignore further clicks until the server answers.
          pending = {
            puzzleId: select.value,
            count: hintsFor(select.value).length,
            until: Date.now() + PENDING_MS,
          };
          callbacks.onRequestUnlimitedHint((select.value || undefined) as PuzzleId | undefined);
          renderButton();
        },
      },
      'Reveal Next Hint',
    );
    const status = el('p', { class: 'oracle-status', role: 'status' });
    const list = el('div', { class: 'unlimited-hint-list', 'aria-live': 'polite' });
    const root = el(
      'div',
      { class: 'oracle-card unlimited-hints-view' },
      header('Hint Ledger', true),
      el(
        'p',
        { class: 'oracle-blurb' },
        'Unlimited hints are enabled for this session. Choose any unsolved mechanism to reveal progressive clues.',
      ),
      el(
        'label',
        { class: 'oracle-field', for: 'unlimited-target' },
        el('span', {}, 'Mechanism'),
        select,
      ),
      revealBtn,
      status,
      list,
    );

    /** Revealed hints for a puzzle, one per tier, gentlest first. */
    function hintsFor(puzzleId: string): HintEntry[] {
      const byTier = new Map<number, HintEntry>();
      for (const h of state?.unlockedHints ?? []) {
        if (h.puzzleId === puzzleId && !byTier.has(h.tier)) byTier.set(h.tier, h);
      }
      return [...byTier.values()].sort((a, b) => a.tier - b.tier);
    }

    let optionsKey = '';
    function renderOptions(): void {
      if (!state) return;
      const tracks = PUZZLE_HINTS.filter((t) => !state!.solvedPuzzles[t.puzzleId]).sort(
        (a, b) => a.order - b.order,
      );
      const labels = tracks.map(
        (t) => `${t.order}. ${t.title} — ${hintsFor(t.puzzleId).length}/3 hints revealed`,
      );
      const key = labels.join('|');
      if (key !== optionsKey) {
        optionsKey = key;
        select.replaceChildren(...tracks.map((t, i) => el('option', { value: t.puzzleId }, labels[i])));
      }
      // Stay on the player's choice until it is solved, then move on to the earliest unsolved one.
      const value = tracks.find((t) => t.puzzleId === pickedPuzzle)?.puzzleId ?? tracks[0]?.puzzleId;
      if (value && select.value !== value) select.value = value;
      select.disabled = tracks.length === 0;
    }

    function renderButton(): void {
      const count = hintsFor(select.value).length;
      if (
        pending &&
        (pending.puzzleId !== select.value || count > pending.count || Date.now() >= pending.until)
      ) {
        pending = null;
      }
      const allSolved = select.options.length === 0;
      revealBtn.disabled = allSolved || count >= 3 || pending !== null;
      const text = allSolved
        ? 'Every mechanism is solved.'
        : count >= 3
          ? 'All three hints for this mechanism are revealed.'
          : '';
      if (status.textContent !== text) status.textContent = text;
      status.classList.toggle('hidden', !text);
    }

    let listKey: string | null = null;
    function renderList(): void {
      const hints = hintsFor(select.value);
      const key = `${select.value}|${hints.map((h) => h.id).join(',')}`;
      if (key === listKey) return;
      listKey = key;
      list.replaceChildren(
        ...(hints.length > 0
          ? hints.map((h) =>
              el(
                'article',
                { class: 'unlimited-hint' },
                el('span', { class: `tier-badge tier-${h.tier}` }, `Tier ${h.tier}`),
                el('p', {}, h.text),
              ),
            )
          : select.options.length > 0
            ? [el('p', { class: 'unlimited-empty' }, 'No hints revealed for this mechanism yet.')]
            : []),
      );
      list.scrollTop = list.scrollHeight;
    }

    function update(): void {
      renderOptions();
      renderButton();
      renderList();
    }
    return { root, update, tick: renderButton };
  }

  // ==========================================================
  // Lobby
  // ==========================================================
  function lobbyView(): View {
    const select = el('select', { class: 'oracle-select', id: 'oracle-target' });
    select.addEventListener('change', () => {
      pickedPuzzle = select.value as PuzzleId;
      callbacks.onSfx('dial_click');
    });
    // Letters and arrows in the dropdown must not reach the game.
    select.addEventListener('keydown', (ev) => ev.stopPropagation());

    const readyBtn = el('button', {
      class: 'btn-primary oracle-ready',
      onClick: () => {
        if (!state || !mg || cooldownLeft() > 0) return;
        callbacks.onSfx('gear_place');
        if (mg.readyPlayers.includes(slot)) callbacks.onCancel();
        else callbacks.onReady((select.value || undefined) as PuzzleId | undefined);
      },
    });
    const lockNote = el('div', { class: 'oracle-cooldown' });
    const statusLine = el('p', { class: 'oracle-status', role: 'status' });
    const chips = ([1, 2] as PlayerSlot[]).map((s) => {
      const name = el('strong');
      const note = el('span');
      const root = el('div', { class: `ready-chip p${s}` }, el('i', { class: 'ready-lamp' }), name, note);
      return { s, root, name, note };
    });

    const role = (s: PlayerSlot, title: string, text: string): HTMLElement =>
      el(
        'div',
        { class: `role-card p${s}${s === slot ? ' mine' : ''}` },
        el('div', { class: 'role-title' }, s === slot ? `${title} (You)` : title),
        el('p', {}, text),
      );

    const root = el(
      'div',
      { class: 'oracle-card lobby' },
      header('The Clockwork Oracle', true),
      el(
        'p',
        { class: 'oracle-blurb' },
        'Complete the 35-second co-op challenge together for a 2-in-3 chance at a clue. 10-minute cooldown.',
      ),
      el(
        'div',
        { class: 'role-row' },
        role(1, 'Inner Ring', 'Catch gold sparks. Space widens arc.'),
        role(2, 'Outer Ring', 'Catch blue sparks. Space widens arc.'),
      ),
      el(
        'p',
        { class: 'oracle-controls-note' },
        'A / D or drag to steer · Block red cogs · Align both arcs on golden beams',
      ),
      el(
        'label',
        { class: 'oracle-field', for: 'oracle-target' },
        el('span', {}, 'Clue topic'),
        select,
      ),
      el('div', { class: 'ready-row' }, ...chips.map((c) => c.root)),
      lockNote,
      readyBtn,
      statusLine,
    );

    let optionsKey = '';
    function renderOptions(): void {
      if (!state) return;
      const tracks = [...PUZZLE_HINTS]
        .sort((a, b) => a.order - b.order)
        .filter((t) => !state!.solvedPuzzles[t.puzzleId]);
      const counts = tracks.map(
        (t) => state!.unlockedHints.filter((h) => h.puzzleId === t.puzzleId).length,
      );
      const key = tracks.map((t, i) => `${t.puzzleId}:${counts[i]}`).join(',');
      if (key !== optionsKey) {
        optionsKey = key;
        select.replaceChildren(
          ...tracks.map((t, i) =>
            el(
              'option',
              { value: t.puzzleId },
              `${t.order}. ${t.title}${counts[i] > 0 ? ` — ${Math.min(3, counts[i])}/3 scrolls won` : ''}`,
            ),
          ),
        );
      }
      const wanted = [pickedPuzzle, mg?.targetPuzzleId, tracks[0]?.puzzleId].find(
        (id) => id && tracks.some((t) => t.puzzleId === id),
      );
      // Once someone is ready, show the target that is actually locked in.
      const locked = mg?.phase === 'lobby' && mg.readyPlayers.length > 0 ? mg.targetPuzzleId : null;
      const iAmReady = !!mg?.readyPlayers.includes(slot);
      const value = iAmReady && locked ? locked : (pickedPuzzle ?? locked ?? wanted);
      const valid = value && tracks.some((t) => t.puzzleId === value) ? value : wanted;
      if (valid && select.value !== valid && document.activeElement !== select) select.value = valid;
      select.disabled = iAmReady || tracks.length === 0;
    }

    function update(): void {
      if (!state || !mg) return;
      renderOptions();
      const ready = mg.phase === 'lobby' ? mg.readyPlayers : [];
      for (const c of chips) {
        const on = ready.includes(c.s);
        c.name.textContent = `${nameOf(c.s)}${c.s === slot ? ' (you)' : ''}`;
        c.note.textContent = !isConnected(c.s) ? 'Not connected' : on ? 'Ready' : 'Not ready';
        c.root.classList.toggle('on', on);
      }
    }

    function tick(): void {
      if (!state || !mg) return;
      const left = cooldownLeft();
      const cooling = left > 0;
      const ready = mg.phase === 'lobby' ? mg.readyPlayers : [];
      const iAmReady = ready.includes(slot);
      const allSolved = select.options.length === 0;
      lockNote.classList.toggle('hidden', !cooling);
      if (cooling) lockNote.textContent = `The Oracle is recharging: ${formatDuration(left, true)}`;
      readyBtn.disabled = cooling || allSolved;
      readyBtn.classList.toggle('waiting', iAmReady);
      readyBtn.textContent = cooling
        ? `Locked · ${formatDuration(left, true)}`
        : iAmReady
          ? `Ready ${ready.length}/2 — click to stand down`
          : `Ready Up (${ready.length}/2)`;
      statusLine.textContent = allSolved
        ? 'Every mechanism is solved. The Oracle has nothing left to tell you!'
        : cooling
          ? 'Solve on while it winds back up. Your earlier scrolls are in the Field Notebook.'
          : !isConnected(partnerSlot())
            ? 'The Oracle needs both apprentices. Waiting for your partner to connect.'
            : iAmReady
              ? `Waiting for ${nameOf(partnerSlot())} to press H and ready up…`
              : ready.length > 0
                ? `${nameOf(partnerSlot())} is ready. Join in to begin at once!`
                : 'Both of you must ready up to begin.';
    }
    return { root, update, tick };
  }

  // ==========================================================
  // Playing
  // ==========================================================
  interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    max: number;
    color: string;
    size: number;
  }
  interface FloatText {
    x: number;
    y: number;
    text: string;
    color: string;
    life: number;
  }
  interface Wave {
    radius: number;
    color: string;
    life: number;
  }

  function playingView(): View {
    const canvas = el('canvas', {
      class: 'astrolabe',
      tabindex: 0,
      'aria-label': 'Astrolabe. Steer your arc with A and D or the arrow keys, press Space to pulse.',
    });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d')!;

    const timerText = el('span', { class: 'play-timer' });
    const timerFill = el('i');
    const chargeText = el('b');
    const chargeFill = el('i');
    const hearts = Array.from({ length: 6 }, () => el('span', { class: 'heart' }, '♥'));
    const integrityText = el('b');
    const syncBanner = el('div', { class: 'sync-banner', role: 'status' });
    const pulseBtn = el(
      'button',
      { class: `pulse-btn p${slot}`, onClick: () => firePulse() },
      el('span', {}, slot === 1 ? 'Steam Vent' : 'Magnet Pulse'),
      el('kbd', {}, 'Space'),
    );
    const root = el(
      'div',
      { class: 'oracle-card playing' },
      el(
        'div',
        { class: 'play-hud' },
        el('div', { class: 'play-stat' }, el('label', {}, 'Time'), timerText, el('div', { class: 'bar timer' }, timerFill)),
        el('div', { class: 'play-stat grow' }, el('label', {}, 'Aether Charge ', chargeText), el('div', { class: 'bar charge' }, chargeFill)),
        el('div', { class: 'play-stat' }, el('label', {}, 'Integrity ', integrityText), el('div', { class: 'hearts' }, ...hearts)),
      ),
      el('div', { class: 'astrolabe-wrap' }, canvas, syncBanner),
      el(
        'div',
        { class: 'play-foot' },
        el(
          'div',
          { class: `play-role p${slot}` },
          el('b', {}, slot === 1 ? 'You: Inner Brass Catcher' : 'You: Outer Crystal Deflector'),
          el('span', {}, slot === 1 ? 'Catch gold ★ · block red cogs' : 'Catch silver ◆ · block red cogs'),
        ),
        el('div', { class: 'play-keys' }, el('kbd', {}, 'A'), el('kbd', {}, 'D'), ' or drag'),
        pulseBtn,
      ),
    );

    const start = mg!;
    let myAngle = slot === 1 ? start.p1Angle : start.p2Angle;
    let partnerAngle = slot === 1 ? start.p2Angle : start.p1Angle;
    let velocity = 0;
    let left = false;
    let right = false;
    let dragAngle: number | null = null;
    let lastSent = 0;
    let lastSentAngle = Number.NaN;
    let localPulseAt = -10_000;
    let raf = 0;
    let lastFrame = performance.now();
    let shake = 0;
    let flash = 0;
    let coreGlow = 0;
    let prev: MinigameState = start;
    let lastSecond = -1;
    const pulses: Record<PlayerSlot, number> = { 1: -10_000, 2: -10_000 };
    const particles: Particle[] = [];
    const floats: FloatText[] = [];
    const waves: Wave[] = [];

    const at = (angle: number, radius: number): [number, number] => [
      CENTER + Math.cos(angle) * radius * UNIT,
      CENTER + Math.sin(angle) * radius * UNIT,
    ];

    function burst(x: number, y: number, color: string, count: number, power: number): void {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * TAU;
        const v = power * (0.3 + Math.random() * 0.7);
        const max = 0.35 + Math.random() * 0.4;
        particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color, size: 1.5 + Math.random() * 2.5 });
      }
      if (particles.length > 260) particles.splice(0, particles.length - 260);
    }

    function firePulse(): void {
      const now = performance.now();
      if (now - localPulseAt < PULSE_COOLDOWN_MS + 30) return;
      localPulseAt = now;
      startPulse(slot);
      callbacks.onSfx('valve_turn');
      lastSent = now;
      lastSentAngle = myAngle;
      callbacks.onInput(wrap(myAngle), true);
    }

    function startPulse(s: PlayerSlot): void {
      pulses[s] = performance.now();
      waves.push({ radius: s === 1 ? INNER_R : OUTER_R, color: s === 1 ? P1_COLOR : P2_COLOR, life: 1 });
    }

    // --- Input ---
    const isLeft = (k: string): boolean => k === 'a' || k === 'A' || k === 'ArrowLeft';
    const isRight = (k: string): boolean => k === 'd' || k === 'D' || k === 'ArrowRight';
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (isTypingTarget(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isLeft(ev.key)) left = true;
      else if (isRight(ev.key)) right = true;
      else if (ev.key === ' ') {
        if (!ev.repeat) firePulse();
      } else return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (isLeft(ev.key)) left = false;
      if (isRight(ev.key)) right = false;
      if (ev.key === ' ') ev.preventDefault();
    };
    const clearKeys = (): void => {
      left = right = false;
      dragAngle = null;
    };
    const pointerAngle = (ev: PointerEvent): number => {
      const r = canvas.getBoundingClientRect();
      return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2));
    };
    canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      dragAngle = pointerAngle(ev);
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (dragAngle !== null) dragAngle = pointerAngle(ev);
    });
    const endDrag = (): void => {
      dragAngle = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', clearKeys);

    function steer(dt: number): void {
      if (dragAngle !== null) {
        const gap = turnTo(myAngle, dragAngle);
        const step = Math.min(Math.abs(gap), DRAG_SPEED * dt);
        myAngle += Math.sign(gap) * step;
        velocity = 0;
        return;
      }
      const target = (Number(right) - Number(left)) * TURN_SPEED;
      velocity += (target - velocity) * Math.min(1, dt * 16);
      myAngle += velocity * dt;
    }

    function send(now: number): void {
      if (now - lastSent < SEND_MS) return;
      if (Math.abs(myAngle - lastSentAngle) < 0.004 && now - lastSent < 400) return;
      lastSent = now;
      lastSentAngle = myAngle;
      callbacks.onInput(wrap(myAngle));
    }

    // --- Diff server ticks into effects ---
    function sparkFx(sp: MinigameSpark): void {
      const nearOuter = Math.abs(sp.radius - OUTER_R) < 0.06;
      const nearInner = Math.abs(sp.radius - INNER_R) < 0.06;
      if (sp.radius < 0.2) {
        if (sp.kind === 'cog') {
          shake = 1;
          flash = 1;
          burst(CENTER, CENTER, '#ff6a4d', 34, 230);
          floats.push({ x: CENTER, y: CENTER - 24, text: 'JAMMED!', color: '#ff8a6b', life: 1 });
        } else {
          const [x, y] = at(sp.angle, 0.1);
          burst(x, y, 'rgba(244,232,207,0.6)', 6, 50);
        }
        return;
      }
      if (!nearOuter && !nearInner) return;
      const [x, y] = at(sp.angle, nearOuter ? OUTER_R : INNER_R);
      if (sp.kind === 'cog') {
        burst(x, y, '#ffae6b', 16, 170);
        floats.push({ x, y, text: 'Blocked', color: '#ffc38f', life: 0.8 });
      } else {
        burst(x, y, sp.kind === 'silver' ? '#e6f3ff' : '#ffd75e', 22, 190);
        floats.push({ x, y, text: '+1', color: sp.kind === 'silver' ? '#d8ecff' : '#ffe08a', life: 1 });
        coreGlow = 1;
      }
    }

    function update(): void {
      if (!mg) return;
      if (mg !== prev) {
        const alive = new Set(mg.sparks.map((s) => s.id));
        for (const sp of prev.sparks) if (!alive.has(sp.id)) sparkFx(sp);
        if (mg.syncCompleted > prev.syncCompleted && prev.syncTargetAngle !== null) {
          const [x, y] = at(prev.syncTargetAngle, (OUTER_R + INNER_R) / 2);
          burst(x, y, '#fff0b0', 60, 320);
          floats.push({ x, y, text: 'SYNC +3', color: '#fff0b0', life: 1.4 });
          coreGlow = 1.6;
        }
        const ps = partnerSlot();
        const key = ps === 1 ? 'p1PulseAt' : 'p2PulseAt';
        if (mg[key] !== prev[key] && mg[key] > 0) startPulse(ps);
        prev = mg;
      }
      const pct = Math.min(1, mg.score / Math.max(1, mg.targetScore));
      chargeText.textContent = `${Math.min(mg.score, mg.targetScore)} / ${mg.targetScore}`;
      chargeFill.style.width = `${pct * 100}%`;
      integrityText.textContent = `${Math.round(mg.integrity)}%`;
      // One Jam-Cog costs 18%, which is just over one of the six hearts.
      const heartsLeft = Math.ceil((mg.integrity / 100) * hearts.length);
      hearts.forEach((h, i) => h.classList.toggle('lost', i >= heartsLeft));
      const sync = mg.syncTargetAngle;
      syncBanner.classList.toggle('on', sync !== null);
      if (sync !== null) {
        const mine = Math.abs(turnTo(myAngle, sync)) < SYNC_TOLERANCE;
        const theirs = Math.abs(turnTo(partnerAngle, sync)) < SYNC_TOLERANCE;
        const text = mine
          ? theirs
            ? 'SYNC!'
            : `You're on the beam — waiting for ${nameOf(partnerSlot())}!`
          : 'Sync Beam! Both arcs to the golden light!';
        if (syncBanner.textContent !== text) syncBanner.textContent = text;
      }
    }

    function tickClock(): void {
      if (!mg) return;
      const remaining = Math.max(0, mg.endsAt - serverNow());
      const secs = Math.ceil(remaining / 1000);
      timerText.textContent = `${secs}s`;
      timerFill.style.width = `${(remaining / Math.max(1, mg.durationMs)) * 100}%`;
      timerText.classList.toggle('urgent', secs <= 8);
      if (secs !== lastSecond && secs <= 5 && secs > 0) callbacks.onSfx('dial_click');
      lastSecond = secs;
    }

    // --- Drawing ---
    const bgGradient = ctx.createRadialGradient(CENTER, CENTER, 10, CENTER, CENTER, 250);
    bgGradient.addColorStop(0, '#5a3a1c');
    bgGradient.addColorStop(0.42, '#33220f');
    bgGradient.addColorStop(1, '#1b140f');
    const brass = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    brass.addColorStop(0, '#f6dc9c');
    brass.addColorStop(0.35, '#d4a24c');
    brass.addColorStop(0.65, '#8f6424');
    brass.addColorStop(1, '#e9c377');

    function ring(radius: number, width: number, stroke: string | CanvasGradient, alpha = 1): void {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, radius, 0, TAU);
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawPlate(t: number): void {
      ctx.fillStyle = bgGradient;
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, 252, 0, TAU);
      ctx.fill();
      ring(246, 14, brass);
      ring(237, 2, '#4a3010');
      ctx.save();
      ctx.translate(CENTER, CENTER);
      ctx.rotate(t * 0.04);
      for (let i = 0; i < 72; i++) {
        const major = i % 6 === 0;
        ctx.rotate(TAU / 72);
        ctx.fillStyle = major ? '#f4e8cf' : 'rgba(244,232,207,0.35)';
        ctx.fillRect(major ? 217 : 224, -0.8, major ? 14 : 7, major ? 1.8 : 1.2);
      }
      ctx.restore();
      ctx.save();
      ctx.translate(CENTER, CENTER);
      ctx.rotate(-t * 0.06);
      ctx.strokeStyle = 'rgba(212,162,76,0.16)';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 8; i++) {
        ctx.rotate(TAU / 8);
        ctx.beginPath();
        ctx.arc(52, 0, 148, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
      ring(OUTER_R * UNIT, 18, P2_COLOR, 0.1);
      ring(INNER_R * UNIT, 18, P1_COLOR, 0.12);
      ring(OUTER_R * UNIT, 1, P2_COLOR, 0.4);
      ring(INNER_R * UNIT, 1, P1_COLOR, 0.45);
    }

    function drawCore(t: number): void {
      const charge = mg ? Math.min(1, mg.score / Math.max(1, mg.targetScore)) : 0;
      const r = 19 + Math.sin(t * 3) * 1.4 + charge * 6 + coreGlow * 5;
      const halo = ctx.createRadialGradient(CENTER, CENTER, 2, CENTER, CENTER, r * 3.1);
      halo.addColorStop(0, `rgba(255,236,170,${0.55 + charge * 0.4})`);
      halo.addColorStop(0.4, `rgba(245,185,66,${0.22 + charge * 0.3})`);
      halo.addColorStop(1, 'rgba(245,185,66,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, r * 3.1, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(CENTER, CENTER);
      ctx.rotate(t * 0.8);
      gearShape(12, r + 6, r + 1);
      ctx.fillStyle = brass;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, r - 4, 0, TAU);
      ctx.fillStyle = flash > 0.2 ? '#ff7a52' : '#fff3c9';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, r + 13, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#62d69c';
      ctx.stroke();
    }

    function gearShape(teeth: number, outer: number, inner: number): void {
      ctx.beginPath();
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * TAU;
        const s = TAU / teeth;
        ctx.lineTo(Math.cos(a - s * 0.28) * inner, Math.sin(a - s * 0.28) * inner);
        ctx.lineTo(Math.cos(a - s * 0.16) * outer, Math.sin(a - s * 0.16) * outer);
        ctx.lineTo(Math.cos(a + s * 0.16) * outer, Math.sin(a + s * 0.16) * outer);
        ctx.lineTo(Math.cos(a + s * 0.28) * inner, Math.sin(a + s * 0.28) * inner);
      }
      ctx.closePath();
    }

    function starShape(points: number, outer: number, inner: number): void {
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = (i / (points * 2)) * TAU - Math.PI / 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
    }

    function drawArc(s: PlayerSlot, angle: number, now: number, t: number): void {
      const mine = s === slot;
      const radius = (s === 1 ? INNER_R : OUTER_R) * UNIT;
      const pulsing = now - pulses[s] < PULSE_MS;
      const half = ARC_HALF + (pulsing ? PULSE_BONUS : 0);
      const color = s === 1 ? P1_COLOR : P2_COLOR;
      ctx.lineCap = 'round';
      if (mine) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 22 + Math.sin(t * 5) * 5;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, radius, angle - half, angle + half);
        ctx.lineWidth = 17;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, radius, angle - half, angle + half);
      ctx.lineWidth = 15;
      ctx.strokeStyle = s === 1 ? '#a8721f' : '#2d6da6';
      ctx.stroke();
      ctx.lineWidth = 10;
      ctx.strokeStyle = pulsing ? '#fffbe8' : color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, radius + 2.5, angle - half * 0.94, angle + half * 0.94);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();
      // Name tag
      const tagR = radius - 22;
      const x = CENTER + Math.cos(angle) * tagR;
      const y = CENTER + Math.sin(angle) * tagR;
      ctx.font = `700 ${mine ? 13 : 11}px "Avenir Next", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(27,20,15,0.85)';
      const tag = mine ? 'YOU' : `P${s}`;
      ctx.strokeText(tag, x, y);
      ctx.fillStyle = mine ? '#fff7de' : 'rgba(244,232,207,0.75)';
      ctx.fillText(tag, x, y);
    }

    function drawSpark(sp: MinigameSpark, radius: number, t: number): void {
      const [x, y] = at(sp.angle, radius);
      const color = sp.kind === 'cog' ? '#ff6a4d' : sp.kind === 'silver' ? '#e3f0ff' : '#ffd75e';
      // Landing marker on the ring(s) that can still stop it
      const rings =
        sp.kind === 'gold'
          ? [INNER_R]
          : sp.kind === 'silver'
            ? [OUTER_R]
            : [OUTER_R, INNER_R];
      for (const r of rings) {
        if (radius <= r) continue;
        ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, 1 - (radius - r) / 0.5);
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, r * UNIT, sp.angle - 0.06, sp.angle + 0.06);
        ctx.lineCap = 'butt';
        ctx.lineWidth = 20;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      // Comet trail
      const [tx, ty] = at(sp.angle, Math.min(1.1, radius + 0.17));
      const trail = ctx.createLinearGradient(x, y, tx, ty);
      trail.addColorStop(0, color);
      trail.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tx, ty);
      ctx.lineCap = 'round';
      ctx.lineWidth = sp.kind === 'cog' ? 7 : 5;
      ctx.strokeStyle = trail;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * (sp.kind === 'cog' ? 4 : 1.6) + sp.id);
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      if (sp.kind === 'cog') {
        gearShape(8, 13, 9);
        ctx.fillStyle = '#d8402a';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, TAU);
        ctx.fillStyle = '#2a0f08';
        ctx.fill();
      } else {
        starShape(sp.kind === 'silver' ? 4 : 5, 12, sp.kind === 'silver' ? 5 : 5.4);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = sp.kind === 'silver' ? '#5f93c4' : '#a8721f';
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawSync(angle: number, t: number): void {
      ctx.save();
      ctx.translate(CENTER, CENTER);
      ctx.rotate(angle);
      const beam = ctx.createLinearGradient(20, 0, 238, 0);
      beam.addColorStop(0, 'rgba(255,200,70,0.25)');
      beam.addColorStop(0.5, 'rgba(255,200,70,0.55)');
      beam.addColorStop(1, 'rgba(255,224,120,0.9)');
      ctx.globalAlpha = 0.55 + Math.sin(t * 8) * 0.2;
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 238, -SYNC_TOLERANCE, SYNC_TOLERANCE);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff0b0';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = t * 60;
      ctx.beginPath();
      ctx.moveTo(26, 0);
      ctx.lineTo(236, 0);
      ctx.stroke();
      ctx.restore();
    }

    function drawEffects(dt: number): void {
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        w.life -= dt * 2.4;
        if (w.life <= 0) {
          waves.splice(i, 1);
          continue;
        }
        ring((w.radius + (1 - w.life) * 0.16) * UNIT, 5 * w.life, w.color, w.life);
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - 2.4 * dt;
        p.vy *= 1 - 2.4 * dt;
        ctx.globalAlpha = p.life / p.max;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i];
        f.life -= dt;
        if (f.life <= 0) {
          floats.splice(i, 1);
          continue;
        }
        f.y -= 34 * dt;
        ctx.globalAlpha = Math.min(1, f.life * 2);
        ctx.font = '800 18px "Avenir Next", "Segoe UI", system-ui, sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(27,20,15,0.9)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function frame(now: number): void {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
      lastFrame = now;
      if (!mg || mg.phase !== 'playing') return;
      const t = now / 1000;

      steer(dt);
      send(now);
      const serverPartner = slot === 1 ? mg.p2Angle : mg.p1Angle;
      partnerAngle += turnTo(partnerAngle, serverPartner) * Math.min(1, dt * 18);
      shake = Math.max(0, shake - dt * 2.6);
      flash = Math.max(0, flash - dt * 2);
      coreGlow = Math.max(0, coreGlow - dt * 1.8);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (shake > 0 && !calm) {
        ctx.translate((Math.random() - 0.5) * 14 * shake, (Math.random() - 0.5) * 14 * shake);
      }
      drawPlate(t);
      if (mg.syncTargetAngle !== null) drawSync(mg.syncTargetAngle, t);
      // Sparks drift on between 20Hz ticks, so they glide instead of stepping.
      const ahead = Math.min(0.12, (now - tickArrivedAt) / 1000);
      for (const sp of mg.sparks) drawSpark(sp, Math.max(0.08, sp.radius - sp.speed * ahead), t);
      drawCore(t);
      const p1 = slot === 1 ? myAngle : partnerAngle;
      const p2 = slot === 2 ? myAngle : partnerAngle;
      if (slot === 1) {
        drawArc(2, p2, now, t);
        drawArc(1, p1, now, t);
      } else {
        drawArc(1, p1, now, t);
        drawArc(2, p2, now, t);
      }
      drawEffects(dt);
      if (flash > 0) {
        ctx.globalAlpha = flash * 0.28;
        ctx.fillStyle = '#ff4d2e';
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, 252, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      pulseBtn.classList.toggle('cooling', now - localPulseAt < PULSE_COOLDOWN_MS);
    }
    raf = requestAnimationFrame(frame);
    window.setTimeout(() => canvas.focus({ preventScroll: true }), 0);

    return {
      root,
      update,
      tick: tickClock,
      dispose: () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', clearKeys);
      },
    };
  }

  // ==========================================================
  // Caskets
  // ==========================================================
  let casketSerial = 0;

  function casketArt(): SVGSVGElement {
    const id = `casket-brass-${++casketSerial}`;
    const art = svg('svg', { viewBox: '0 0 160 150', class: 'casket-art', 'aria-hidden': 'true' });
    art.append(
      svg(
        'defs',
        {},
        svg(
          'linearGradient',
          { id, x1: '0', y1: '0', x2: '0', y2: '1' },
          svg('stop', { offset: '0%', 'stop-color': '#f7dd9a' }),
          svg('stop', { offset: '50%', 'stop-color': '#d4a24c' }),
          svg('stop', { offset: '100%', 'stop-color': '#8a5c1e' }),
        ),
      ),
      svg('ellipse', { cx: 80, cy: 142, rx: 62, ry: 7, fill: 'rgba(0,0,0,0.35)' }),
      svg('rect', { x: 22, y: 64, width: 116, height: 16, fill: '#1b0f06' }),
      svg(
        'g',
        { class: 'casket-lid' },
        svg('path', { d: 'M18,72 Q18,24 80,24 Q142,24 142,72Z', fill: `url(#${id})`, stroke: '#5c3a0f', 'stroke-width': 3 }),
        svg('path', { d: 'M36,72 Q36,38 80,38 Q124,38 124,72', fill: 'none', stroke: '#7a5117', 'stroke-width': 3 }),
        svg('path', { d: 'M80,28 l5,10 11,1 -8,7 2,11 -10,-6 -10,6 2,-11 -8,-7 11,-1z', fill: '#fff0b0', stroke: '#8a5c1e' }),
      ),
      svg('rect', { x: 18, y: 72, width: 124, height: 64, rx: 6, fill: `url(#${id})`, stroke: '#5c3a0f', 'stroke-width': 3 }),
      svg('rect', { x: 28, y: 82, width: 104, height: 44, rx: 4, fill: '#3b2611', stroke: '#7a5117', 'stroke-width': 2 }),
      svg('circle', { cx: 80, cy: 104, r: 15, fill: `url(#${id})`, stroke: '#5c3a0f', 'stroke-width': 2 }),
      svg('path', { d: 'M80,97 a5,5 0 0 1 3,9 l2,8 h-10 l2,-8 a5,5 0 0 1 3,-9z', fill: '#1b0f06' }),
      ...[
        [26, 80],
        [134, 80],
        [26, 128],
        [134, 128],
      ].map(([cx, cy]) => svg('circle', { cx, cy, r: 4, fill: '#f7dd9a', stroke: '#5c3a0f' })),
    );
    return art;
  }

  // ==========================================================
  // Fate Draw
  // ==========================================================
  function fateView(): View {
    const SHUFFLE_MS = 1800;
    const STEPS = 9;
    let ready = false;
    const timers: number[] = [];

    const prompt = el('p', { class: 'fate-prompt', role: 'status' });
    const cards = CASKET_NAMES.map((name, i) => {
      const votes = el('div', { class: 'casket-votes' });
      const btn = el(
        'button',
        {
          class: 'casket',
          disabled: true,
          'aria-label': `${name} casket`,
          onClick: () => {
            if (!ready || !mg || mg.phase !== 'fate_draw') return;
            callbacks.onSfx('gear_place');
            callbacks.onPickCasket(i as 0 | 1 | 2);
          },
        },
        casketArt(),
        el('span', { class: 'casket-name' }, name),
        votes,
      );
      return { btn, votes };
    });
    const row = el('div', { class: 'casket-row' }, ...cards.map((c) => c.btn));
    const root = el(
      'div',
      { class: 'oracle-card fate' },
      header('Fate Draw', false),
      el(
        'p',
        { class: 'fate-banner' },
        'ORACLE CHARGED! Two caskets hold a Radiant Clue Scroll, one holds only Golden Steam (2/3 odds). Both apprentices pick a casket!',
      ),
      row,
      prompt,
    );

    function update(): void {
      if (!mg) return;
      cards.forEach((c, i) => {
        const chips = ([1, 2] as PlayerSlot[])
          .filter((s) => mg!.casketVotes[s] === i)
          .map((s) => el('span', { class: `vote-chip p${s}` }, s === slot ? 'Your pick' : `${nameOf(s)}'s pick`));
        c.votes.replaceChildren(...chips);
        c.btn.classList.toggle('mine', mg!.casketVotes[slot] === i);
        c.btn.classList.toggle('theirs', mg!.casketVotes[partnerSlot()] === i);
        c.btn.disabled = !ready;
      });
      row.classList.toggle('shuffling', !ready);
      const mine = mg.casketVotes[slot];
      const theirs = mg.casketVotes[partnerSlot()];
      prompt.textContent = !ready
        ? 'The caskets are shuffling…'
        : mine === undefined
          ? theirs === undefined
            ? 'Choose a casket. If you disagree, the Oracle picks one of your two choices.'
            : `${nameOf(partnerSlot())} chose the ${CASKET_NAMES[theirs]} casket. Your turn!`
          : `You chose ${CASKET_NAMES[mine]}. Waiting for ${nameOf(partnerSlot())}…`;
    }

    function finishShuffle(): void {
      ready = true;
      for (const c of cards) c.btn.style.transform = '';
      update();
    }

    function shuffle(): void {
      const spacing = cards[1].btn.offsetLeft - cards[0].btn.offsetLeft;
      let order = [0, 1, 2]; // order[card] = position on the table
      for (let n = 1; n < STEPS; n++) {
        timers.push(
          window.setTimeout(
            () => {
              if (n === STEPS - 1) {
                order = [0, 1, 2];
              } else {
                const a = Math.floor(Math.random() * 3);
                const b = (a + 1 + Math.floor(Math.random() * 2)) % 3;
                [order[a], order[b]] = [order[b], order[a]];
              }
              callbacks.onSfx('dial_click');
              cards.forEach((c, i) => {
                const dx = (order[i] - i) * spacing;
                const lift = n === STEPS - 1 ? 0 : (i % 2 === 0 ? -1 : 1) * 14;
                c.btn.style.transform = `translate(${dx}px, ${lift}px)`;
              });
            },
            n * (SHUFFLE_MS / STEPS),
          ),
        );
      }
      timers.push(window.setTimeout(finishShuffle, SHUFFLE_MS));
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timers.push(window.setTimeout(finishShuffle, 300));
    } else {
      timers.push(window.setTimeout(shuffle, 0)); // after mount, so positions can be measured
    }
    return { root, update, dispose: () => timers.forEach((t) => window.clearTimeout(t)) };
  }

  // ==========================================================
  // Result
  // ==========================================================
  function resultView(result: MinigameState): View {
    const timers: number[] = [];
    const later = (ms: number, fn: () => void): void => {
      timers.push(window.setTimeout(fn, ms));
    };
    const drew = result.chosenCasket !== null;
    const won = result.wonClue === true;
    const hint = result.awardedHint;
    const cooldown = el('b', { class: 'cooldown-clock' });

    const cards = drew
      ? CASKET_NAMES.map((name, i) => {
          const wins = result.winningCaskets.includes(i);
          const chosen = result.chosenCasket === i;
          return el(
            'div',
            { class: `casket reveal ${wins ? 'wins' : 'steam'}${chosen ? ' chosen' : ''}` },
            el('span', { class: 'casket-content' }, wins ? '📜' : '💨'),
            casketArt(),
            el('span', { class: 'casket-name' }, name),
            el(
              'div',
              { class: 'casket-votes' },
              el('span', { class: 'vote-chip content-chip' }, wins ? 'Clue Scroll' : 'Clockwork Steam'),
              chosen && el('span', { class: 'vote-chip drawn' }, 'Drawn'),
            ),
          );
        })
      : [];

    const prize =
      won && hint
        ? el(
            'article',
            { class: 'golden-scroll' },
            el(
              'div',
              { class: 'scroll-head' },
              el('span', { class: `tier-badge tier-${hint.tier}` }, `Tier ${hint.tier}`),
              el('h3', {}, hint.puzzleTitle),
            ),
            el('p', { class: 'scroll-text' }, hint.text),
            el('div', { class: 'saved-badge' }, '✓ Saved to Field Notebook → Oracle Hints'),
          )
        : el(
            'div',
            { class: `steam-panel${won ? ' calm' : ''}` },
            el('span', { class: 'steam-icon' }, won ? '☀' : '💨'),
            el('p', {}, result.resultMessage || 'The Oracle sighs a cloud of warm golden steam.'),
            !won &&
              el(
                'small',
                {},
                drew
                  ? 'You beat the challenge. Only the draw went against you!'
                  : 'So close! Call out which side each spark lands on, and split the cogs between you.',
              ),
          );
    const reveal = el('div', { class: 'result-reveal' }, prize);

    const root = el(
      'div',
      { class: `oracle-card result ${won ? 'won' : 'lost'}` },
      header(won ? 'A Radiant Clue Scroll!' : drew ? 'Only Golden Steam…' : 'The Gears Wind Down', true),
      drew && el('div', { class: 'casket-row' }, ...cards),
      reveal,
      el('p', { class: 'oracle-cooldown soft' }, 'The Oracle recharges in ', cooldown),
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn-primary', onClick: close }, 'Return to the manor'),
      ),
    );

    if (drew) {
      // Drawn casket first, then the two that were left behind.
      later(500, () => cards[result.chosenCasket!].classList.add('open'));
      later(1300, () => cards.forEach((c) => c.classList.add('open')));
      later(1500, () => reveal.classList.add('shown'));
    } else {
      later(50, () => reveal.classList.add('shown'));
    }
    return {
      root,
      update() {
        /* the result is fixed once drawn */
      },
      tick() {
        const left = cooldownLeft();
        cooldown.textContent = left > 0 ? formatDuration(left, true) : 'now — it is ready again!';
      },
      dispose: () => timers.forEach((t) => window.clearTimeout(t)),
    };
  }

  // ==========================================================
  // Controller
  // ==========================================================
  return {
    isOpen: () => opened,
    open,
    close,
    updateState(nextState, mySlot) {
      state = nextState;
      mg = nextState.minigame;
      slot = mySlot;
      tickArrivedAt = performance.now();
      render();
    },
    updateTick(minigame, mySlot, serverTime) {
      clockOffset = serverTime - Date.now();
      slot = mySlot;
      mg = minigame;
      tickArrivedAt = performance.now();
      render();
    },
  };
}
