import * as THREE from 'three';
import { ItemId, PlayerSlot, WorldState } from '../shared/types.js';
import { LanNetworkClient } from './network.js';
import { buildSolsticeWorld, BuiltWorld } from './worldBuilder.js';
import { FirstPersonController } from './playerController.js';
import { SoundscapeEngine } from './audio.js';
import { createHud, HudController, isTypingTarget } from './ui/hud.js';
import { createModals, ModalController } from './ui/modals.js';
import { createTools, ToolsController } from './ui/tools.js';
import { createHintMinigame, HintMinigameController } from './ui/hintMinigame.js';

// === GLOBAL APP STATE ===
const network = new LanNetworkClient();
const audio = new SoundscapeEngine();

let renderer: THREE.WebGLRenderer;
let camera: THREE.PerspectiveCamera;
let world: BuiltWorld;
let controller: FirstPersonController;
let hud: HudController;
let modals: ModalController;
let tools: ToolsController;
let hintMinigame: HintMinigameController;

let gameState: WorldState | null = null;
let myPlayerId = '';
let myPlayerSlot: PlayerSlot = 1;
let inGame = false;
let victoryShown = false;

let lastTransformSentAt = 0;
let coopBannerTimer: ReturnType<typeof setTimeout> | null = null;

// === DOM ELEMENTS (LOBBY) ===
const lobbyOverlay = document.getElementById('lobby-overlay')!;
const hudRoot = document.getElementById('hud')!;
const lanUrlEl = document.getElementById('lan-url')!;
const waitingLanUrlEl = document.getElementById('waiting-lan-url')!;
const copyLanBtn = document.getElementById('copy-lan-btn')!;
const playerNameInput = document.getElementById('player-name') as HTMLInputElement;
const createRoomBtn = document.getElementById('create-room-btn')!;
const roomCodeInput = document.getElementById('room-code-input') as HTMLInputElement;
const joinRoomBtn = document.getElementById('join-room-btn')!;
const lobbyJoinForm = document.getElementById('lobby-join-form')!;
const lobbyWaiting = document.getElementById('lobby-waiting')!;
const waitingRoomCode = document.getElementById('waiting-room-code')!;
const playersSlotsEl = document.getElementById('players-slots')!;
const enterManorBtn = document.getElementById('enter-manor-btn')!;
const leaveRoomBtn = document.getElementById('leave-room-btn')!;
const lobbyErrorEl = document.getElementById('lobby-error')!;
const activeRoomsBox = document.getElementById('active-rooms-box')!;
const activeRoomsList = document.getElementById('active-rooms-list')!;

function showLobbyError(msg: string | null): void {
  if (!msg) {
    lobbyErrorEl.classList.add('hidden');
    lobbyErrorEl.textContent = '';
  } else {
    lobbyErrorEl.classList.remove('hidden');
    lobbyErrorEl.textContent = msg;
  }
}

async function fetchLanInfo(): Promise<void> {
  try {
    const res = await fetch('/api/info');
    const data = (await res.json()) as {
      lanUrl: string;
      activeRooms: { roomCode: string; playerCount: number; playerNames: string[] }[];
    };
    lanUrlEl.textContent = data.lanUrl;
    waitingLanUrlEl.textContent = data.lanUrl;

    if (data.activeRooms && data.activeRooms.length > 0) {
      activeRoomsBox.classList.remove('hidden');
      activeRoomsList.innerHTML = '';
      for (const room of data.activeRooms) {
        const row = document.createElement('div');
        row.className = 'active-room-row';
        row.innerHTML = `
          <div>
            <strong>${room.roomCode}</strong>
            <span class="room-meta">(${room.playerCount}/2 — ${room.playerNames.join(', ')})</span>
          </div>
          <button class="btn-small" ${room.playerCount >= 2 ? 'disabled' : ''}>
            ${room.playerCount >= 2 ? 'Full' : 'Join'}
          </button>
        `;
        const btn = row.querySelector('button');
        btn?.addEventListener('click', () => {
          roomCodeInput.value = room.roomCode;
          joinRoomBtn.click();
        });
        activeRoomsList.appendChild(row);
      }
    } else {
      activeRoomsBox.classList.add('hidden');
    }
  } catch {
    lanUrlEl.textContent = window.location.origin;
    waitingLanUrlEl.textContent = window.location.origin;
  }
}

