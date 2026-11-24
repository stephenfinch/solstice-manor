import {
  CIPHER_SYMBOLS,
  ITEMS,
  SOLUTIONS,
  WORLD_CLUES,
  computeGearSpeeds,
  computeIrrigationGauges,
} from '../../shared/puzzles.js';
import type {
  CardinalDir,
  CipherSymbol,
  ItemId,
  PlayerSlot,
  WorldState,
} from '../../shared/types.js';
import { byId, el, isShown, releasePointer, svg } from './hud.js';

export interface ModalController {
  isOpen(): boolean;
  openModal(modalId: string, state: WorldState): void;
  openClue(clueId: string, state: WorldState): void;
  refreshIfOpen(state: WorldState): void;
  close(): void;
}

interface ModalCallbacks {
  onInteract: (targetId: string, payload?: Record<string, unknown>) => void;
  onPlayOrganPipe: (length: number) => void;
  onClickSound: () => void;
  onClose: () => void;
}

/** A mounted puzzle. `update` patches the live DOM so partner edits animate in place. */
interface View {
  title: string;
  root: HTMLElement;
  size?: 'wide' | 'narrow';
  update(state: WorldState): void;
  dispose?(): void;
}

type Triple = [number, number, number];
type Quad = [number, number, number, number];
type Quint = [number, number, number, number, number];

// ============================================================
// Parchment text (also used by the Field Notebook)
// ============================================================
export function renderClueBody(body: string): HTMLElement {
  const box = el('div', { class: 'clue-body' });
  let grid: HTMLElement | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      grid = null;
      continue;
    }
    const cells = [...line.matchAll(/\[(\w\d):\s*(\S+)\s+(\w+)\]/g)];
    if (cells.length > 1) {
      if (!grid) {
        grid = el('div', { class: 'clue-grid' });
        box.append(el('div', { class: 'clue-compass' }, '▲ North'), grid);
      }
      for (const [, ref, glyph, label] of cells) {
        grid.append(
          el(
            'div',
            { class: 'clue-cell' },
            el('span', { class: 'cell-ref' }, ref),
            el('span', { class: 'cell-glyph' }, glyph),
            el('span', { class: 'cell-label' }, label),
          ),
        );
      }
      continue;
    }
    const item = /^(\d+\.|•|Step \d+:)\s+(.*)$/.exec(line);
    if (item) {
      box.append(
        el(
          'div',
          { class: 'clue-item' },
          el('span', { class: 'clue-marker' }, item[1] === '•' ? '✦' : item[1]),
          el('span', {}, item[2]),
        ),
      );
      continue;
    }
    const letters = line.replace(/[^A-Za-z]/g, '');
    const upper = line.replace(/[^A-Z]/g, '');
    if (letters.length > 6 && upper.length / letters.length > 0.6 && line.length < 110) {
      box.append(el('div', { class: 'clue-heading' }, line));
    } else if (line.startsWith('"')) {
      box.append(el('blockquote', {}, line));
    } else if (raw.startsWith('    ')) {
      box.append(el('div', { class: 'clue-formula' }, line));
    } else {
      box.append(el('p', {}, line));
    }
  }
  return box;
}

// ============================================================
// Shared building blocks
// ============================================================

/**
 * Local copy of a server value. Edits show instantly and rapid clicks build on
 * each other instead of on a stale echo; the server value wins once edits stop.
 */
class Shadow<T> {
  value: T;
  private server: T;
  private lastEdit = 0;
  private timer = 0;

  constructor(
    initial: T,
    private readonly onChange: () => void,
  ) {
    this.value = initial;
    this.server = initial;
  }

  edit(next: T): void {
    this.value = next;
    this.lastEdit = Date.now();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.value = this.server;
      this.onChange();
    }, 600);
    this.onChange();
  }

  sync(server: T): void {
    this.server = server;
    if (Date.now() - this.lastEdit > 450) this.value = server;
  }

  dispose(): void {
    window.clearTimeout(this.timer);
  }
}

function withAt<T extends readonly unknown[]>(arr: T, index: number, value: T[number]): T {
  const copy = [...arr];
  copy[index] = value;
  return copy as unknown as T;
}

/** Signed shortest step between two positions on a ring of `n`. */
function shortestStep(from: number, to: number, n: number): number {
  return ((((to - from + n / 2) % n) + n) % n) - n / 2;
}

const mod = (v: number, n: number): number => ((v % n) + n) % n;

function solvedBadge(text: string): { node: HTMLElement; set(on: boolean): void } {
  const node = el(
    'div',
    { class: 'solved-badge hidden', role: 'status' },
    el('span', { class: 'solved-seal' }, '✓'),
    el('span', {}, text),
  );
  return { node, set: (on) => node.classList.toggle('hidden', !on) };
}

function stepButton(label: string, aria: string, onClick: () => void): HTMLButtonElement {
  return el('button', { class: 'brass-step', 'aria-label': aria, onClick }, label);
}

function onWheelStep(node: Element, step: (delta: 1 | -1) => void): void {
  let last = 0;
  node.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const now = performance.now();
      const dy = (ev as WheelEvent).deltaY;
      if (now - last < 90 || Math.abs(dy) < 4) return;
      last = now;
      step(dy > 0 ? 1 : -1);
    },
    { passive: false },
  );
}

/** A 3D rotary drum: click the arrows, scroll, or focus it and use the arrow keys. */
function createDrum(
  faces: HTMLElement[],
  faceHeight: number,
  ariaLabel: string,
  onStep: (delta: 1 | -1) => void,
): { root: HTMLElement; set(index: number, text: string): void } {
  const n = faces.length;
  const stepDeg = 360 / n;
  const radius = faceHeight / 2 / Math.tan(Math.PI / n);
  const drum = el('div', { class: 'drum' });
  faces.forEach((face, i) => {
    face.classList.add('drum-face');
    face.style.height = `${faceHeight}px`;
    face.style.transform = `translateY(-50%) rotateX(${-i * stepDeg}deg) translateZ(${radius}px)`;
    drum.append(face);
  });
  const windowBox = el(
    'div',
    {
      class: 'drum-window',
      tabindex: 0,
      role: 'spinbutton',
      'aria-label': ariaLabel,
    },
    drum,
    el('div', { class: 'drum-shade' }),
  );
  windowBox.style.setProperty('--face', `${faceHeight}px`);
  const root = el(
    'div',
    { class: 'drum-unit' },
    stepButton('▲', `${ariaLabel} up`, () => onStep(1)),
    windowBox,
    stepButton('▼', `${ariaLabel} down`, () => onStep(-1)),
  );
  onWheelStep(windowBox, onStep);
  windowBox.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    ev.stopPropagation();
    onStep(ev.key === 'ArrowUp' ? 1 : -1);
  });
  let turn: number | null = null;
  return {
    root,
    set(index, text) {
      turn = turn === null ? index : turn + shortestStep(mod(turn, n), index, n);
      drum.style.transform = `translateZ(${-radius}px) rotateX(${turn * stepDeg}deg)`;
      windowBox.setAttribute('aria-valuetext', text);
    },
  };
}

function digitFaces(): HTMLElement[] {
  return Array.from({ length: 10 }, (_, d) => el('div', { class: 'digit-face' }, d));
}

