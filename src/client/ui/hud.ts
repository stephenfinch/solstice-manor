import { ITEMS, WORLD_CLUES } from '../../shared/puzzles.js';
import { ZONES, type ZoneDefinition } from '../../shared/worldLayout.js';
import type { ItemCategory, ItemId, WorldState } from '../../shared/types.js';

// ============================================================
// Small DOM helpers shared by every UI module
// ============================================================
export type Child = Node | string | number | null | undefined | false;
type PropValue = string | number | boolean | undefined | ((ev: any) => void);
export type Props = Record<string, PropValue>;

function applyProps(node: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

/** Create an HTML element. `onClick`-style props become listeners; everything else is an attribute. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

/** Create an SVG element. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI container #${id}`);
  return node as T;
}

export function isShown(id: string): boolean {
  const node = document.getElementById(id);
  return !!node && !node.classList.contains('hidden');
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && target.type !== 'range')
  );
}

export function releasePointer(): void {
  if (document.pointerLockElement) document.exitPointerLock();
}

/** Milliseconds -> `MM:SS` (or `H:MM:SS`). */
export function formatDuration(ms: number, roundUp = false): string {
  const raw = Math.max(0, ms) / 1000;
  const total = roundUp ? Math.ceil(raw) : Math.floor(raw);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

// ============================================================
// HUD
// ============================================================
export interface HudController {
  update(
    state: WorldState,
    myPlayerId: string,
    myZone: ZoneDefinition,
    selectedItem: ItemId | null,
  ): void;
  setInteractPrompt(label: string | null): void;
  showToast(message: string, variant?: 'info' | 'success' | 'warning' | 'key'): void;
  showCoopBanner(message: string | null): void;
  setPointerLocked(locked: boolean, roomCode: string): void;
  showVictory(state: WorldState, onReplay: () => void): void;
}

const CATEGORY_PILL: Record<ItemCategory, { label: string; className: string }> = {
  key: { label: '1-USE KEY', className: 'pill-key' },
  tool: { label: 'REUSABLE TOOL', className: 'pill-tool' },
  part: { label: '1-USE PART', className: 'pill-part' },
  core: { label: 'CORE', className: 'pill-core' },
};

const CORE_NAMES = ['sun', 'gear', 'star', 'wind'] as const;
const MIN_SLOTS = 6;
const MAX_TOASTS = 4;

export function createHud(callbacks: {
  onSelectItem: (item: ItemId | null) => void;
  onOpenNotebook: () => void;
  onOpenCalculator: () => void;
  onOpenOracle: () => void;
  onPing: () => void;
  onToggleMute: () => boolean;
}): HudController {
  const zoneBanner = byId('zone-banner');
  const zoneName = byId('zone-name');
  const zoneSub = byId('zone-sub');
  const elapsed = byId('elapsed-time');
  const coresPill = byId('cores-pill');
  const coresCount = byId('cores-count');
  const partnerPill = byId('partner-pill');
  const partnerDot = byId('partner-dot');
  const partnerStatus = byId('partner-status');
  const hintBtn = byId<HTMLButtonElement>('hint-hud-btn');
  const hintBadge = byId('hint-cooldown-badge');
  const muteBtn = byId<HTMLButtonElement>('audio-mute-btn');
  const crosshair = byId('crosshair');
  const prompt = byId('interact-prompt');
  const promptLabel = byId('interact-label');
  const coopBanner = byId('coop-banner');
  const toastContainer = byId('toast-container');
  const inventoryBar = byId('inventory-bar');
  const lockBanner = byId('pointer-lock-banner');
  const hudRoomCode = byId('hud-room-code');
  const victoryOverlay = byId('victory-overlay');

  let latest: WorldState | null = null;
  let selected: ItemId | null = null;
  let lastInventoryKey = '';
  let lastZoneId = '';
  let lastPrompt: string | null = null;
  let knownItems: Set<ItemId> | null = null;

  const bindButton = (id: string, fn: () => void): void => {
    const btn = byId<HTMLButtonElement>(id);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      btn.blur(); // otherwise Space / Enter while walking would re-trigger the button
      fn();
    });
  };
  bindButton('btn-notebook', () => callbacks.onOpenNotebook());
  bindButton('btn-calculator', () => callbacks.onOpenCalculator());
  bindButton('btn-ping', () => callbacks.onPing());
  bindButton('hint-hud-btn', () => callbacks.onOpenOracle());
  function toggleMute(): void {
    const muted = callbacks.onToggleMute();
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.classList.toggle('is-muted', muted);
  }
  bindButton('audio-mute-btn', toggleMute);

  function toggleSlot(index: number): void {
    const item = latest?.inventory[index];
    if (!item) return;
    // Re-selecting the lamp flips its light instead of putting it away.
    callbacks.onSelectItem(item === selected && item !== 'tool_uv_lamp' ? null : item);
  }

  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.defaultPrevented || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isTypingTarget(ev.target) || !isShown('hud') || isShown('minigame-overlay')) return;
      if (ev.key === 'm' || ev.key === 'M') {
        ev.stopImmediatePropagation();
        toggleMute();
        return;
      }
      if (!/^[1-9]$/.test(ev.key)) return;
      if (['lobby-overlay', 'modal-backdrop', 'calculator-widget', 'victory-overlay'].some(isShown)) {
        return;
      }
      ev.stopImmediatePropagation(); // one keypress must select exactly once
      toggleSlot(Number(ev.key) - 1);
    },
    true,
  );

  function renderInventory(state: WorldState): void {
    const key = `${state.inventory.join(',')}|${selected ?? ''}`;
    if (key === lastInventoryKey) return;
    lastInventoryKey = key;

    const slots: HTMLElement[] = state.inventory.map((id, i) => {
      const def = ITEMS[id];
      const pill = CATEGORY_PILL[def.category];
      const isNew = knownItems !== null && !knownItems.has(id);
      const btn = el(
        'button',
        {
          class: `inv-slot cat-${def.category}${id === selected ? ' selected' : ''}${isNew ? ' is-new' : ''}`,
          title: `${def.name} — ${def.description}`,
          'aria-pressed': id === selected ? 'true' : 'false',
          'aria-label': `${def.name}, ${pill.label}`,
        },
        i < 9 && el('kbd', { class: 'inv-num' }, i + 1),
        el('span', { class: 'inv-icon' }, def.icon),
        el('span', { class: 'inv-name' }, def.shortName),
        el('span', { class: `cat-pill ${pill.className}` }, pill.label),
      );
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        btn.blur();
        toggleSlot(i);
      });
      return btn;
    });
    for (let i = slots.length; i < MIN_SLOTS; i++) {
      slots.push(el('div', { class: 'inv-slot empty' }, el('kbd', { class: 'inv-num' }, i + 1)));
    }

    const def = selected && state.inventory.includes(selected) ? ITEMS[selected] : null;
    const caption = el(
      'div',
      { class: `inv-caption${def ? '' : ' invisible'}` },
      el('strong', {}, def ? def.name : '—'),
      el(
        'span',
        {},
        def
          ? def.category === 'key'
            ? ' Used up when it opens its lock'
            : def.id === 'tool_uv_lamp'
              ? ' Press F to toggle · never used up'
              : def.category === 'tool'
                ? ' Never used up'
                : def.category === 'core'
                  ? ' Place it at the Solstice Gate'
                  : ' Fits a mechanism'
          : '',
      ),
    );
    inventoryBar.replaceChildren(caption, el('div', { class: 'inv-slots' }, ...slots));
    knownItems = new Set(state.inventory);
  }

  // `update` runs every frame, so only touch the DOM when text really changed.
  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderPartner(state: WorldState, myPlayerId: string): void {
    const partner = Object.values(state.players).find((p) => p.id !== myPlayerId);
    if (!partner) {
      setText(partnerStatus, 'Waiting for Partner...');
      partnerDot.className = 'status-dot waiting';
      partnerPill.style.removeProperty('--partner-color');
      return;
    }
    const zone = ZONES.find((z) => z.id === partner.transform.zone);
    partnerDot.className = `status-dot ${partner.connected ? 'online' : 'offline'}`;
    setText(
      partnerStatus,
      partner.connected
        ? `${partner.name} · ${zone?.name ?? 'Estate'}`
        : `${partner.name} · reconnecting…`,
    );
    partnerPill.style.setProperty('--partner-color', partner.color);
  }

  // Closing a panel doesn't fire a pointer-lock event, so re-check whether to offer "click to look".
  function refreshLockBanner(): void {
    const covered =
      !!document.pointerLockElement ||
      [
        'lobby-overlay',
        'modal-backdrop',
        'notebook-drawer',
        'calculator-widget',
        'minigame-overlay',
        'victory-overlay',
      ].some(isShown);
    lockBanner.classList.toggle('hidden', covered);
    if (latest) setText(hudRoomCode, latest.roomCode);
  }

  // Timers run on their own clock so they keep moving between state syncs.
  function tickClocks(): void {
    if (!latest) return;
    const now = Date.now();
    setText(elapsed, formatDuration((latest.completedAt ?? now) - latest.startedAt));
    const ready = now >= latest.hintCooldownEndsAt;
    hintBtn.classList.toggle('ready', ready);
    hintBtn.classList.toggle('cooling', !ready);
    const waiting = latest.minigame.phase === 'lobby' ? latest.minigame.readyPlayers.length : 0;
    setText(
      hintBadge,
      ready
        ? waiting > 0
          ? `${waiting}/2 READY`
          : 'READY'
        : formatDuration(latest.hintCooldownEndsAt - now, true),
    );
    refreshLockBanner();
  }
  window.setInterval(tickClocks, 250);

  return {
    update(state, myPlayerId, myZone, selectedItem) {
      latest = state;
      selected = selectedItem;

      if (myZone.id !== lastZoneId) {
        lastZoneId = myZone.id;
        zoneName.textContent = myZone.name;
        zoneSub.textContent = myZone.subtitle;
        zoneBanner.classList.toggle('outdoor', myZone.outdoor);
        zoneBanner.classList.remove('zone-enter');
        void zoneBanner.offsetWidth;
        zoneBanner.classList.add('zone-enter');
      }

      const placed = CORE_NAMES.filter((c) => state.puzzles.gateCoresInserted[c]).length;
      const held = CORE_NAMES.filter((c) => state.inventory.includes(`core_${c}`)).length;
      setText(coresCount, `${placed + held}/4`);
      coresPill.title = `Resonance Cores: ${held} carried, ${placed} placed in the Solstice Gate`;
      coresPill.classList.toggle('complete', placed + held === 4);

      renderPartner(state, myPlayerId);
      renderInventory(state);
      tickClocks();
    },

    setInteractPrompt(label) {
      if (label === lastPrompt) return;
      lastPrompt = label;
      prompt.classList.toggle('hidden', !label);
      crosshair.classList.toggle('active', !!label);
      if (label) promptLabel.textContent = label;
    },

    showToast(message, variant = 'info') {
      if (!message) return;
      const icon = { info: '✦', success: '☀', warning: '⚠', key: '🗝️' }[variant];
      const toast = el(
        'div',
        { class: `toast toast-${variant}`, role: 'status' },
        el('span', { class: 'toast-icon' }, icon),
        el('span', { class: 'toast-text' }, message),
      );
      toastContainer.append(toast);
      while (toastContainer.childElementCount > MAX_TOASTS) toastContainer.firstElementChild?.remove();
      const life = Math.min(9000, 3400 + message.length * 32);
      window.setTimeout(() => {
        toast.classList.add('leaving');
        window.setTimeout(() => toast.remove(), 350);
      }, life);
    },

    showCoopBanner(message) {
      coopBanner.classList.toggle('hidden', !message);
      if (message && coopBanner.textContent !== message) {
        coopBanner.textContent = message;
        coopBanner.classList.remove('pulse');
        void coopBanner.offsetWidth;
        coopBanner.classList.add('pulse');
      }
    },

    setPointerLocked(locked, roomCode) {
      hudRoomCode.textContent = roomCode || '----';
      lockBanner.classList.toggle('hidden', locked);
    },

    showVictory(state, onReplay) {
      releasePointer();
      const took = (state.completedAt ?? Date.now()) - state.startedAt;
      const solved = Object.values(state.solvedPuzzles).filter(Boolean).length;
      const total = Object.keys(state.solvedPuzzles).length;
      const names = Object.values(state.players)
        .sort((a, b) => a.slot - b.slot)
        .map((p) => p.name);
      const rank =
        state.hintWinsCount === 0
          ? 'Grand Master Horologists'
          : state.hintWinsCount <= 3
            ? 'Master Horologists'
            : 'Horologists of the Oracle';

      const stat = (value: string, label: string): HTMLElement =>
        el(
          'div',
          { class: 'victory-stat' },
          el('span', { class: 'victory-value' }, value),
          el('span', { class: 'victory-label' }, label),
        );

      const motes = el('div', { class: 'victory-motes', 'aria-hidden': 'true' });
      for (let i = 0; i < 36; i++) {
        const mote = el('i');
        mote.style.left = `${Math.random() * 100}%`;
        mote.style.animationDelay = `${-Math.random() * 9}s`;
        mote.style.animationDuration = `${6 + Math.random() * 6}s`;
        mote.style.setProperty('--size', `${4 + Math.random() * 7}px`);
        motes.append(mote);
      }

      const replay = el(
        'button',
        {
          class: 'btn-primary',
          onClick: () => {
            victoryOverlay.classList.add('hidden');
            victoryOverlay.replaceChildren();
            onReplay();
          },
        },
        'Begin a New Estate Session',
      );
      victoryOverlay.replaceChildren(
        el('div', { class: 'victory-rays', 'aria-hidden': 'true' }),
        motes,
        el(
          'div',
          { class: 'victory-card', role: 'dialog', 'aria-modal': 'true' },
          el('div', { class: 'lobby-emblem' }, '☀'),
          el('div', { class: 'victory-rank' }, rank),
          el('h1', { class: 'lobby-title' }, 'The Solstice Gate Is Open'),
          el(
            'p',
            { class: 'victory-names' },
            names.length > 0 ? `${names.join(' & ')} passed the Grand Solstice Exam.` : 'The Grand Solstice Exam is passed.',
          ),
          el(
            'div',
            { class: 'victory-stats' },
            stat(formatDuration(took), 'Time in the manor'),
            stat(`${solved}/${total}`, 'Mechanisms solved'),
            stat(`${state.discoveredClues.length}/${Object.keys(WORLD_CLUES).length}`, 'Clues recorded'),
            stat(`${state.hintWinsCount}/${state.hintAttemptsCount}`, 'Oracle scrolls won'),
          ),
          el('div', { class: 'victory-actions' }, replay),
        ),
      );
      victoryOverlay.classList.remove('hidden');
    },
  };
}
