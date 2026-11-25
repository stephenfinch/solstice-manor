import * as THREE from 'three';
import { FloorMaterial, ItemId, PlayerTransform, WorldState } from '../shared/types.js';
import {
  computeFloorHeight,
  detectZone,
  isLineOfSightBlocked,
  WORLD_COLLIDERS,
  ZoneDefinition,
} from '../shared/worldLayout.js';
import { BuiltWorld, DECOR_COLLIDERS, InteractableObject } from './worldBuilder.js';
import { isTypingTarget } from './ui/hud.js';

const ALL_COLLIDERS = [...WORLD_COLLIDERS, ...DECOR_COLLIDERS];
// Solid hedges, planters, and structural partitions that also block interaction line-of-sight
const LOS_DECOR_OCCLUDERS = DECOR_COLLIDERS.filter(
  (b) =>
    b.id.includes('hedge') ||
    b.id.includes('planter') ||
    b.id.includes('ramp_end') ||
    b.id.includes('mural_wall') ||
    b.id.includes('bookshelves'),
);

const PLAYER_RADIUS = 0.38;
const EYE_HEIGHT_STAND = 1.68;
const EYE_HEIGHT_CROUCH = 1.02;
const WALK_SPEED = 4.5;
const SPRINT_SPEED = 6.3;
const CROUCH_SPEED = 2.55;
const JUMP_VELOCITY = 5.1;
const GRAVITY = 15.5;

export class FirstPersonController {
  public camera: THREE.PerspectiveCamera;
  public x = 0;
  public y = 0;
  public z = 14.5;
  public yaw = 0; // facing North (-Z)
  public pitch = 0;
  public uvOn = false;
  public crouching = false;
  public heldItem: ItemId | null = null;
  public isPointerLocked = false;
  public currentZone: ZoneDefinition;
  public targetedObject: InteractableObject | null = null;
  public targetedLabel: string | null = null;

  private keys = new Set<string>();
  private crouchToggled = false;
  private vx = 0;
  private vz = 0;
  private vy = 0;
  private grounded = true;
  private coyoteTimer = 0;
  private eyeHeight = EYE_HEIGHT_STAND;
  private bobTimer = 0;
  private bobAmp = 0;
  private stepAccum = 0;

  private domElement: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private screenCenter = new THREE.Vector2(0, 0);
  private onFootstep: (material: FloorMaterial) => void;
  private onPointerLockChange: (locked: boolean) => void;
  private canMove: () => boolean;
  private meshToInteractable = new Map<THREE.Object3D, InteractableObject>();
  private lastInteractablesVersion = -1;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    world: BuiltWorld,
    callbacks: {
      onFootstep: (material: FloorMaterial) => void;
      onPointerLockChange: (locked: boolean) => void;
      canMove: () => boolean;
    },
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.onFootstep = callbacks.onFootstep;
    this.onPointerLockChange = callbacks.onPointerLockChange;
    this.canMove = callbacks.canMove;
    this.currentZone = detectZone(this.x, this.y, this.z);