/** − value + stepper used by the sundial and orrery. */
function createStepper(
  label: string,
  color: string,
  onStep: (delta: 1 | -1) => void,
): { root: HTMLElement; set(value: number): void } {
  const value = el('span', { class: 'stepper-value' }, '1');
  const root = el(
    'div',
    { class: 'stepper' },
    el('span', { class: 'stepper-label' }, el('i', { class: 'stepper-swatch' }), label),
    stepButton('−', `${label} minus one`, () => onStep(-1)),
    value,
    stepButton('+', `${label} plus one`, () => onStep(1)),
  );
  root.style.setProperty('--swatch', color);
  onWheelStep(root, onStep);
  return {
    root,
    set: (v) => {
      value.textContent = String(v);
    },
  };
}

function intro(text: string): HTMLElement {
  return el('p', { class: 'modal-intro' }, text);
}

function gearPath(teeth: number, outer: number, depth: number): string {
  const inner = outer - depth;
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const at = (r: number, frac: number): string =>
      `${(Math.cos(a + step * frac) * r).toFixed(2)},${(Math.sin(a + step * frac) * r).toFixed(2)}`;
    pts.push(at(inner, -0.5), at(inner, -0.27), at(outer, -0.15), at(outer, 0.15), at(inner, 0.27));
  }
  return `M${pts.join('L')}Z`;
}

const polar = (r: number, deg: number): [number, number] => [
  Math.cos((deg * Math.PI) / 180) * r,
  Math.sin((deg * Math.PI) / 180) * r,
];