function renderWaitingPlayers(state: WorldState): void {
  const players = Object.values(state.players).sort((a, b) => a.slot - b.slot);
  const p1 = players.find((p) => p.slot === 1 && p.connected);
  const p2 = players.find((p) => p.slot === 2 && p.connected);

  playersSlotsEl.innerHTML = `
    <div class="player-slot-card ${p1 ? 'connected' : ''}">
      <span class="slot-dot"></span>
      <span class="slot-name">${p1 ? escapeHtml(p1.name) : 'Waiting…'}</span>
      <span class="slot-badge">Player 1</span>
    </div>
    <div class="player-slot-card ${p2 ? 'connected' : ''}">
      <span class="slot-dot"></span>
      <span class="slot-name">${p2 ? escapeHtml(p2.name) : 'Waiting for partner…'}</span>
      <span class="slot-badge">Player 2</span>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function isBlockingOverlayOpen(): boolean {
  return !inGame || modals.isOpen() || hintMinigame.isOpen() || victoryShown;
}

function isAnyOverlayOpen(): boolean {
  return isBlockingOverlayOpen() || tools.isNotebookOpen() || tools.isCalculatorOpen();
}

function openOracleMinigame(): void {
  if (!gameState) return;
  controller.exitPointerLock();
  modals.close();
  tools.toggleNotebook(false);
  tools.toggleCalculator(false);
  hintMinigame.open(gameState, myPlayerSlot);
}

function performInteract(): void {
  if (!gameState || !controller.targetedObject) return;
  const obj = controller.targetedObject;
  audio.init();

  if (obj.actionType === 'clue' && obj.clueId) {
    network.send({ type: 'discover_clue', clueId: obj.clueId });
    controller.exitPointerLock();
    audio.playSfx('dial_click');
    modals.openClue(obj.clueId, gameState);
    return;
  }

  if (obj.actionType === 'modal' && obj.modalId) {
    controller.exitPointerLock();
    audio.playSfx('dial_click');
    modals.openModal(obj.modalId, gameState);
    return;
  }

  if (obj.actionType === 'door' && obj.doorId) {
    network.send({ type: 'unlock_door', doorId: obj.doorId });
    return;
  }

  if (obj.actionType === 'pickup' && obj.itemId) {
    network.send({ type: 'pickup_item', itemId: obj.itemId });
    return;
  }

  if (obj.actionType === 'direct') {
    if (obj.id === 'open_oracle' || obj.id === 'open_oracle_courtyard') {
      openOracleMinigame();
      return;
    }
    network.send({ type: 'interact', targetId: obj.id });
  }
}

function triggerCoopPing(): void {
  if (!gameState || !inGame) return;
  const pt = controller.raycastWorldPoint(world.scene);
  network.send({ type: 'coop_ping', x: pt.x, y: pt.y, z: pt.z });
}

function toggleUvLamp(): void {
  if (!gameState || !inGame) return;
  if (!gameState.inventory.includes('tool_uv_lamp')) {
    hud.showToast('No UV Lantern in inventory.', 'warning');
    audio.playSfx('error');
    return;
  }
  controller.uvOn = !controller.uvOn;
  controller.heldItem = controller.uvOn ? 'tool_uv_lamp' : controller.heldItem;
  audio.playSfx('uv_toggle', { on: controller.uvOn });
  hud.showToast(controller.uvOn ? 'UV Lantern on' : 'UV Lantern off', 'info');
}

function initThreeAndUi(): void {
  const container = document.getElementById('canvas-container')!;
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 220);
  world = buildSolsticeWorld();

  controller = new FirstPersonController(camera, renderer.domElement, world, {
    onFootstep: (material) => audio.playFootstep(material),
    onPointerLockChange: (locked) => {
      if (inGame && gameState) {
        hud.setPointerLocked(locked || isAnyOverlayOpen(), gameState.roomCode);
      }
    },
    canMove: () => !isBlockingOverlayOpen(),
  });

  hud = createHud({
    onSelectItem: (item: ItemId | null) => {
      controller.heldItem = item;
      if (item === 'tool_uv_lamp') {
        toggleUvLamp();
      } else {
        audio.playSfx('dial_click');
      }
    },
    onOpenNotebook: () => {
      if (!inGame) return;
      controller.exitPointerLock();
      tools.toggleNotebook();
    },
    onOpenCalculator: () => {
      if (!inGame) return;
      controller.exitPointerLock();
      tools.toggleCalculator();
    },
    onOpenOracle: () => openOracleMinigame(),
    onPing: () => triggerCoopPing(),
    onToggleMute: () => {
      audio.init();
      const next = !audio.isMuted();
      audio.setMuted(next);
      return next;
    },
  });

  modals = createModals({
    onInteract: (targetId, payload) => {
      network.send({ type: 'interact', targetId, payload });
    },
    onPlayOrganPipe: (length) => {
      audio.init();
      audio.playOrganPipe(length);
    },
    onClickSound: () => {
      audio.init();
      audio.playSfx('dial_click');
    },
    onClose: () => {
      if (inGame && !isAnyOverlayOpen()) {
        controller.requestPointerLock();
      }
    },
  });

  tools = createTools({
    onUpdateSharedNotes: (text) => {
      network.send({ type: 'update_notes', text });
    },
    onClickSound: () => {
      audio.init();
      audio.playSfx('dial_click');
    },
  });

  hintMinigame = createHintMinigame({
    onReady: (targetPuzzleId) => {
      network.send({ type: 'minigame_ready', targetPuzzleId });
    },
    onCancel: () => {
      network.send({ type: 'minigame_cancel' });
    },
    onInput: (angle, pulse) => {
      network.send({ type: 'minigame_input', angle, pulse });
    },
    onPickCasket: (index) => {
      network.send({ type: 'minigame_pick_casket', casketIndex: index });
    },
    onSfx: (name) => {
      audio.init();
      audio.playSfx(name);
    },
  });

  // Clicking the 3D canvas locks pointer (or interacts if already locked!)
  // Works even when Notebook or Calculator is open so you can look & walk with them visible!
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (!inGame || isBlockingOverlayOpen()) return;
    audio.init();
    if (!controller.isPointerLocked) {
      controller.requestPointerLock();
      return;
    }
    if (e.button === 0) {
      performInteract();
    } else if (e.button === 1) {
      e.preventDefault();
      triggerCoopPing();
    }
  });

  // Also click the pointer-lock banner to resume looking around
  document.getElementById('pointer-lock-banner')?.addEventListener('click', () => {
    if (inGame && !isAnyOverlayOpen()) {
      audio.init();
      controller.requestPointerLock();
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (!inGame || !gameState) return;
    // Secret debug combo: Ctrl + Shift + U unlocks all wing doors & grants reusable tools
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === 'KeyU') {
      e.preventDefault();
      network.send({ type: 'debug_unlock_all' });
      return;
    }
    // Don't hijack typing inside text inputs/textareas/selects (allow range sliders!)
    if (isTypingTarget(e.target)) {
      if (e.code === 'Escape') {
        (e.target as HTMLElement).blur();
      }
      return;
    }

    if (e.code === 'Escape') {
      if (modals.isOpen()) {
        modals.close();
      } else if (tools.isNotebookOpen()) {
        tools.toggleNotebook(false);
      } else if (tools.isCalculatorOpen()) {
        tools.toggleCalculator(false);
      } else if (hintMinigame.isOpen() && gameState.minigame.phase !== 'playing') {
        hintMinigame.close();
      }
      return;
    }

    if (hintMinigame.isOpen()) return; // let minigame handle A/D/Space cleanly!

    if (e.code === 'KeyE' && !modals.isOpen() && controller.isPointerLocked) {
      e.preventDefault();
      performInteract();
    } else if (e.code === 'KeyF' && !modals.isOpen()) {
      e.preventDefault();
      toggleUvLamp();
    } else if (e.code === 'KeyQ' && !modals.isOpen() && controller.isPointerLocked) {
      e.preventDefault();
      triggerCoopPing();
    } else if (e.code === 'KeyN') {
      e.preventDefault();
      if (!tools.isNotebookOpen()) controller.exitPointerLock();
      tools.toggleNotebook();
    } else if (e.code === 'KeyC') {
      e.preventDefault();
      if (!tools.isCalculatorOpen()) controller.exitPointerLock();
      tools.toggleCalculator();
    } else if (e.code === 'KeyH') {
      e.preventDefault();
      openOracleMinigame();
    } else if (e.code === 'KeyM') {
      audio.init();
      audio.setMuted(!audio.isMuted());
    } else if (e.code.startsWith('Digit') && !modals.isOpen()) {
      const idx = Number(e.code.replace('Digit', '')) - 1;
      if (idx >= 0 && idx < gameState.inventory.length) {
        const item = gameState.inventory[idx];
        controller.heldItem = item;
        if (item === 'tool_uv_lamp') {
          toggleUvLamp();
        } else {
          audio.playSfx('dial_click');
        }
      }
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function enterManor(): void {
  if (!gameState) return;
  audio.init();
  inGame = true;
  lobbyOverlay.classList.add('hidden');
  hudRoot.classList.remove('hidden');

  const me = gameState.players[myPlayerId];
  if (me) {
    controller.teleport(me.transform.x, me.transform.y, me.transform.z, me.transform.yaw);
  }
  tools.updateState(gameState);
  hud.update(gameState, myPlayerId, controller.currentZone, controller.heldItem);
  hud.setPointerLocked(false, gameState.roomCode);
  controller.requestPointerLock();
}

function bindLobbyEvents(): void {
  // Default random cozy apprentice name if empty
  const names = ['Horologist', 'Starweaver', 'Clocksmith', 'Botanist', 'Luminist'];
  playerNameInput.value = names[Math.floor(Math.random() * names.length)];

  copyLanBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(lanUrlEl.textContent || '').catch(() => {});
    copyLanBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyLanBtn.textContent = 'Copy';
    }, 1500);
  });

  createRoomBtn.addEventListener('click', async () => {
    showLobbyError(null);
    try {
      await network.connect();
      network.send({ type: 'create_room', playerName: playerNameInput.value.trim() || 'Apprentice 1' });
    } catch (err) {
      showLobbyError((err as Error).message);
    }
  });

  joinRoomBtn.addEventListener('click', async () => {
    showLobbyError(null);
    const code = roomCodeInput.value.trim().toUpperCase();
    if (code.length < 3) {
      showLobbyError('Please enter a 4-letter Room Code.');
      return;
    }
    try {
      await network.connect();
      let savedPlayerId: string | undefined;
      try {
        const raw = sessionStorage.getItem('solstice_session');
        if (raw) {
          const parsed = JSON.parse(raw) as { roomCode?: string; playerId?: string };
          if (parsed.roomCode === code) savedPlayerId = parsed.playerId;
        }
      } catch {
        // ignore
      }
      network.send({
        type: 'join_room',
        roomCode: code,
        playerName: playerNameInput.value.trim() || 'Apprentice 2',
        playerId: savedPlayerId,
      });
    } catch (err) {
      showLobbyError((err as Error).message);
    }
  });

  enterManorBtn.addEventListener('click', () => {
    enterManor();
  });

  leaveRoomBtn.addEventListener('click', () => {
    network.disconnect();
    gameState = null;
    inGame = false;
    lobbyWaiting.classList.add('hidden');
    lobbyJoinForm.classList.remove('hidden');
    fetchLanInfo();
  });
}

function bindNetworkMessages(): void {
  network.onMessage((msg) => {
    if (msg.type === 'error') {
      if (!inGame) {
        showLobbyError(msg.message);
      } else {
        hud.showToast(msg.message, 'warning');
      }
      return;
    }

    if (msg.type === 'room_joined') {
      myPlayerId = msg.playerId;
      myPlayerSlot = msg.playerSlot;
      gameState = msg.state;
      try {
        sessionStorage.setItem(
          'solstice_session',
          JSON.stringify({
            roomCode: msg.roomCode,
            playerId: msg.playerId,
            playerName: msg.state.players[msg.playerId]?.name ?? 'Apprentice',
          }),
        );
      } catch {
        // ignore storage errors
      }

      lobbyJoinForm.classList.add('hidden');
      lobbyWaiting.classList.remove('hidden');
      waitingRoomCode.textContent = msg.roomCode;
      renderWaitingPlayers(gameState);
      return;
    }

    if (msg.type === 'state_sync') {
      const prevPhase = gameState?.minigame.phase;
      gameState = msg.state;

      if (!inGame) {
        renderWaitingPlayers(gameState);
      } else {
        modals.refreshIfOpen(gameState);
        tools.updateState(gameState);
        hud.update(gameState, myPlayerId, controller.currentZone, controller.heldItem);

        // Auto-open Hint Minigame overlay if partner started it or fate_draw began!
        if (
          (gameState.minigame.phase === 'playing' || gameState.minigame.phase === 'fate_draw') &&
          !hintMinigame.isOpen()
        ) {
          openOracleMinigame();
        }
        if (hintMinigame.isOpen() || prevPhase !== gameState.minigame.phase) {
          hintMinigame.updateState(gameState, myPlayerSlot);
        }

        // Check victory screen!
        if (gameState.completedAt && !victoryShown) {
          victoryShown = true;
          controller.exitPointerLock();
          modals.close();
          hintMinigame.close();
          hud.showVictory(gameState, () => window.location.reload());
        }
      }
      return;
    }

    if (msg.type === 'player_moved' && gameState) {
      const target = gameState.players[msg.playerId];
      if (target) {
        target.transform = msg.transform;
      }
      return;
    }

    if (msg.type === 'minigame_tick' && gameState) {
      gameState.minigame = msg.minigame;
      hintMinigame.updateTick(msg.minigame, myPlayerSlot, msg.serverTime);
      return;
    }

    if (msg.type === 'world_event') {
      if (msg.sfx) {
        if (msg.sfx.startsWith('harp_')) {
          const color = msg.sfx.replace('harp_', '') as 'amber' | 'emerald' | 'azure' | 'violet';
          audio.playWindHarp(color);
        } else {
          audio.playSfx(msg.sfx);
        }
      }

      if (!msg.message || !inGame) return;

      if (msg.event === 'coop_prompt') {
        hud.showCoopBanner(msg.message);
        if (coopBannerTimer) clearTimeout(coopBannerTimer);
        coopBannerTimer = setTimeout(() => hud.showCoopBanner(null), 5500);
      } else if (msg.event === 'key_consumed') {
        hud.showToast(msg.message, 'key');
      } else if (msg.event === 'puzzle_solved' || msg.event === 'victory') {
        hud.showToast(msg.message, 'success');
      } else if (msg.event === 'error') {
        hud.showToast(msg.message, 'warning');
      } else {
        hud.showToast(msg.message, 'info');
      }
    }
  });
}

// === MAIN 60FPS ANIMATION LOOP ===
let prevTime = performance.now();

function animate(now: number): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - prevTime) / 1000);
  prevTime = now;

  if (gameState) {
    const { moving } = controller.update(dt, gameState, world, (frameIndex) => {
      network.send({ type: 'uv_reveal', frameIndex });
    });

    // Update 3D world animations, doors, solar beams, partner avatar, pings
    world.updateFromState(gameState, myPlayerId, dt, now / 1000);

    if (inGame) {
      // Update spatial audio soundscape smoothly
      audio.updateSpatial(
        controller.x,
        controller.y,
        controller.z,
        controller.currentZone.id,
        dt,
      );

      // Update HUD
      hud.update(gameState, myPlayerId, controller.currentZone, controller.heldItem);
      hud.setInteractPrompt(isBlockingOverlayOpen() ? null : controller.targetedLabel);

      // Stream player transform to LAN partner at 20Hz
      if (now - lastTransformSentAt >= 50) {
        lastTransformSentAt = now;
        network.send({ type: 'player_move', transform: controller.getTransform(moving) });
      }
    }
  } else {
    // Gentle scenic courtyard camera orbit behind the lobby screen!
    const t = now * 0.00018;
    camera.position.set(Math.sin(t) * 8.5, 4.2, -4 + Math.cos(t) * 9.0);
    camera.lookAt(0, 1.4, -4);
  }

  renderer.render(world.scene, camera);
}

// === BOOTSTRAP ===
initThreeAndUi();
bindLobbyEvents();
bindNetworkMessages();
fetchLanInfo();
setInterval(() => {
  if (!inGame && !gameState) {
    fetchLanInfo();
  }
}, 4000);
requestAnimationFrame(animate);