    this.reindexInteractables(world);
    this.bindEvents();
  }

  private reindexInteractables(world: BuiltWorld): void {
    this.meshToInteractable.clear();
    for (const item of world.interactables) {
      item.mesh.traverse((child) => {
        this.meshToInteractable.set(child, item);
      });
    }
    this.lastInteractablesVersion = world.interactablesVersion ?? world.interactables.length;
  }

  public teleport(x: number, y: number, z: number, yaw: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.grounded = true;
    this.coyoteTimer = 0;
    this.crouching = false;
    this.crouchToggled = false;
    this.eyeHeight = EYE_HEIGHT_STAND;
    this.bobAmp = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.currentZone = detectZone(x, y, z);
    this.applyCameraTransform(0);
  }

  public requestPointerLock(): void {
    if (document.pointerLockElement !== this.domElement) {
      try {
        const res = this.domElement.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      } catch {
        // Ignore browser SecurityError/NotAllowedError when pointer lock is disallowed
      }
    }
  }

  public exitPointerLock(): void {
    if (document.pointerLockElement === this.domElement) {
      document.exitPointerLock?.();
    }
  }

  private bindEvents(): void {
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.domElement;
      if (!this.isPointerLocked) {
        this.keys.clear();
      }
      this.onPointerLockChange(this.isPointerLocked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked || !this.canMove()) return;
      // Clamp macOS/Chromium PointerLock single-frame glitch spikes so look never jerks
      const dx = Math.max(-120, Math.min(120, e.movementX));
      const dy = Math.max(-120, Math.min(120, e.movementY));
      const sensitivity = 0.0021;
      this.yaw -= dx * sensitivity;
      this.pitch -= dy * sensitivity;
      this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch));
    });

    window.addEventListener('keydown', (e) => {
      if (!this.canMove() || isTypingTarget(e.target)) return;
      this.keys.add(e.code);

      // Jump on Space (when not repeating)
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (this.grounded || this.coyoteTimer > 0) {
          this.vy = JUMP_VELOCITY;
          this.grounded = false;
          this.coyoteTimer = 0;
          this.crouchToggled = false;
          this.onFootstep(this.currentZone.material);
        }
      }

      // Toggle crouch with V (hold Control also crouches)
      if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.crouchToggled = !this.crouchToggled;
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
    });
  }

  private collidesAt(nx: number, ny: number, nz: number, state: WorldState): boolean {
    const pMinY = ny + 0.18;
    const pMaxY = ny + (this.crouching ? 1.15 : 1.75);

    for (const box of ALL_COLLIDERS) {
      if (box.doorId && state.doors[box.doorId]) {
        continue; // Door is open!
      }
      if (pMaxY <= box.minY || pMinY >= box.maxY) {
        continue; // Different elevation layer (e.g. Observatory railings vs ground floor)
      }
      if (
        nx + PLAYER_RADIUS > box.minX &&
        nx - PLAYER_RADIUS < box.maxX &&
        nz + PLAYER_RADIUS > box.minZ &&
        nz - PLAYER_RADIUS < box.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  public update(
    dt: number,
    state: WorldState,
    myPlayerId: string,
    world: BuiltWorld,
  ): { moved: boolean; moving: boolean } {
    const clampedDt = Math.min(0.05, dt);

    // Keep interactable raycast map synced when dropped items spawn/despawn
    const currentVer = world.interactablesVersion ?? world.interactables.length;
    if (currentVer !== this.lastInteractablesVersion) {
      this.reindexInteractables(world);
    }

    let wantForward = 0;
    let wantStrafe = 0;
    let holdCrouch = false;
    let wantSprint = false;

    if (!this.canMove() || isTypingTarget(document.activeElement)) {
      this.keys.clear();
    } else {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) wantForward += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) wantForward -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) wantStrafe += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) wantStrafe -= 1;
      holdCrouch = this.keys.has('ControlLeft') || this.keys.has('ControlRight');
      wantSprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    }

    this.crouching = holdCrouch || this.crouchToggled;
    const targetEye = this.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
    this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-14 * clampedDt));

    const inputLen = Math.hypot(wantForward, wantStrafe);
    let targetVx = 0;
    let targetVz = 0;
    const maxSpeed = this.crouching
      ? CROUCH_SPEED
      : wantSprint
        ? SPRINT_SPEED
        : WALK_SPEED;

    if (inputLen > 0) {
      const nf = wantForward / inputLen;
      const ns = wantStrafe / inputLen;
      // Forward vector in Three.js camera yaw convention: (-sin(yaw), -cos(yaw))
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      targetVx = (fx * nf + rx * ns) * maxSpeed;
      targetVz = (fz * nf + rz * ns) * maxSpeed;
    }

    // Smooth exponential velocity inertia (zero sudden jerks on keydown/keyup!)
    const accelRate = this.grounded ? (inputLen > 0 ? 15 : 18) : 5.5;
    const blend = 1 - Math.exp(-accelRate * clampedDt);
    this.vx += (targetVx - this.vx) * blend;
    this.vz += (targetVz - this.vz) * blend;

    const horizSpeed = Math.hypot(this.vx, this.vz);
    if (inputLen === 0 && horizSpeed < 0.02) {
      this.vx = 0;
      this.vz = 0;
    }

    const moving = horizSpeed > 0.15;

    // If a closing door (e.g. Tea North Grille) ever closed on top of the player,
    // smoothly nudge them out to the nearest clear side so they can never be trapped!
    if (this.collidesAt(this.x, this.y, this.z, state)) {
      const offsets = [
        [0.45, 0],
        [-0.45, 0],
        [0, 0.45],
        [0, -0.45],
        [0.9, 0],
        [-0.9, 0],
        [0, 0.9],
        [0, -0.9],
      ];
      for (const [ox, oz] of offsets) {
        const ny = computeFloorHeight(this.x + ox, this.y, this.z + oz);
        if (!this.collidesAt(this.x + ox, ny, this.z + oz, state)) {
          this.x += ox;
          this.z += oz;
          this.y = ny;
          break;
        }
      }
    }

    // Axis-separated horizontal collision resolution (no vertical snap!)
    const dx = this.vx * clampedDt;
    const dz = this.vz * clampedDt;

    if (Math.abs(dx) > 1e-6) {
      const tryX = this.x + dx;
      const checkYX = Math.max(this.y, computeFloorHeight(tryX, this.y, this.z));
      if (!this.collidesAt(tryX, checkYX, this.z, state)) {
        this.x = tryX;
      } else {
        this.vx = 0;
      }
    }

    if (Math.abs(dz) > 1e-6) {
      const tryZ = this.z + dz;
      const checkYZ = Math.max(this.y, computeFloorHeight(this.x, this.y, tryZ));
      if (!this.collidesAt(this.x, checkYZ, tryZ, state)) {
        this.z = tryZ;
      } else {
        this.vz = 0;
      }
    }

    // Vertical physics: smooth ramp tracking + Jump & Gravity
    const floorY = computeFloorHeight(this.x, this.y, this.z);
    if (this.grounded) {
      this.coyoteTimer = 0.1;
      if (floorY < this.y - 0.35) {
        // Stepped off an edge
        this.grounded = false;
      } else {
        this.y += (floorY - this.y) * (1 - Math.exp(-22 * clampedDt));
      }
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - clampedDt);
      this.vy -= GRAVITY * clampedDt;
      this.y += this.vy * clampedDt;
      if (this.y <= floorY) {
        const impactVy = this.vy;
        this.y = floorY;
        this.vy = 0;
        this.grounded = true;
        if (impactVy < -2.4) {
          this.onFootstep(this.currentZone.material);
        }
      }
    }

    // Smoothly damped head-bob (never snaps abruptly to 0 on key release!)
    const speedRatio = this.grounded ? Math.min(1.25, horizSpeed / WALK_SPEED) : 0;
    const bobBlend = 1 - Math.exp(-(speedRatio > 0.05 ? 10 : 12) * clampedDt);
    this.bobAmp += (speedRatio - this.bobAmp) * bobBlend;
    if (speedRatio > 0.05) {
      const freq = this.crouching ? 6.5 : horizSpeed > 5.2 ? 11.0 : 8.4;
      this.bobTimer += clampedDt * freq;
      this.stepAccum += horizSpeed * clampedDt;
      const stride = this.crouching ? 1.55 : horizSpeed > 5.2 ? 2.15 : 1.85;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this.onFootstep(this.currentZone.material);
      }
    }

    this.currentZone = detectZone(this.x, this.y, this.z);
    const bobOffset = Math.sin(this.bobTimer) * 0.032 * this.bobAmp;
    this.applyCameraTransform(bobOffset);

    // Update local UV spotlight attached to camera (checks THIS player's personal inventory!)
    const me = state.players[myPlayerId];
    const hasUvTool = !!me?.inventory.includes('tool_uv_lamp');
    if (!hasUvTool && this.uvOn) {
      this.uvOn = false;
    }
    world.setLocalUvLight(this.camera, this.uvOn && hasUvTool);

    // Raycast interactables from screen center
    this.updateInteractTarget(state, world);

    return { moved: moving || !this.grounded, moving };
  }

  private applyCameraTransform(bobOffset: number): void {
    this.camera.position.set(this.x, this.y + this.eyeHeight + bobOffset, this.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }

  private updateInteractTarget(state: WorldState, world: BuiltWorld): void {
    this.targetedObject = null;
    this.targetedLabel = null;
    if (!this.isPointerLocked || !this.canMove()) return;

    this.raycaster.setFromCamera(this.screenCenter, this.camera);
    this.raycaster.far = 5.2;

    const candidateRoots = world.interactables.map((i) => i.mesh);
    const hits = this.raycaster.intersectObjects(candidateRoots, true);

    const rayOrigin = this.raycaster.ray.origin;
    const rayDir = this.raycaster.ray.direction;

    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      let found: InteractableObject | undefined;
      while (node) {
        found = this.meshToInteractable.get(node);
        if (found) break;
        node = node.parent;
      }
      if (!found) continue;
      if (!found.mesh.visible) continue;
      const maxD = found.maxDistance ?? 4.5;
      if (hit.distance > maxD) continue;

      // Reject any object behind a solid wall, closed door, glass partition, or hedge!
      if (
        isLineOfSightBlocked(
          rayOrigin.x,
          rayOrigin.y,
          rayOrigin.z,
          rayDir.x,
          rayDir.y,
          rayDir.z,
          hit.distance,
          state.doors,
          LOS_DECOR_OCCLUDERS,
          found.actionType === 'door' ? found.doorId : undefined,
        )
      ) {
        continue;
      }

      const label = found.getLabel ? found.getLabel(state) : found.label;
      if (!label) continue;

      this.targetedObject = found;
      this.targetedLabel = label;
      return;
    }
  }

  public raycastWorldPoint(scene: THREE.Scene): THREE.Vector3 {
    this.raycaster.setFromCamera(this.screenCenter, this.camera);
    this.raycaster.far = 36;
    const hits = this.raycaster.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (h.distance > 0.6) {
        return h.point.clone();
      }
    }
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return this.camera.position.clone().addScaledVector(dir, 12);
  }

  public getTransform(moving: boolean): PlayerTransform {
    return {
      x: Math.round(this.x * 1000) / 1000,
      y: Math.round(this.y * 1000) / 1000,
      z: Math.round(this.z * 1000) / 1000,
      yaw: Math.round(this.yaw * 1000) / 1000,
      pitch: Math.round(this.pitch * 1000) / 1000,
      moving,
      crouching: this.crouching,
      zone: this.currentZone.id,
      uvOn: this.uvOn,
      heldItem: this.heldItem,
    };
  }
}
