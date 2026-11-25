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
  key: { label: 'Single-use', className: 'pill-key' },
  tool: { label: 'Tool', className: 'pill-tool' },
  part: { label: 'Part', className: 'pill-part' },
  core: { label: 'Core', className: 'pill-core' },
};

const CORE_NAMES = ['sun', 'gear', 'star', 'wind'] as const;
const MAX_TOASTS = 3;

function itemIconSvg(id: ItemId): SVGElement {
  const s = svg('svg', {
    viewBox: '0 0 24 24',
    width: 20,
    height: 20,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  if (id.startsWith('key_')) {
    s.append(
      svg('circle', { cx: 8, cy: 12, r: 4 }),
      svg('path', { d: 'M12 12h9M17 12v3M20 12v2' }),
    );
  } else if (id === 'tool_uv_lamp') {
    s.append(
      svg('path', { d: 'M9 3h6l1 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V7z' }),
      svg('path', { d: 'M8 7h8M12 11v4' }),
    );
  } else if (id === 'tool_prism') {
    s.append(svg('polygon', { points: '12 3 21 19 3 19' }));
  } else if (id === 'item_gear_18t' || id === 'core_gear') {
    s.append(
      svg('circle', { cx: 12, cy: 12, r: 3.5 }),
      svg('circle', { cx: 12, cy: 12, r: 7.5, 'stroke-dasharray': '3 2.5' }),
    );
  } else if (id === 'core_sun') {
    s.append(
      svg('circle', { cx: 12, cy: 12, r: 4 }),
      svg('path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1' }),
    );
  } else if (id === 'core_star') {
    s.append(svg('path', { d: 'M12 3l2.4 6.2L21 12l-6.6 2.8L12 21l-2.4-6.2L3 12l6.6-2.8z' }));
  } else {
    s.append(
      svg('path', { d: 'M3 9h11a3 3 0 1 0-3-3M3 14h14a3 3 0 1 1-3 3M3 19h8' }),
    );
  }
  return s;
}

function speakerSvg(muted: boolean): SVGElement {
  const s = svg('svg', {
    viewBox: '0 0 20 20',
    width: 15,
    height: 15,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  s.append(svg('path', { d: 'M3 8h3.2L10.5 4.5v11L6.2 12H3z' }));
  if (muted) {
    s.append(svg('path', { d: 'M13.5 7.5l4 5M17.5 7.5l-4 5' }));
  } else {
    s.append(svg('path', { d: 'M13.5 7.2a4 4 0 0 1 0 5.6M16 4.8a7.4 7.4 0 0 1 0 10.4' }));
  }
  return s;
}

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
  const hintLabel = byId('hint-btn-label');
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
  let myId = '';
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
    muteBtn.replaceChildren(speakerSvg(muted));
    muteBtn.classList.toggle('is-muted', muted);
  }
  bindButton('audio-mute-btn', toggleMute);

  /** The hotbar only ever shows what this player is carrying, never the team union. */
  function myItems(state: WorldState | null): ItemId[] {
    return state?.players[myId]?.inventory ?? [];
  }

  function toggleSlot(index: number): void {
    const item = myItems(latest)[index];
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
    const myInv = myItems(state);
    const key = `${myInv.join(',')}|${selected ?? ''}`;
    if (key === lastInventoryKey) return;
    lastInventoryKey = key;

    if (myInv.length === 0) {
      inventoryBar.replaceChildren();
      inventoryBar.classList.add('is-empty');
      knownItems = new Set();
      return;
    }
    inventoryBar.classList.remove('is-empty');

    const slots: HTMLElement[] = myInv.map((id, i) => {
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
        el('span', { class: 'inv-icon' }, itemIconSvg(id)),
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

    const def = selected && myInv.includes(selected) ? ITEMS[selected] : null;
    const caption = def
      ? el(
          'div',
          { class: 'inv-caption' },
          el('strong', {}, def.name),
          el(
            'span',
            {},
            def.category === 'key'
              ? ' · Consumed on unlock'
              : def.id === 'tool_uv_lamp'
                ? ' · Press F to toggle'
                : def.category === 'tool'
                  ? ' · Reusable'
                  : def.category === 'core'
                    ? ' · Solstice Gate'
                    : '',
          ),
          el('span', { class: 'inv-pass' }, ' · ', el('kbd', {}, 'G'), ' Pass / Drop'),
        )
      : null;
    inventoryBar.replaceChildren(...(caption ? [caption] : []), el('div', { class: 'inv-slots' }, ...slots));
    knownItems = new Set(myInv);
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
    renderHintButton(latest, now);
    refreshLockBanner();
  }

  function renderHintButton(state: WorldState, now: number): void {
    const off = state.hintMode === 'none';
    hintBtn.classList.toggle('hidden', off);
    hintBtn.previousElementSibling?.classList.toggle('hidden', off);
    if (off) return;

    const unlimited = state.hintMode === 'unlimited';
    const ready = unlimited || now >= state.hintCooldownEndsAt;
    hintBtn.classList.toggle('ready', ready);
    hintBtn.classList.toggle('cooling', !ready);
    const title = unlimited ? 'Hint Ledger (H)' : 'Clockwork Oracle Hint Minigame (H)';
    if (hintBtn.title !== title) hintBtn.title = title;
    setText(hintLabel, unlimited ? 'Hints' : 'Oracle');

    const waiting = state.minigame.phase === 'lobby' ? state.minigame.readyPlayers.length : 0;
    setText(
      hintBadge,
      unlimited
        ? 'Free'
        : ready
          ? waiting > 0
            ? `${waiting}/2`
            : 'Ready'
          : formatDuration(state.hintCooldownEndsAt - now, true),
    );
  }
  window.setInterval(tickClocks, 250);

  return {
    update(state, myPlayerId, myZone, selectedItem) {
      latest = state;
      myId = myPlayerId;
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
      const held = CORE_NAMES.filter(
        (c) =>
          !state.puzzles.gateCoresInserted[c] &&
          (state.inventory.includes(`core_${c}`) ||
            state.droppedItems.some((d) => d.itemId === `core_${c}`)),
      ).length;
      setText(coresCount, `${placed + held}/4`);
      coresPill.title = `Resonance Cores: ${held} carried by the team, ${placed} placed in the Solstice Gate`;
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
      // Strip leading decorative emoji if any server message includes one
      const clean = message.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\u2600-\u27BF]+\s*/u, '');
      const toast = el(
        'div',
        { class: `toast toast-${variant}`, role: 'status' },
        el('span', { class: 'toast-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'toast-text' }, clean),
      );
      toastContainer.append(toast);
      while (toastContainer.childElementCount > MAX_TOASTS) toastContainer.firstElementChild?.remove();
      const life = Math.min(7000, 3200 + clean.length * 28);
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
