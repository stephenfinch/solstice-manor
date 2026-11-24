import { PUZZLE_HINTS } from '../../shared/puzzles.js';
import type { WorldState } from '../../shared/types.js';
import { byId, el, isShown, isTypingTarget, releasePointer } from './hud.js';
import { renderClueBody } from './modals.js';

export interface ToolsController {
  toggleNotebook(force?: boolean): void;
  toggleCalculator(force?: boolean): void;
  isNotebookOpen(): boolean;
  isCalculatorOpen(): boolean;
  updateState(state: WorldState): void;
}

type TabId = 'clues' | 'hints' | 'notes';
type CalcOp = '+' | '-' | '×' | '÷';

const NOTES_DEBOUNCE_MS = 350;
const NOTES_MAX = 6000; // matches the server's cap
const IN_FLIGHT_MS = 1500;

// ------------------------------------------------------------
// Scratchpad merging: both apprentices may type at the same time
// ------------------------------------------------------------
interface Splice {
  start: number;
  end: number; // exclusive, in base coordinates
  insert: string;
}

function diffSplice(base: string, next: string): Splice {
  const max = Math.min(base.length, next.length);
  let start = 0;
  while (start < max && base[start] === next[start]) start++;
  let tail = 0;
  while (tail < max - start && base[base.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return { start, end: base.length - tail, insert: next.slice(start, next.length - tail) };
}

/** Three-way merge of two single-region edits made against the same base text. */
function mergeNotes(base: string, local: string, remote: string): string {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const a = diffSplice(base, remote);
  const b = diffSplice(base, local);
  if (b.start >= a.end) {
    return (
      base.slice(0, a.start) + a.insert + base.slice(a.end, b.start) + b.insert + base.slice(b.end)
    );
  }
  if (a.start >= b.end) {
    return (
      base.slice(0, b.start) + b.insert + base.slice(b.end, a.start) + a.insert + base.slice(a.end)
    );
  }
  // Same region edited by both: keep both versions, partner's first.
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  return base.slice(0, start) + a.insert + b.insert + base.slice(end);
}

/** Map a caret through the text change so it stays beside the same characters. */
function shiftCaret(before: string, after: string, caret: number): number {
  const s = diffSplice(before, after);
  if (caret <= s.start) return caret;
  if (caret >= s.end) return caret + s.insert.length - (s.end - s.start);
  return s.start + s.insert.length;
}

export function createTools(callbacks: {
  onUpdateSharedNotes: (text: string) => void;
  onClickSound: () => void;
}): ToolsController {
  const drawer = byId('notebook-drawer');
  const content = byId('notebook-content');
  const calcWidget = byId('calculator-widget');
  const calcBody = byId('calc-body');
  const tabButtons = [...drawer.querySelectorAll<HTMLButtonElement>('.tab-btn')];

  let state: WorldState | null = null;
  let activeTab: TabId = 'clues';
  let search = '';
  let cluesKey = '';
  let hintsKey = '';
  let seenClues = 0;
  let seenHints = 0;

  // ----------------------------------------------------------
  // Notebook: clues
  // ----------------------------------------------------------
  const searchInput = el('input', {
    class: 'notebook-search',
    type: 'search',
    placeholder: 'Search clues…',
    'aria-label': 'Search clues',
  });
  const clueCount = el('div', { class: 'notebook-count' });
  const clueList = el('div', { class: 'notebook-list' });
  const cluesPane = el('div', { class: 'notebook-pane' }, searchInput, clueCount, clueList);

  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLowerCase();
    cluesKey = '';
    renderClues();
  });

  function renderClues(): void {
    if (!state) return;
    const key = `${state.discoveredClues.map((c) => c.id).join(',')}|${search}`;
    if (key === cluesKey) return;
    cluesKey = key;
    const all = [...state.discoveredClues].sort((a, b) => b.discoveredAt - a.discoveredAt);
    const shown = search
      ? all.filter((c) => `${c.title} ${c.zone} ${c.body}`.toLowerCase().includes(search))
      : all;
    clueCount.textContent =
      all.length === 0
        ? ''
        : search
          ? `${shown.length} of ${all.length} clues match`
          : `${all.length} clue${all.length === 1 ? '' : 's'} recorded, newest first`;
    if (shown.length === 0) {
      clueList.replaceChildren(
        el(
          'p',
          { class: 'notebook-empty' },
          all.length === 0
            ? 'Nothing recorded yet. Read the ledger, plaques and letters around the estate — each one is copied here for both of you.'
            : 'No clue matches that search.',
        ),
      );
      return;
    }
    clueList.replaceChildren(
      ...shown.map((c) =>
        el(
          'article',
          { class: `clue-card${c.id.startsWith('clue_uv_frame_') ? ' uv' : ''}` },
          el('div', { class: 'clue-zone' }, c.zone),
          el('h4', {}, c.title),
          renderClueBody(c.body),
        ),
      ),
    );
  }

  // ----------------------------------------------------------
  // Notebook: oracle hints
  // ----------------------------------------------------------
  const hintsPane = el('div', { class: 'notebook-pane notebook-list' });

  function renderHints(): void {
    if (!state) return;
    const solved = state.solvedPuzzles;
    const key = `${state.unlockedHints.map((h) => h.id).join(',')}|${state.unlockedHints.map((h) => solved[h.puzzleId]).join()}`;
    if (key === hintsKey) return;
    hintsKey = key;
    if (state.unlockedHints.length === 0) {
      hintsPane.replaceChildren(
        el(
          'p',
          { class: 'notebook-empty' },
          'No Oracle scrolls yet. Press H to challenge the Clockwork Oracle together and win one.',
        ),
      );
      return;
    }
    const groups = PUZZLE_HINTS.map((track) => ({
      track,
      hints: state!.unlockedHints
        .filter((h) => h.puzzleId === track.puzzleId)
        .sort((a, b) => a.tier - b.tier),
    }))
      .filter((g) => g.hints.length > 0)
      .sort(
        (a, b) =>
          Number(solved[a.track.puzzleId]) - Number(solved[b.track.puzzleId]) ||
          a.track.order - b.track.order,
      );
    hintsPane.replaceChildren(
      ...groups.map((g) =>
        el(
          'section',
          { class: `hint-group${solved[g.track.puzzleId] ? ' solved' : ''}` },
          el(
            'h4',
            {},
            g.track.title,
            solved[g.track.puzzleId] && el('span', { class: 'solved-chip' }, '✓ Solved'),
          ),
          ...g.hints.map((h) =>
            el(
              'div',
              { class: 'hint-entry' },
              el('span', { class: `tier-badge tier-${h.tier}` }, `Tier ${h.tier}`),
              el('p', {}, h.text),
            ),
          ),
        ),
      ),
    );
  }

  // ----------------------------------------------------------
  // Notebook: shared scratchpad
  // ----------------------------------------------------------
  const notesArea = el('textarea', {
    class: 'notes-area',
    spellcheck: 'false',
    maxlength: NOTES_MAX,
    placeholder: 'Jot sums, symbols and theories here. Your partner sees this page live.',
    'aria-label': 'Shared scratchpad',
  });
  const notesStatus = el('span', { class: 'notes-status' }, 'In sync with your partner');
  const notesPane = el(
    'div',
    { class: 'notebook-pane notes-pane' },
    notesArea,
    el('div', { class: 'notes-foot' }, notesStatus),
  );

  let notesBase = ''; // last text known to be on the server
  let notesInFlight: string | null = null;
  let inFlightAt = 0;
  let notesTimer = 0;
  let notesReady = false;

  function scheduleNotes(): void {
    window.clearTimeout(notesTimer);
    notesStatus.textContent = 'Writing…';
    notesTimer = window.setTimeout(flushNotes, NOTES_DEBOUNCE_MS);
  }

  function flushNotes(): void {
    window.clearTimeout(notesTimer);
    notesTimer = 0;
    const text = notesArea.value;
    if (text !== notesBase || notesInFlight !== null) {
      notesInFlight = text;
      inFlightAt = Date.now();
      callbacks.onUpdateSharedNotes(text);
    }
    notesStatus.textContent = 'In sync with your partner';
  }

  function setNotesText(next: string): void {
    const before = notesArea.value;
    if (next === before) return;
    const focused = document.activeElement === notesArea;
    const start = shiftCaret(before, next, notesArea.selectionStart);
    const end = shiftCaret(before, next, notesArea.selectionEnd);
    const scroll = notesArea.scrollTop;
    notesArea.value = next;
    if (focused) notesArea.setSelectionRange(start, end);
    notesArea.scrollTop = scroll;
  }

  function syncNotes(remote: string): void {
    if (!notesReady) {
      notesReady = true;
      notesBase = remote;
      setNotesText(remote);
      return;
    }
    if (notesInFlight !== null && Date.now() - inFlightAt > IN_FLIGHT_MS) notesInFlight = null;
    if (remote === notesBase && remote !== notesInFlight) return;
    if (notesInFlight !== null) {
      if (remote === notesInFlight) {
        notesBase = remote;
        notesInFlight = null;
        return;
      }
      if (remote.includes(notesInFlight)) {
        // Our edit landed and the partner has already built on it.
        notesBase = notesInFlight;
        notesInFlight = null;
      }
    }
    const merged = mergeNotes(notesBase, notesArea.value, remote).slice(0, NOTES_MAX);
    notesBase = remote;
    setNotesText(merged);
    if (merged !== remote) scheduleNotes();
  }

  notesArea.addEventListener('input', scheduleNotes);
  notesArea.addEventListener('blur', () => {
    if (notesTimer) flushNotes();
  });
  for (const field of [notesArea, searchInput]) {
    // Typing must never trigger game shortcuts (N, C, H, WASD…). Escape still closes the drawer.
    field.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Escape') ev.stopPropagation();
    });
  }

  // ----------------------------------------------------------
  // Notebook shell
  // ----------------------------------------------------------
  function badge(btn: HTMLButtonElement, count: number): void {
    btn.querySelector('.tab-badge')?.remove();
    if (count > 0) btn.append(el('span', { class: 'tab-badge' }, count));
  }

  function renderBadges(): void {
    if (!state) return;
    const open = isShown('notebook-drawer');
    if (open && activeTab === 'clues') seenClues = state.discoveredClues.length;
    if (open && activeTab === 'hints') seenHints = state.unlockedHints.length;
    for (const btn of tabButtons) {
      if (btn.dataset.tab === 'clues') badge(btn, state.discoveredClues.length - seenClues);
      if (btn.dataset.tab === 'hints') badge(btn, state.unlockedHints.length - seenHints);
    }
  }

  function showTab(tab: TabId): void {
    activeTab = tab;
    for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === tab);
    content.replaceChildren(tab === 'clues' ? cluesPane : tab === 'hints' ? hintsPane : notesPane);
    renderClues();
    renderHints();
    renderBadges();
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      callbacks.onClickSound();
      showTab(btn.dataset.tab as TabId);
      if (activeTab === 'notes') notesArea.focus();
    });
  }

  function toggleNotebook(force?: boolean): void {
    const open = isShown('notebook-drawer');
    const next = force ?? !open;
    if (next === open) return;
    callbacks.onClickSound();
    drawer.classList.toggle('hidden', !next);
    if (next) {
      releasePointer();
      showTab(activeTab);
    } else {
      if (notesTimer) flushNotes();
      if (document.activeElement instanceof HTMLElement && drawer.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    }
  }

  byId('notebook-close-btn').addEventListener('click', () => toggleNotebook(false));
  showTab('clues');

  // ----------------------------------------------------------
  // Brass Arithmometer
  // ----------------------------------------------------------
  let entry = '0';
  let accumulator: number | null = null;
  let pendingOp: CalcOp | null = null;
  let entryIsFresh = true; // next digit starts a new number
  let expression = '';
  let jammed = false;
  const tape: { expr: string; result: string }[] = [];

  const exprLine = el('div', { class: 'calc-expr' });
  const mainLine = el('div', { class: 'calc-value', 'aria-live': 'polite' }, '0');
  const tapeBox = el('div', { class: 'calc-tape', 'aria-label': 'Last five calculations' });
  const keypad = el('div', { class: 'calc-keys' });
  const opButtons = new Map<CalcOp, HTMLButtonElement>();

  const fmt = (n: number): string => {
    const rounded = Number(n.toPrecision(12));
    const text = String(rounded);
    return text.length > 14 ? rounded.toExponential(7) : text;
  };

  function compute(a: number, b: number, op: CalcOp): number {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '×':
        return a * b;
      case '÷':
        return a / b;
    }
  }

  function renderCalc(): void {
    exprLine.textContent = expression || ' ';
    mainLine.textContent = jammed ? 'JAMMED — press C' : entry;
    mainLine.classList.toggle('jammed', jammed);
    for (const [op, btn] of opButtons) btn.classList.toggle('armed', op === pendingOp && entryIsFresh);
    tapeBox.replaceChildren(
      ...(tape.length === 0
        ? [el('div', { class: 'tape-empty' }, 'Paper tape: your last five sums print here')]
        : tape.map((t) =>
            el(
              'button',
              {
                class: 'tape-row',
                title: 'Use this result',
                onClick: () => {
                  if (jammed) clearAll();
                  callbacks.onClickSound();
                  entry = t.result;
                  entryIsFresh = true;
                  if (pendingOp === null) expression = '';
                  else entryIsFresh = false;
                  renderCalc();
                },
              },
              el('span', {}, `${t.expr} =`),
              el('b', {}, t.result),
            ),
          )),
    );
  }

  function clearAll(): void {
    entry = '0';
    accumulator = null;
    pendingOp = null;
    entryIsFresh = true;
    expression = '';
    jammed = false;
  }

  function inputDigit(d: string): void {
    if (entryIsFresh) {
      entry = d === '.' ? '0.' : d;
      entryIsFresh = false;
      if (pendingOp === null) expression = '';
      return;
    }
    if (d === '.' && entry.includes('.')) return;
    if (entry.replace(/[^0-9]/g, '').length >= 12) return;
    entry = entry === '0' && d !== '.' ? d : entry + d;
  }

  /** Fold the current entry into the accumulator. Returns false if the machine jammed. */
  function fold(): boolean {
    const value = Number(entry);
    if (accumulator === null || pendingOp === null) {
      accumulator = value;
      return true;
    }
    const result = compute(accumulator, value, pendingOp);
    if (!Number.isFinite(result)) {
      jammed = true;
      return false;
    }
    accumulator = Number(result.toPrecision(12));
    return true;
  }

  function inputOp(op: CalcOp): void {
    if (pendingOp !== null && entryIsFresh && accumulator !== null) {
      // Changing your mind about the operator
      pendingOp = op;
      expression = expression.replace(/ [+\-×÷]$/, ` ${op}`);
      return;
    }
    const trimmed = fmt(Number(entry));
    expression = pendingOp === null ? trimmed : `${expression} ${trimmed}`;
    if (!fold()) return;
    // Chained sums run left to right, like the real machine: show the running total.
    entry = fmt(accumulator!);
    expression = `${expression} ${op}`;
    pendingOp = op;
    entryIsFresh = true;
  }

  function inputEquals(): void {
    if (pendingOp === null || accumulator === null) return;
    const full = `${expression} ${fmt(Number(entry))}`;
    if (!fold()) {
      expression = full;
      return;
    }
    const result = fmt(accumulator);
    tape.unshift({ expr: full, result });
    tape.length = Math.min(tape.length, 5);
    expression = `${full} =`;
    entry = result;
    accumulator = null;
    pendingOp = null;
    entryIsFresh = true;
  }

  function backspace(): void {
    if (entryIsFresh) return;
    entry = entry.length > 1 ? entry.slice(0, -1) : '0';
    if (entry === '-') entry = '0';
  }

  function pressCalc(key: string): void {
    callbacks.onClickSound();
    if (key === 'C') clearAll();
    else if (!jammed) {
      if (/^[0-9.]$/.test(key)) inputDigit(key);
      else if (key === '⌫') backspace();
      else if (key === '=') inputEquals();
      else inputOp(key as CalcOp);
    }
    renderCalc();
  }

  const keyRows = ['C', '⌫', '÷', '×', '7', '8', '9', '-', '4', '5', '6', '+', '1', '2', '3', '=', '0', '.'];
  const keyButtons = new Map<string, HTMLButtonElement>();
  const ariaLabels: Record<string, string> = {
    C: 'Clear',
    '⌫': 'Backspace',
    '÷': 'Divide',
    '×': 'Multiply',
    '-': 'Subtract',
    '+': 'Add',
    '=': 'Equals',
    '.': 'Decimal point',
  };
  for (const key of keyRows) {
    const isOp = '+-×÷'.includes(key);
    const kind = isOp ? 'op' : key === '=' ? 'equals' : key === 'C' || key === '⌫' ? 'util' : 'num';
    const btn = el(
      'button',
      {
        class: `calc-key ${kind}${key === '0' ? ' wide' : ''}`,
        'aria-label': ariaLabels[key],
        onClick: () => {
          btn.blur();
          pressCalc(key);
        },
      },
      key === '-' ? '−' : key,
    );
    if (isOp) opButtons.set(key as CalcOp, btn);
    keyButtons.set(key, btn);
    keypad.append(btn);
  }
  calcBody.replaceChildren(
    tapeBox,
    el('div', { class: 'calc-display' }, exprLine, mainLine),
    keypad,
    el('div', { class: 'calc-note' }, 'Runs left to right · Del clears'),
  );
  renderCalc();

  function toggleCalculator(force?: boolean): void {
    const open = isShown('calculator-widget');
    const next = force ?? !open;
    if (next === open) return;
    callbacks.onClickSound();
    calcWidget.classList.toggle('hidden', !next);
    if (next) releasePointer();
  }
  byId('calc-close-btn').addEventListener('click', () => toggleCalculator(false));

  const KEY_MAP: Record<string, string> = {
    '*': '×',
    x: '×',
    X: '×',
    '/': '÷',
    '+': '+',
    '-': '-',
    '=': '=',
    Enter: '=',
    Backspace: '⌫',
    Delete: 'C',
    ',': '.',
    '.': '.',
  };

  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isShown('minigame-overlay')) return;
      if (ev.key === 'Escape') {
        if (isShown('calculator-widget')) toggleCalculator(false);
        else if (isShown('notebook-drawer')) toggleNotebook(false);
        else return;
        // Spent: one Escape closes only the topmost layer.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      if (!isShown('calculator-widget') || isTypingTarget(ev.target)) return;
      const key = /^[0-9]$/.test(ev.key) ? ev.key : KEY_MAP[ev.key];
      if (!key) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const btn = keyButtons.get(key);
      btn?.classList.add('pressed');
      window.setTimeout(() => btn?.classList.remove('pressed'), 110);
      pressCalc(key);
    },
    true,
  );

  // Drag the calculator by its header.
  const header = calcWidget.querySelector<HTMLElement>('.widget-header');
  header?.addEventListener('pointerdown', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) return;
    ev.preventDefault();
    const rect = calcWidget.getBoundingClientRect();
    const dx = ev.clientX - rect.left;
    const dy = ev.clientY - rect.top;
    header.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent): void => {
      const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, e.clientX - dx));
      const y = Math.max(8, Math.min(window.innerHeight - 60, e.clientY - dy));
      calcWidget.style.left = `${x}px`;
      calcWidget.style.top = `${y}px`;
      calcWidget.style.right = 'auto';
      calcWidget.style.bottom = 'auto';
    };
    const stop = (): void => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
  });

  let roomCode = '';
  return {
    toggleNotebook,
    toggleCalculator,
    isNotebookOpen: () => isShown('notebook-drawer'),
    isCalculatorOpen: () => isShown('calculator-widget'),
    updateState(next) {
      if (next.roomCode !== roomCode) {
        // New session: forget anything tied to the previous estate.
        roomCode = next.roomCode;
        notesReady = false;
        notesInFlight = null;
        window.clearTimeout(notesTimer);
        notesTimer = 0;
        seenClues = 0;
        seenHints = 0;
      }
      state = next;
      syncNotes(next.sharedNotes);
      if (isShown('notebook-drawer')) {
        renderClues();
        renderHints();
      }
      renderBadges();
    },
  };
}