// ============================================================
// P1 — Awakening Clock
// ============================================================
function clockView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const readout = el('div', { class: 'clock-readout', 'aria-live': 'polite' });
  const hourHand = svg('line', { x1: 0, y1: 8, x2: 0, y2: -34, class: 'hand hand-hour' });
  const minuteHand = svg('line', { x1: 0, y1: 10, x2: 0, y2: -52, class: 'hand hand-minute' });
  const face = svg('svg', { viewBox: '-80 -80 160 160', class: 'clock-face', 'aria-hidden': 'true' });
  face.append(
    svg('circle', { r: 76, class: 'bezel' }),
    svg('circle', { r: 66, class: 'dial-plate' }),
    ...Array.from({ length: 12 }, (_, i) => {
      const [x1, y1] = polar(56, i * 30);
      const [x2, y2] = polar(62, i * 30);
      return svg('line', { x1, y1, x2, y2, class: i % 3 === 0 ? 'tick major' : 'tick' });
    }),
    hourHand,
    minuteHand,
    svg('circle', { r: 5, class: 'hub' }),
  );
  const badge = solvedBadge('The clock chimes. The Twin Courtyard Levers are energized!');
  const commit = (index: number, delta: number): void => {
    if (solved) return;
    const digits = withAt(shadow.value, index, mod(shadow.value[index] + delta, 10));
    shadow.edit(digits);
    cb.onInteract('p1_clock_set', { digits });
  };
  const names = ['Hour tens (A)', 'Hour ones (B)', 'Minute tens (C)', 'Minute ones (D)'];
  const drums = names.map((name, i) => createDrum(digitFaces(), 76, name, (d) => commit(i, d)));
  const controls = el(
    'div',
    { class: 'controls drum-row' },
    ...drums.flatMap((d, i) => [
      i === 2 ? el('div', { class: 'drum-colon' }, ':') : null,
      el('div', { class: 'drum-col' }, d.root, el('span', { class: 'drum-tag' }, 'ABCD'[i])),
    ]),
  );
  const root = el(
    'div',
    { class: 'puzzle puzzle-clock' },
    badge.node,
    intro('Turn the four brass wheels to the awakening hour. The ledger on the lectern holds the rules.'),
    el('div', { class: 'clock-top' }, face, readout),
    controls,
  );
  const shadow = new Shadow<Quad>(initial.puzzles.clockDigits, render);
  function render(): void {
    const [a, b, c, d] = shadow.value;
    drums.forEach((drum, i) => drum.set(shadow.value[i], String(shadow.value[i])));
    readout.textContent = `${a}${b}:${c}${d}`;
    const hours = a * 10 + b;
    const mins = c * 10 + d;
    hourHand.style.transform = `rotate(${hours * 30 + mins * 0.5}deg)`;
    minuteHand.style.transform = `rotate(${mins * 6}deg)`;
  }
  return {
    title: 'The Awakening Clock',
    root,
    update(state) {
      solved = state.solvedPuzzles.p1_foyer_clock;
      shadow.sync(state.puzzles.clockDigits);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P2 — Split-Booth Cipher
// ============================================================
function cipherView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const n = CIPHER_SYMBOLS.length;
  const indexOf = (s: CipherSymbol): number =>
    Math.max(
      0,
      CIPHER_SYMBOLS.findIndex((c) => c.id === s),
    );
  const badge = solvedBadge('Cipher accepted. The Supply Cabinet and the North Booth grille are open!');
  const commit = (i: number, delta: number): void => {
    if (solved) return;
    const next = CIPHER_SYMBOLS[mod(indexOf(shadow.value[i]) + delta, n)].id;
    const dials = withAt(shadow.value, i, next);
    shadow.edit(dials);
    cb.onInteract('p2_cipher_set', { dials });
  };
  const labels = [0, 1, 2, 3].map(() => el('span', { class: 'cipher-label' }));
  const drums = [0, 1, 2, 3].map((i) =>
    createDrum(
      CIPHER_SYMBOLS.map((c) => el('div', { class: `glyph-face glyph-${c.id}` }, c.glyph)),
      92,
      `Dial ${i + 1}`,
      (d) => commit(i, d),
    ),
  );
  const root = el(
    'div',
    { class: 'puzzle puzzle-cipher' },
    badge.node,
    intro('Only the North Booth can see the mural. Have your partner read the four emblems through the glass.'),
    el(
      'div',
      { class: 'controls drum-row' },
      ...drums.map((d, i) =>
        el(
          'div',
          { class: 'drum-col' },
          el('span', { class: 'drum-tag' }, `Dial ${i + 1}`),
          d.root,
          labels[i],
        ),
      ),
    ),
  );
  const shadow = new Shadow(initial.puzzles.teaCipherDials, render);
  function render(): void {
    shadow.value.forEach((sym, i) => {
      const idx = indexOf(sym);
      drums[i].set(idx, CIPHER_SYMBOLS[idx].label);
      labels[i].textContent = CIPHER_SYMBOLS[idx].label;
    });
  }
  return {
    title: 'Split-Booth Cipher Console',
    root,
    update(state) {
      solved = state.solvedPuzzles.p2_tea_cipher;
      shadow.sync(state.puzzles.teaCipherDials);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P3 — Apothecary Tea Balance
// ============================================================
type Tea = 'amber' | 'jade' | 'rose' | 'mint';
const TEAS: { id: Tea; label: string; color: string }[] = [
  { id: 'amber', label: 'Amber', color: '#e89a2c' },
  { id: 'jade', label: 'Jade', color: '#3fa374' },
  { id: 'rose', label: 'Rose', color: '#d9657f' },
  { id: 'mint', label: 'Mint', color: '#74c9b4' },
];

function teaView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const badge = solvedBadge('Perfect blend! A secret drawer slides open — check your Notebook.');

  let sendTimer = 0;
  const send = (): void => {
    if (sendTimer) return;
    sendTimer = window.setTimeout(() => {
      sendTimer = 0;
      if (!solved) cb.onInteract('p3_tea_set', { weights: { ...shadow.value } });
    }, 80);
  };
  const setWeight = (id: Tea, grams: number): void => {
    if (solved) return;
    const g = Math.max(1, Math.min(15, Math.round(grams)));
    if (g === shadow.value[id]) return;
    shadow.edit({ ...shadow.value, [id]: g });
    send();
  };

  const canisters = TEAS.map((tea) => {
    const grams = el('span', { class: 'tea-grams' });
    const fill = el('div', { class: 'tea-fill' });
    const slider = el('input', {
      type: 'range',
      min: 1,
      max: 15,
      step: 1,
      class: 'tea-slider',
      'aria-label': `${tea.label} grams`,
    });
    slider.addEventListener('input', () => setWeight(tea.id, Number(slider.value)));
    const root = el(
      'div',
      { class: 'tea-canister' },
      el('div', { class: 'tea-name' }, tea.label),
      el('div', { class: 'tea-jar' }, fill, grams),
      slider,
      el(
        'div',
        { class: 'tea-steps' },
        stepButton('−', `${tea.label} minus one gram`, () => setWeight(tea.id, shadow.value[tea.id] - 1)),
        stepButton('+', `${tea.label} plus one gram`, () => setWeight(tea.id, shadow.value[tea.id] + 1)),
      ),
    );
    root.style.setProperty('--tea', tea.color);
    onWheelStep(root, (d) => setWeight(tea.id, shadow.value[tea.id] - d));
    return { id: tea.id, root, grams, fill, slider };
  });

  // Two-pan balance
  const ARM = 118;
  const beam = svg(
    'g',
    { class: 'scale-beam' },
    svg('path', { d: `M${-ARM},0 Q0,-18 ${ARM},0 Q0,-6 ${-ARM},0Z`, class: 'brass-fill' }),
    svg('line', { x1: 0, y1: -4, x2: 0, y2: -30, class: 'scale-needle' }),
  );
  const pan = (label: SVGTextElement): SVGGElement =>
    svg(
      'g',
      { class: 'scale-pan' },
      svg('path', { d: 'M0,0 L-40,58 M0,0 L40,58', class: 'scale-chain' }),
      svg('path', { d: 'M-46,58 Q0,92 46,58Z', class: 'brass-fill' }),
      label,
    );
  const leftText = svg('text', { y: 50, class: 'scale-text' });
  const rightText = svg('text', { y: 50, class: 'scale-text' }, '15 g');
  const leftPan = pan(leftText);
  const rightPan = pan(rightText);
  const verdict = svg('text', { x: 0, y: -50, class: 'scale-verdict' });
  const scale = svg(
    'svg',
    { viewBox: '-190 -66 380 220', class: 'tea-scale', role: 'img', 'aria-label': 'Balance scale' },
    svg('path', { d: 'M-5,0 L5,0 L8,118 L44,134 L44,144 L-44,144 L-44,134 L-8,118Z', class: 'brass-dark' }),
    leftPan,
    rightPan,
    beam,
    svg('circle', { r: 8, class: 'hub' }),
    verdict,
    svg('text', { x: -ARM, y: 148, class: 'scale-caption' }, 'Amber + Jade'),
    svg('text', { x: ARM, y: 148, class: 'scale-caption' }, '15 g weight'),
  );

  const readings = ['Amber + Jade', 'Amber − Jade', 'Rose ÷ Mint', 'Total weight'].map((label) => {
    const value = el('b');
    return { root: el('div', { class: 'reading' }, el('span', {}, label), value), value };
  });

  const root = el(
    'div',
    { class: 'puzzle puzzle-tea' },
    badge.node,
    el('div', { class: 'tea-top' }, scale, el('div', { class: 'readings' }, ...readings.map((r) => r.root))),
    el('div', { class: 'controls tea-row' }, ...canisters.map((c) => c.root)),
  );

  const shadow = new Shadow(initial.puzzles.teaWeights, render);
  function render(): void {
    const w = shadow.value;
    for (const c of canisters) {
      c.grams.textContent = `${w[c.id]} g`;
      c.fill.style.height = `${(w[c.id] / 15) * 100}%`;
      if (Number(c.slider.value) !== w[c.id]) c.slider.value = String(w[c.id]);
      c.slider.style.setProperty('--pct', `${((w[c.id] - 1) / 14) * 100}%`);
    }
    const sum = w.amber + w.jade;
    // Negative angle drops the left pan.
    const deg = Math.max(-15, Math.min(15, (15 - sum) * 2));
    const rad = (deg * Math.PI) / 180;
    beam.style.transform = `rotate(${deg}deg)`;
    leftPan.style.transform = `translate(${-ARM * Math.cos(rad)}px, ${-ARM * Math.sin(rad)}px)`;
    rightPan.style.transform = `translate(${ARM * Math.cos(rad)}px, ${ARM * Math.sin(rad)}px)`;
    leftText.textContent = `${sum} g`;
    verdict.textContent = sum === 15 ? 'Level' : sum > 15 ? 'Left pan heavy' : 'Right pan heavy';
    scale.classList.toggle('level', sum === 15);
    const diff = w.amber - w.jade;
    readings[0].value.textContent = `${sum} g`;
    readings[1].value.textContent = `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff)} g`;
    readings[2].value.textContent = `×${Number((w.rose / w.mint).toFixed(2))}`;
    readings[3].value.textContent = `${w.amber + w.jade + w.rose + w.mint} g`;
  }
  return {
    title: 'Apothecary Tea Balance',
    root,
    size: 'wide',
    update(state) {
      solved = state.solvedPuzzles.p3_tea_balance;
      shadow.sync(state.puzzles.teaWeights);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => {
      shadow.dispose();
      window.clearTimeout(sendTimer);
      if (sendTimer && !solved) cb.onInteract('p3_tea_set', { weights: { ...shadow.value } });
      sendTimer = 0;
    },
  };
}

// ============================================================
// P4 — UV Safe
// ============================================================
function safeView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const badge = solvedBadge('The safe swings open. Claim the Glass Key and the Brass Prism!');
  const commit = (i: number, value: number): void => {
    if (solved) return;
    const digits = withAt(shadow.value, i, mod(value, 10));
    shadow.edit(digits);
    cb.onInteract('p4_safe_set', { digits });
  };
  const dials = [0, 1, 2, 3].map((i) => {
    const ring = svg('g', { class: 'safe-ring' });
    for (let d = 0; d < 10; d++) {
      const [x, y] = polar(44, d * 36 - 90);
      const num = svg(
        'text',
        { x, y, class: 'safe-num', transform: `rotate(${d * 36} ${x} ${y})`, onClick: () => commit(i, d) },
        d,
      );
      ring.append(num);
      for (let t = 0; t < 5; t++) {
        const [x1, y1] = polar(58, d * 36 + t * 7.2 - 90);
        const [x2, y2] = polar(t === 0 ? 52 : 55, d * 36 + t * 7.2 - 90);
        ring.append(svg('line', { x1, y1, x2, y2, class: t === 0 ? 'tick major' : 'tick' }));
      }
    }
    const value = svg('text', { class: 'safe-value' });
    const dial = svg(
      'svg',
      { viewBox: '-72 -78 144 150', class: 'safe-dial' },
      svg('circle', { r: 68, class: 'bezel' }),
      svg('circle', { r: 62, class: 'safe-plate' }),
      ring,
      svg('circle', { r: 26, class: 'safe-knob' }),
      value,
      svg('path', { d: 'M-7,-77 L7,-77 L0,-61Z', class: 'safe-pointer' }),
    );
    onWheelStep(dial, (d) => commit(i, shadow.value[i] + d));
    let turn: number | null = null;
    const root = el(
      'div',
      { class: 'safe-unit' },
      dial,
      el(
        'div',
        { class: 'safe-steps' },
        stepButton('−', `Digit ${i + 1} down`, () => commit(i, shadow.value[i] - 1)),
        stepButton('+', `Digit ${i + 1} up`, () => commit(i, shadow.value[i] + 1)),
      ),
    );
    return {
      root,
      set(v: number): void {
        turn = turn === null ? v : turn + shortestStep(mod(turn, 10), v, 10);
        ring.style.transform = `rotate(${-turn * 36}deg)`;
        value.textContent = String(v);
      },
    };
  });
  const frames = ['Tiny', 'Small', 'Medium', 'Large'].map((name, i) => {
    const node = el('div', { class: 'uv-frame' }, el('i'), el('span', {}, name));
    node.style.setProperty('--w', `${18 + i * 7}px`);
    return node;
  });
  const frameCount = el('span', { class: 'uv-count' });
  const root = el(
    'div',
    { class: 'puzzle puzzle-safe' },
    badge.node,
    el(
      'div',
      { class: 'uv-strip' },
      el('div', { class: 'uv-strip-label' }, 'UV frames uncovered ', frameCount),
      el('div', { class: 'uv-frames' }, ...frames),
    ),
    el('div', { class: 'controls safe-row' }, ...dials.map((d) => d.root)),
    el('p', { class: 'modal-foot' }, 'Enter the four digits from the smallest frame to the largest.'),
  );
  const shadow = new Shadow<Quad>(initial.puzzles.studySafeDigits, render);
  function render(): void {
    dials.forEach((d, i) => d.set(shadow.value[i]));
  }
  return {
    title: 'Study Wall Safe',
    root,
    update(state) {
      solved = state.solvedPuzzles.p4_uv_safe;
      shadow.sync(state.puzzles.studySafeDigits);
      const found = state.puzzles.uvRevealedFrames;
      frames.forEach((f, i) => f.classList.toggle('found', found.includes(i)));
      frameCount.textContent = `${new Set(found).size}/4`;
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P5 — Harmonic Pipe Organ
// ============================================================
function organView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  let picked: number | null = null;
  const timers: number[] = [];
  const badge = solvedBadge('Pure harmony! The organ compartment is open.');
  const status = el('p', { class: 'modal-foot organ-status' });

  const sound = (i: number): void => {
    cb.onPlayOrganPipe(shadow.value[i]);
    const node = pipes[i].pipe;
    node.classList.remove('sounding');
    void node.offsetWidth;
    node.classList.add('sounding');
  };
  const pick = (i: number): void => {
    if (solved) return sound(i);
    if (picked === null) {
      picked = i;
      cb.onClickSound();
    } else if (picked === i) {
      picked = null;
      cb.onClickSound();
    } else {
      const next = [...shadow.value] as Quint;
      [next[picked], next[i]] = [next[i], next[picked]];
      picked = null;
      shadow.edit(next);
      cb.onInteract('p5_organ_set', { pipes: next });
      cb.onClickSound();
    }
    render();
  };

  const pipes = [0, 1, 2, 3, 4].map((i) => {
    const num = el('span', { class: 'pipe-num' });
    const pipe = el(
      'button',
      { class: 'organ-pipe', onClick: () => pick(i) },
      el('span', { class: 'pipe-mouth' }),
      num,
    );
    const root = el(
      'div',
      { class: 'pipe-slot' },
      el('div', { class: 'pipe-well' }, pipe),
      el('span', { class: 'drum-tag' }, `Slot ${i + 1}`),
      el('button', { class: 'audition', 'aria-label': `Play slot ${i + 1}`, onClick: () => sound(i) }, '♪ Play'),
    );
    return { root, pipe, num };
  });
  const root = el(
    'div',
    { class: 'puzzle puzzle-organ' },
    badge.node,
    intro('Click one pipe, then another, to swap them. The number on each pipe is its length.'),
    el('div', { class: 'organ-case' }, ...pipes.map((p) => p.root)),
    status,
    el(
      'div',
      { class: 'modal-actions' },
      el(
        'button',
        {
          class: 'btn-primary',
          onClick: () => {
            timers.forEach((t) => window.clearTimeout(t));
            timers.length = 0;
            for (let i = 0; i < 5; i++) timers.push(window.setTimeout(() => sound(i), i * 170));
          },
        },
        '♫ Play All 5 Pipes',
      ),
    ),
  );
  const shadow = new Shadow<Quint>(initial.puzzles.organPipes, render);
  function render(): void {
    shadow.value.forEach((len, i) => {
      const { pipe, num } = pipes[i];
      pipe.style.height = `${20 + len * 15.5}%`;
      pipe.classList.toggle('picked', picked === i);
      pipe.setAttribute('aria-label', `Slot ${i + 1}, pipe length ${len}`);
      num.textContent = String(len);
    });
    status.textContent = solved
      ? 'The pipes are locked in tune.'
      : picked === null
        ? 'Choose a pipe to lift.'
        : `Pipe ${shadow.value[picked]} lifted from slot ${picked + 1}. Choose where it goes.`;
  }
  return {
    title: 'Harmonic Pipe Organ',
    root,
    update(state) {
      solved = state.solvedPuzzles.p5_pipe_organ;
      if (solved) picked = null;
      shadow.sync(state.puzzles.organPipes);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => {
      shadow.dispose();
      timers.forEach((t) => window.clearTimeout(t));
    },
  };
}

// ============================================================
// P6 — Equinox Sundial
// ============================================================
type RingId = 'hour' | 'azimuth' | 'day';
const SUNDIAL_RINGS: { id: RingId; label: string; radius: number; color: string }[] = [
  { id: 'hour', label: 'Hour', radius: 148, color: '#f5b942' },
  { id: 'azimuth', label: 'Azimuth', radius: 108, color: '#d98a4a' },
  { id: 'day', label: 'Day', radius: 68, color: '#3fa374' },
];

function sundialView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const badge = solvedBadge('The sundial aligns. The Clockwork Workshop is unsealed!');
  const commit = (id: RingId, value: number): void => {
    if (solved) return;
    const next = { ...shadow.value, [id]: mod(value - 1, 12) + 1 };
    shadow.edit(next);
    cb.onInteract('p6_sundial_set', { ...next });
  };
  const face = svg('svg', { viewBox: '-185 -190 370 375', class: 'sundial-face', role: 'img', 'aria-label': 'Sundial rings' });
  face.append(svg('circle', { r: 176, class: 'sundial-stone' }));
  const rings = SUNDIAL_RINGS.map((ring) => {
    const group = svg('g', { class: 'sundial-ring' });
    group.append(svg('circle', { r: ring.radius, class: 'ring-band', stroke: ring.color }));
    const marks: SVGTextElement[] = [];
    for (let v = 1; v <= 12; v++) {
      const deg = (v - 1) * 30 - 90;
      const [x, y] = polar(ring.radius, deg);
      const mark = svg(
        'text',
        { x, y, class: 'ring-num', transform: `rotate(${deg + 90} ${x} ${y})`, onClick: () => commit(ring.id, v) },
        v,
      );
      marks.push(mark);
      group.append(mark);
    }
    onWheelStep(group, (d) => commit(ring.id, shadow.value[ring.id] + d));
    face.append(group);
    let turn: number | null = null;
    return {
      id: ring.id,
      set(v: number): void {
        const idx = v - 1;
        turn = turn === null ? idx : turn + shortestStep(mod(turn, 12), idx, 12);
        group.style.transform = `rotate(${-turn * 30}deg)`;
        marks.forEach((m, i) => m.classList.toggle('current', i === idx));
      },
    };
  });
  const shadowWedge = svg('path', { d: 'M0,0 L-9,-44 L9,-44Z', class: 'gnomon-shadow' });
  face.append(
    svg('circle', { r: 46, class: 'sundial-heart' }),
    shadowWedge,
    svg('path', { d: 'M-5,14 L5,14 L0,-30Z', class: 'gnomon' }),
    svg('path', { d: 'M-11,-188 L11,-188 L0,-166Z', class: 'safe-pointer' }),
    svg('line', { x1: 0, y1: -168, x2: 0, y2: -48, class: 'sundial-meridian' }),
  );
  const steppers = SUNDIAL_RINGS.map((ring) => {
    const s = createStepper(ring.label, ring.color, (d) => commit(ring.id, shadow.value[ring.id] + d));
    return { id: ring.id, ...s };
  });
  const root = el(
    'div',
    { class: 'puzzle puzzle-sundial' },
    badge.node,
    el(
      'div',
      { class: 'controls split' },
      face,
      el(
        'div',
        { class: 'split-side' },
        intro('Bring one number from each ring under the red pointer.'),
        ...steppers.map((s) => s.root),
      ),
    ),
  );
  const shadow = new Shadow(initial.puzzles.sundial, render);
  function render(): void {
    rings.forEach((r) => r.set(shadow.value[r.id]));
    steppers.forEach((s) => s.set(shadow.value[s.id]));
    shadowWedge.style.transform = `rotate(${shadow.value.hour * 30}deg)`;
  }
  return {
    title: 'Equinox Sundial',
    root,
    size: 'wide',
    update(state) {
      solved = state.solvedPuzzles.p6_sundial;
      shadow.sync(state.puzzles.sundial);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P8 — Cross-Wired Irrigation
// ============================================================
function irrigationView(bank: 'a' | 'b', cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const isA = bank === 'a';
  const mine = isA ? 'North' : 'South';
  const theirs = isA ? 'South' : 'North';
  const valvePrefix = isA ? 'A' : 'B';
  const theirPrefix = isA ? 'B' : 'A';
  const gaugePrefix = isA ? 'G' : 'H';
  const targets = isA ? SOLUTIONS.p8_targetsG : SOLUTIONS.p8_targetsH;
  const badge = solvedBadge('All six gauges hold steady. Water flows to the Glass Lotus!');

  const commit = (i: number, value: number): void => {
    if (solved || value < 0 || value > 4) return;
    const valves = withAt(shadow.value, i, value);
    shadow.edit(valves);
    cb.onInteract(`p8_valves_${bank}`, { valves });
  };

  const MAX_PSI = 80;
  const psiAngle = (psi: number): number => -120 + (psi / MAX_PSI) * 240;
  const gauges = [0, 1, 2].map((i) => {
    const needle = svg('path', { d: 'M-3,8 L3,8 L0,-44Z', class: 'gauge-needle' });
    const value = svg('text', { y: 36, class: 'gauge-value' });
    const face = svg('svg', { viewBox: '-70 -70 140 140', class: 'gauge' });
    face.append(svg('circle', { r: 66, class: 'bezel' }), svg('circle', { r: 58, class: 'dial-plate' }));
    for (let psi = 0; psi <= MAX_PSI; psi += 10) {
      const deg = psiAngle(psi) - 90;
      const [x1, y1] = polar(48, deg);
      const [x2, y2] = polar(54, deg);
      face.append(svg('line', { x1, y1, x2, y2, class: 'tick' }));
      if (psi % 20 === 0) {
        const [x, y] = polar(39, deg);
        face.append(svg('text', { x, y, class: 'gauge-num' }, psi));
      }
    }
    const [tx, ty] = polar(53, psiAngle(targets[i]) - 90);
    const [tx2, ty2] = polar(65, psiAngle(targets[i]) - 90);
    face.append(
      svg('line', { x1: tx, y1: ty, x2: tx2, y2: ty2, class: 'gauge-target' }),
      needle,
      svg('circle', { r: 6, class: 'hub' }),
      value,
    );
    const root = el(
      'div',
      { class: 'gauge-unit' },
      el('span', { class: 'drum-tag' }, `${gaugePrefix}${i + 1}`),
      face,
      el('span', { class: 'gauge-goal' }, `Target ${targets[i]} PSI`),
    );
    return {
      root,
      set(psi: number): void {
        needle.style.transform = `rotate(${psiAngle(psi)}deg)`;
        value.textContent = String(psi);
        root.classList.toggle('on-target', psi === targets[i]);
      },
    };
  });

  const valves = [0, 1, 2].map((i) => {
    const wheel = svg('g', { class: 'valve-wheel' });
    wheel.append(svg('circle', { r: 46, class: 'valve-rim' }));
    for (let s = 0; s < 4; s++) {
      const [x, y] = polar(44, s * 90 + 45);
      wheel.append(svg('line', { x1: 0, y1: 0, x2: x, y2: y, class: 'valve-spoke' }));
    }
    wheel.append(svg('circle', { r: 12, class: 'hub' }), svg('circle', { cy: -46, r: 6, class: 'valve-mark' }));
    const face = svg('svg', { viewBox: '-60 -60 120 120', class: 'valve', 'aria-hidden': 'true' }, wheel);
    const pips = [1, 2, 3, 4].map(() => el('i'));
    const value = el('span', { class: 'stepper-value' });
    const root = el(
      'div',
      { class: 'valve-unit' },
      el('span', { class: 'drum-tag' }, `Valve ${valvePrefix}${i + 1}`),
      face,
      el('div', { class: 'valve-pips' }, ...pips),
      el(
        'div',
        { class: 'safe-steps' },
        stepButton('−', `Close valve ${valvePrefix}${i + 1}`, () => commit(i, shadow.value[i] - 1)),
        value,
        stepButton('+', `Open valve ${valvePrefix}${i + 1}`, () => commit(i, shadow.value[i] + 1)),
      ),
    );
    onWheelStep(face, (d) => commit(i, shadow.value[i] - d));
    return {
      root,
      set(v: number): void {
        wheel.style.transform = `rotate(${v * 72}deg)`;
        pips.forEach((p, j) => p.classList.toggle('on', j < v));
        value.textContent = String(v);
      },
    };
  });

  const partnerLine = el('p', { class: 'modal-foot' });
  const root = el(
    'div',
    { class: 'puzzle puzzle-irrigation' },
    badge.node,
    el(
      'section',
      { class: 'bank-panel gauges' },
      el(
        'h3',
        {},
        `${mine} gauges`,
        el('small', {}, `moved by your partner's ${theirs} valves (${theirPrefix}1–${theirPrefix}3)`),
      ),
      el('div', { class: 'gauge-row' }, ...gauges.map((g) => g.root)),
    ),
    el(
      'section',
      { class: 'bank-panel controls' },
      el('h3', {}, `${mine} valves`, el('small', {}, `these move the ${theirs} gauges across the pond`)),
      el('div', { class: 'gauge-row' }, ...valves.map((v) => v.root)),
    ),
    partnerLine,
  );
  const shadow = new Shadow<Triple>(isA ? initial.puzzles.valvesA : initial.puzzles.valvesB, render);
  let latest = initial;
  function render(): void {
    const a = isA ? shadow.value : latest.puzzles.valvesA;
    const b = isA ? latest.puzzles.valvesB : shadow.value;
    const { gaugesAtA, gaugesAtB } = computeIrrigationGauges(a, b);
    (isA ? gaugesAtA : gaugesAtB).forEach((psi, i) => gauges[i].set(psi));
    shadow.value.forEach((v, i) => valves[i].set(v));
    const otherTargets = isA ? SOLUTIONS.p8_targetsH : SOLUTIONS.p8_targetsG;
    const other = isA ? gaugesAtB : gaugesAtA;
    const lit = other.filter((psi, i) => psi === otherTargets[i]).length;
    partnerLine.textContent = `${theirs} bank: ${lit} of 3 gauges on target. Call out what you see!`;
  }
  return {
    title: `${mine} Irrigation Bank`,
    root,
    size: 'wide',
    update(state) {
      latest = state;
      solved = state.solvedPuzzles.p8_irrigation;
      shadow.sync(isA ? state.puzzles.valvesA : state.puzzles.valvesB);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P9 — Clockwork Gear Train
// ============================================================
const GEAR_TRAY = ['16', '18', '24', '36'];
const SHAFT_TARGETS = [30, 40, 20];
type GearSlots = [string | null, string | null, string | null];

function gearView(cb: ModalCallbacks, initial: WorldState, has18: () => boolean): View {
  let solved = false;
  let held: string | null = null;
  let benchKey = '';
  const badge = solvedBadge('The train runs true. The forge lights up and the Sky-Lift Key drops!');
  const bench = el('div', { class: 'gear-bench' });
  const status = el('p', { class: 'modal-foot' });

  const commit = (slots: GearSlots): void => {
    shadow.edit(slots);
    cb.onInteract('p9_gears_set', { slots });
  };
  const clickShaft = (i: number): void => {
    if (solved) return;
    if (held) {
      // Each gear exists once, so moving it clears its old shaft.
      const slots = shadow.value.map((g) => (g === held ? null : g)) as GearSlots;
      slots[i] = held;
      held = null;
      commit(slots);
    } else if (shadow.value[i]) {
      commit(withAt(shadow.value, i, null));
      cb.onClickSound();
    }
    render();
  };
  const clickGear = (teeth: string): void => {
    if (solved || (teeth === '18' && !has18())) return;
    held = held === teeth ? null : teeth;
    cb.onClickSound();
    render();
  };

  const tray = GEAR_TRAY.map((teeth) => {
    const r = 16 + Number(teeth) * 0.72;
    const note = el('span', { class: 'tray-note' });
    const btn = el(
      'button',
      { class: 'tray-gear', onClick: () => clickGear(teeth) },
      svg(
        'svg',
        { viewBox: '-46 -46 92 92', 'aria-hidden': 'true' },
        svg('path', { d: gearPath(Number(teeth), r, 5), class: 'brass-fill' }),
        svg('circle', { r: 6, class: 'gear-bore' }),
      ),
      el('span', { class: 'tray-name' }, `${teeth}T`),
      note,
    );
    return { teeth, btn, note };
  });

  const shafts = [0, 1, 2].map((i) => {
    const mounted = el('span', { class: 'shaft-gear' });
    const rpm = el('b', { class: 'shaft-rpm' });
    const btn = el(
      'button',
      { class: 'shaft-card', onClick: () => clickShaft(i) },
      el('span', { class: 'drum-tag' }, `Shaft ${i + 1}`),
      el('span', { class: 'shaft-target' }, `Target ${SHAFT_TARGETS[i]} RPM`),
      rpm,
      mounted,
    );
    return { btn, mounted, rpm };
  });

  function renderBench(): void {
    const key = shadow.value.join('|');
    if (key === benchKey) return;
    benchKey = key;
    const speeds = computeGearSpeeds(shadow.value);
    const radius = (teeth: number): number => teeth * 2;
    const EMPTY_R = 38;
    let x = radius(12) + 6;
    const parts: SVGElement[] = [];
    const draw = (cx: number, teeth: number, rpm: number, cw: boolean, label: string, cls: string): SVGGElement => {
      const spin = svg('path', { d: gearPath(teeth, radius(teeth) + 2, 6), class: `bench-gear ${cls}` });
      spin.style.animationDuration = `${60 / rpm}s`;
      spin.style.animationDirection = cw ? 'normal' : 'reverse';
      return svg(
        'g',
        { transform: `translate(${cx} 84)` },
        spin,
        svg('circle', { r: Math.max(7, radius(teeth) * 0.3), class: 'gear-bore' }),
        svg('text', { class: 'bench-label' }, label),
      );
    };
    parts.push(draw(x, 12, 60, true, '12', 'motor'));
    let prev = radius(12);
    shadow.value.forEach((teeth, i) => {
      const r = teeth ? radius(Number(teeth)) : EMPTY_R;
      x += prev + r + (teeth ? 1 : 4);
      prev = r + (teeth ? 0 : 4);
      const speed = speeds[i];
      if (teeth && speed) {
        const g = draw(x, Number(teeth), speed, i % 2 === 1, teeth, speed === SHAFT_TARGETS[i] ? 'true' : '');
        g.classList.add('bench-click');
        g.addEventListener('click', () => clickShaft(i));
        parts.push(g);
      } else {
        const g = svg(
          'g',
          { transform: `translate(${x} 84)`, class: 'bench-click' },
          svg('circle', { r: EMPTY_R, class: 'bench-empty' }),
          svg('text', { class: 'bench-label faint' }, `Shaft ${i + 1}`),
        );
        g.addEventListener('click', () => clickShaft(i));
        parts.push(g);
      }
    });
    const width = Math.max(340, x + prev + 10);
    bench.replaceChildren(
      svg('svg', { viewBox: `0 0 ${width} 168`, class: 'bench-svg', role: 'img', 'aria-label': 'Gear train' }, ...parts),
    );
  }

  const root = el(
    'div',
    { class: 'puzzle puzzle-gears' },
    badge.node,
    bench,
    el('div', { class: 'controls shaft-row' }, ...shafts.map((s) => s.btn)),
    el('div', { class: 'controls tray-row' }, ...tray.map((t) => t.btn)),
    status,
  );
  const shadow = new Shadow<GearSlots>(initial.puzzles.gearSlots, render);
  function render(): void {
    renderBench();
    const speeds = computeGearSpeeds(shadow.value);
    shafts.forEach((s, i) => {
      const teeth = shadow.value[i];
      const speed = speeds[i];
      s.rpm.textContent = speed === null ? '— RPM' : `${speed} RPM`;
      s.mounted.textContent = teeth ? `${teeth}T mounted` : held ? `Mount ${held}T here` : 'Empty';
      s.btn.classList.toggle('on-target', speed === SHAFT_TARGETS[i]);
      s.btn.classList.toggle('ready', held !== null);
    });
    for (const t of tray) {
      const locked = t.teeth === '18' && !has18();
      const at = shadow.value.indexOf(t.teeth);
      t.btn.disabled = locked;
      t.btn.classList.toggle('locked', locked);
      t.btn.classList.toggle('held', held === t.teeth);
      t.btn.classList.toggle('in-use', at >= 0);
      t.note.textContent = locked ? 'Not found yet' : at >= 0 ? `On shaft ${at + 1}` : held === t.teeth ? 'In hand' : 'In tray';
    }
    status.textContent = solved
      ? 'The gear train is locked and running.'
      : held
        ? `Holding the ${held}T gear. Choose a shaft to mount it.`
        : 'Choose a gear, then a shaft. Click a mounted gear to take it off.';
  }
  return {
    title: 'Clockwork Gear Train',
    root,
    size: 'wide',
    update(state) {
      solved = state.solvedPuzzles.p9_gear_train;
      if (solved) held = null;
      shadow.sync(state.puzzles.gearSlots);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P11 — Planetary Orrery
// ============================================================
type Planet = 'sun' | 'mars' | 'moon' | 'sea';
const PLANETS: { id: Planet; label: string; orbit: number; size: number; color: string; dark: string }[] = [
  { id: 'sun', label: 'Sun-Gold', orbit: 56, size: 15, color: '#ffd75e', dark: '#c98a12' },
  { id: 'mars', label: 'Mars-Copper', orbit: 85, size: 14, color: '#ee9063', dark: '#9c4420' },
  { id: 'moon', label: 'Moon-Silver', orbit: 114, size: 14, color: '#f2f3f6', dark: '#8d95a5' },
  { id: 'sea', label: 'Sea-Cobalt', orbit: 143, size: 15, color: '#6db4f5', dark: '#1d4f96' },
];

function orreryView(cb: ModalCallbacks, initial: WorldState): View {
  let solved = false;
  const badge = solvedBadge('The heavens align. The Star Resonance Core is free!');
  const commit = (id: Planet, value: number): void => {
    if (solved) return;
    const orrery = { ...shadow.value, [id]: mod(value - 1, 8) + 1 };
    shadow.edit(orrery);
    cb.onInteract('p11_orrery_set', { orrery });
  };
  const defs = svg('defs');
  for (const p of PLANETS) {
    defs.append(
      svg(
        'radialGradient',
        { id: `planet-${p.id}`, cx: '35%', cy: '30%', r: '75%' },
        svg('stop', { offset: '0%', 'stop-color': p.color }),
        svg('stop', { offset: '100%', 'stop-color': p.dark }),
      ),
    );
  }
  const face = svg('svg', { viewBox: '-215 -215 430 430', class: 'orrery-face', role: 'img', 'aria-label': 'Planetary orrery' }, defs);
  face.append(svg('circle', { r: 210, class: 'bezel' }), svg('circle', { r: 198, class: 'orrery-sky' }));
  for (let i = 0; i < 40; i++) {
    // Fixed pseudo-random star field
    const [x, y] = polar(30 + ((i * 47) % 160), (i * 137.5) % 360);
    face.append(svg('circle', { cx: x, cy: y, r: 0.7 + (i % 3) * 0.5, class: 'orrery-star' }));
  }
  for (let pos = 1; pos <= 8; pos++) {
    const deg = (pos - 1) * 45 - 90;
    const [x2, y2] = polar(168, deg);
    const [tx, ty] = polar(182, deg);
    face.append(
      svg('line', { x1: 0, y1: 0, x2, y2, class: 'orrery-spoke' }),
      svg('text', { x: tx, y: ty, class: 'orrery-num' }, pos),
    );
  }
  const planets = PLANETS.map((p) => {
    const label = svg('text', { class: 'planet-letter' }, p.id === 'moon' ? '☾' : p.id === 'sun' ? '☀' : p.id === 'mars' ? '♂' : '≈');
    const upright = svg('g', { class: 'orrery-turn' }, label);
    const body = svg(
      'g',
      { transform: `translate(0 ${-p.orbit})`, class: 'orrery-planet', onClick: () => commit(p.id, shadow.value[p.id] + 1) },
      svg('circle', { r: p.size + 5, class: 'planet-halo', fill: p.color }),
      svg('circle', { r: p.size, fill: `url(#planet-${p.id})`, class: 'planet-disc' }),
      upright,
    );
    const arm = svg('g', { class: 'orrery-turn' }, svg('line', { x1: 0, y1: 0, x2: 0, y2: -p.orbit, class: 'orrery-arm', stroke: p.dark }), body);
    face.append(svg('circle', { r: p.orbit, class: 'orrery-orbit', stroke: p.color }));
    let turn: number | null = null;
    return {
      id: p.id,
      arm,
      set(v: number): void {
        const idx = v - 1;
        turn = turn === null ? idx : turn + shortestStep(mod(turn, 8), idx, 8);
        arm.style.transform = `rotate(${turn * 45}deg)`;
        upright.style.transform = `rotate(${-turn * 45}deg)`;
      },
    };
  });
  face.append(...planets.map((p) => p.arm), svg('circle', { r: 22, class: 'hub big' }));
  const steppers = PLANETS.map((p) => ({
    id: p.id,
    ...createStepper(p.label, p.color, (d) => commit(p.id, shadow.value[p.id] + d)),
  }));
  const root = el(
    'div',
    { class: 'puzzle puzzle-orrery' },
    badge.node,
    el(
      'div',
      { class: 'controls split' },
      face,
      el(
        'div',
        { class: 'split-side' },
        intro('Positions run 1 to 8 clockwise from the top. The ledger on the deck gives the alignment.'),
        ...steppers.map((s) => s.root),
      ),
    ),
  );
  const shadow = new Shadow(initial.puzzles.orrery, render);
  function render(): void {
    planets.forEach((p) => p.set(shadow.value[p.id]));
    steppers.forEach((s) => s.set(shadow.value[s.id]));
  }
  return {
    title: 'Planetary Orrery',
    root,
    size: 'wide',
    update(state) {
      solved = state.solvedPuzzles.p11_orrery;
      shadow.sync(state.puzzles.orrery);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// P13 — Grand Solstice Gate
// ============================================================
type Core = 'sun' | 'gear' | 'star' | 'wind';
const CORES: { id: Core; label: string; color: string }[] = [
  { id: 'sun', label: 'Sun', color: '#f5b942' },
  { id: 'gear', label: 'Gear', color: '#d98a4a' },
  { id: 'star', label: 'Star', color: '#4a9fe0' },
  { id: 'wind', label: 'Wind', color: '#45c4b0' },
];
const DIRS: CardinalDir[] = ['N', 'E', 'S', 'W'];
const DIR_NAMES: Record<CardinalDir, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };

function gateView(cb: ModalCallbacks, initial: WorldState): View {
  let latest = initial;
  let solved = false;
  const badge = solvedBadge('The Grand Solstice Gate is open!');
  const pedestals = CORES.map((core) => {
    const itemId = `core_${core.id}` as ItemId;
    const insert = el('button', {
      class: 'btn-primary insert-core',
      onClick: () => {
        if (!latest.inventory.includes(itemId)) return;
        cb.onInteract('p13_insert_core', { core: core.id });
      },
    });
    const needle = el('div', { class: 'compass-needle' });
    const buttons = DIRS.map((dir) =>
      el(
        'button',
        {
          class: `compass-dir dir-${dir}`,
          'aria-label': `Turn ${core.label} pedestal ${DIR_NAMES[dir]}`,
          onClick: () => {
            if (solved) return;
            shadow.edit({ ...shadow.value, [core.id]: dir });
            cb.onInteract('p13_set_dial', { core: core.id, dir });
          },
        },
        dir,
      ),
    );
    const orb = el('div', { class: 'pedestal-orb' }, ITEMS[itemId].icon);
    const facing = el('span', { class: 'pedestal-facing' });
    const root = el(
      'div',
      { class: 'pedestal' },
      el('h3', {}, `${core.label} Pedestal`),
      el('div', { class: 'compass' }, needle, orb, ...buttons),
      facing,
      insert,
    );
    root.style.setProperty('--core', core.color);
    let turn: number | null = null;
    return {
      id: core.id,
      render(): void {
        const dir = shadow.value[core.id];
        const idx = DIRS.indexOf(dir);
        turn = turn === null ? idx : turn + shortestStep(mod(turn, 4), idx, 4);
        needle.style.transform = `rotate(${turn * 90}deg)`;
        buttons.forEach((b, i) => {
          b.classList.toggle('on', i === idx);
          b.setAttribute('aria-pressed', String(i === idx));
        });
        facing.textContent = `Facing ${DIR_NAMES[dir]}`;
        const inserted = latest.puzzles.gateCoresInserted[core.id];
        const held = latest.inventory.includes(itemId);
        root.classList.toggle('seated', inserted);
        insert.disabled = inserted || !held;
        insert.textContent = inserted ? '✓ Core seated' : held ? `Insert ${core.label} Core` : 'Core not found yet';
      },
      root,
    };
  });
  const status = el('div', { class: 'gate-status', role: 'status' });
  const padLeft = el('div', { class: 'pad-chip' });
  const padRight = el('div', { class: 'pad-chip' });
  const root = el(
    'div',
    { class: 'puzzle puzzle-gate' },
    badge.node,
    el('div', { class: 'controls pedestal-row' }, ...pedestals.map((p) => p.root)),
    status,
    el('div', { class: 'pad-row' }, padLeft, padRight),
  );
  const shadow = new Shadow(initial.puzzles.gateDials, render);

  function padText(node: HTMLElement, label: string, by: PlayerSlot[]): void {
    const names = by.map(
      (slot) => Object.values(latest.players).find((p) => p.slot === slot)?.name ?? `Player ${slot}`,
    );
    node.textContent = `${label} Solstice Pad: ${names.length > 0 ? names.join(' & ') : 'empty'}`;
    node.classList.toggle('on', names.length > 0);
  }
  function render(): void {
    pedestals.forEach((p) => p.render());
    const pz = latest.puzzles;
    const seated = CORES.filter((c) => pz.gateCoresInserted[c.id]).length;
    const aligned = CORES.every((c) => pz.gateDials[c.id] === SOLUTIONS.p13_cardinals[c.id]);
    const ready = seated === 4 && aligned;
    status.classList.toggle('ready', ready && !solved);
    status.classList.toggle('hidden', solved);
    // Only the whole set is judged, so the dials can't be brute-forced one at a time.
    status.textContent = ready
      ? '✦ All four cores aligned! Close this panel — each of you stand on one Twin Solstice Pad at the same time!'
      : seated < 4
        ? `${seated} of 4 cores seated. Gather the rest from across the estate.`
        : 'All four cores are seated, but the pedestals do not yet agree. Check the Solstice Plaques in your Notebook.';
    padText(padLeft, 'Left', pz.finalePadLeftBy);
    padText(padRight, 'Right', pz.finalePadRightBy);
  }
  return {
    title: 'The Grand Solstice Gate',
    root,
    size: 'wide',
    update(state) {
      latest = state;
      solved = state.solvedPuzzles.p13_solstice_gate;
      shadow.sync(state.puzzles.gateDials);
      root.classList.toggle('is-solved', solved);
      badge.set(solved);
      render();
    },
    dispose: () => shadow.dispose(),
  };
}

// ============================================================
// Clue letters & plaques
// ============================================================
function clueView(clueId: string): View | null {
  const clue = WORLD_CLUES[clueId];
  if (!clue) return null;
  const isUv = clueId.startsWith('clue_uv_frame_');
  return {
    title: clue.title,
    size: 'narrow',
    root: el(
      'div',
      { class: `parchment${isUv ? ' uv' : ''}` },
      el('div', { class: 'parchment-zone' }, clue.zone),
      renderClueBody(clue.body),
      el('div', { class: 'saved-badge' }, '✓ Saved to Field Notebook', el('kbd', {}, 'N')),
    ),
    update() {
      /* plaques never change */
    },
  };
}

// ============================================================
// Controller
// ============================================================
export function createModals(callbacks: ModalCallbacks): ModalController {
  const backdrop = byId('modal-backdrop');
  const panel = byId('modal-panel');
  const titleNode = byId('modal-title');
  const body = byId('modal-body');

  let view: View | null = null;
  let has18 = false;

  // The 18T gear leaves the inventory once mounted, so remember that the team owns it.
  function note18(state: WorldState): void {
    has18 =
      state.inventory.includes('item_gear_18t') ||
      state.collectedWorldItems.includes('item_gear_18t') ||
      state.puzzles.gearSlots.includes('18');
  }

  const factories: Record<string, (state: WorldState) => View> = {
    p1_foyer_clock: (s) => clockView(callbacks, s),
    p2_tea_cipher: (s) => cipherView(callbacks, s),
    p3_tea_balance: (s) => teaView(callbacks, s),
    p4_uv_safe: (s) => safeView(callbacks, s),
    p5_pipe_organ: (s) => organView(callbacks, s),
    p6_sundial: (s) => sundialView(callbacks, s),
    p8_irrigation_a: (s) => irrigationView('a', callbacks, s),
    p8_irrigation_b: (s) => irrigationView('b', callbacks, s),
    p9_gear_train: (s) => gearView(callbacks, s, () => has18),
    p11_orrery: (s) => orreryView(callbacks, s),
    p13_solstice_gate: (s) => gateView(callbacks, s),
  };

  function mount(next: View, state: WorldState): void {
    view?.dispose?.();
    view = next;
    titleNode.textContent = next.title;
    panel.dataset.size = next.size ?? 'normal';
    body.replaceChildren(next.root);
    body.scrollTop = 0;
    next.update(state);
    backdrop.classList.remove('hidden');
    releasePointer();
  }

  function close(): void {
    if (!view) return;
    const closing = view;
    view = null;
    closing.dispose?.();
    backdrop.classList.add('hidden');
    body.replaceChildren();
    callbacks.onClose();
  }

  byId('modal-close-btn').addEventListener('click', () => {
    callbacks.onClickSound();
    close();
  });
  let downOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (ev) => {
    downOnBackdrop = ev.target === backdrop;
  });
  backdrop.addEventListener('click', (ev) => {
    // Ignore drags that began inside the panel (e.g. a slider) and ended outside it.
    if (ev.target === backdrop && downOnBackdrop) close();
  });
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented || !view) return;
      // Escape closes the topmost layer only.
      if (['calculator-widget', 'notebook-drawer', 'minigame-overlay'].some(isShown)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      close();
    },
    true,
  );

  function openClue(clueId: string, state: WorldState): void {
    const next = clueView(clueId);
    if (next) mount(next, state);
  }

  return {
    isOpen: () => view !== null,
    openModal(modalId, state) {
      note18(state);
      const factory = factories[modalId];
      if (factory) mount(factory(state), state);
      else openClue(modalId, state);
    },
    openClue,
    refreshIfOpen(state) {
      note18(state);
      view?.update(state);
    },
    close,
  };
}
