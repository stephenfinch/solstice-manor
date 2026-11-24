import * as THREE from 'three';
import { FloorMaterial, ItemId, PlayerTransform, WorldState } from '../shared/types.js';
import { computeFloorHeight, detectZone, WORLD_COLLIDERS, ZoneDefinition } from '../shared/worldLayout.js';
import { BuiltWorld, DECOR_COLLIDERS, InteractableObject } from './worldBuilder.js';

const ALL_COLLIDERS = [...WORLD_COLLIDERS, ...DECOR_COLLIDERS];

const PLAYER_RADIUS = 0.38;
const EYE_HEIGHT = 1.68;
const WALK_SPEED = 4.4;
const SPRINT_SPEED = 6.2;

export class FirstPersonController {
  public camera: THREE.PerspectiveCamera;
  public x = 0;
  public y = 0;
  public z = 14.5;
  public yaw = 0; // facing North (-Z)
  public pitch = 0;
  public uvOn = false;
  public heldItem: ItemId | null = null;
  public isPointerLocked = false;
  public currentZone: ZoneDefinition;
  public targetedObject: InteractableObject | null = null;
  public targetedLabel: string | null = null;

  private keys = new Set<string>();
  private domElement: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private screenCenter = new THREE.Vector2(0, 0);
  private bobTimer = 0;
  private stepAccum = 0;
  private onFootstep: (material: FloorMaterial) => void;
  private onPointerLockChange: (locked: boolean) => void;
  private canMove: () => boolean;
  private meshToInteractable = new Map<THREE.Object3D, InteractableObject>();

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

    // Index all descendant meshes -> interactable object for fast raycasting
    for (const item of world.interactables) {
      item.mesh.traverse((child) => {
        this.meshToInteractable.set(child, item);
      });
    }

    this.bindEvents();
  }

  public teleport(x: number, y: number, z: number, yaw: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.pitch = 0;
    this.currentZone = detectZone(x, y, z);
    this.applyCameraTransform(0);
  }

  public requestPointerLock(): void {
    if (document.pointerLockElement !== this.domElement) {
      this.domElement.requestPointerLock?.();
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
      const sensitivity = 0.0021;
      this.yaw -= e.movementX * sensitivity;
      this.pitch -= e.movementY * sensitivity;
      this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch));
    });

    window.addEventListener('keydown', (e) => {
      if (!this.canMove()) return;
      this.keys.add(e.code);
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
    const pMaxY = ny + 1.75;

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
    world: BuiltWorld,
    onUvFrameSpotted: (frameIndex: number) => void,
  ): { moved: boolean; moving: boolean } {
    const clampedDt = Math.min(0.08, dt);
    let moving = false;

    if (this.canMove() && this.isPointerLocked) {
      let forward = 0;
      let strafe = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;

      const len = Math.hypot(forward, strafe);
      if (len > 0) {
        moving = true;
        forward /= len;
        strafe /= len;
        const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? SPRINT_SPEED : WALK_SPEED;

        // Forward vector in Three.js camera yaw convention: (-sin(yaw), -cos(yaw))
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw);
        const rz = -Math.sin(this.yaw);

        const vx = (fx * forward + rx * strafe) * speed * clampedDt;
        const vz = (fz * forward + rz * strafe) * speed * clampedDt;

        // Axis-separated collision resolution for buttery wall sliding!
        const tryX = this.x + vx;
        const nextYX = computeFloorHeight(tryX, this.y, this.z);
        if (!this.collidesAt(tryX, nextYX, this.z, state)) {
          this.x = tryX;
          this.y = nextYX;
        }

        const tryZ = this.z + vz;
        const nextYZ = computeFloorHeight(this.x, this.y, tryZ);
        if (!this.collidesAt(this.x, nextYZ, tryZ, state)) {
          this.z = tryZ;
          this.y = nextYZ;
        }

        // Smooth elevation update & footsteps
        const targetY = computeFloorHeight(this.x, this.y, this.z);
        this.y += (targetY - this.y) * Math.min(1, clampedDt * 18);

        this.bobTimer += clampedDt * (speed > 5 ? 11.5 : 8.5);
        this.stepAccum += Math.hypot(vx, vz);
        const stride = speed > 5 ? 2.15 : 1.85;
        if (this.stepAccum >= stride) {
          this.stepAccum = 0;
          this.onFootstep(this.currentZone.material);
        }
      }
    }

    this.currentZone = detectZone(this.x, this.y, this.z);
    const bobOffset = moving ? Math.sin(this.bobTimer) * 0.042 : 0;
    this.applyCameraTransform(bobOffset);

    // Update local UV spotlight attached to camera
    const hasUvTool = state.inventory.includes('tool_uv_lamp');
    if (!hasUvTool && this.uvOn) {
      this.uvOn = false;
    }
    world.setLocalUvLight(this.camera, this.uvOn && hasUvTool);

    // Check if UV lamp beam is illuminating any Study UV painting!
    if (this.uvOn && hasUvTool) {
      const camPos = this.camera.position;
      const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      for (const frame of world.uvFrames) {
        if (state.puzzles.uvRevealedFrames.includes(frame.index)) continue;
        const toFrame = frame.worldPos.clone().sub(camPos);
        const dist = toFrame.length();
        if (dist <= 7.0) {
          toFrame.normalize();
          if (camDir.dot(toFrame) > 0.72) {
            onUvFrameSpotted(frame.index);
          }
        }
      }
    }

    // Raycast interactables from screen center
    this.updateInteractTarget(state, world);

    return { moved: moving, moving };
  }

  private applyCameraTransform(bobOffset: number): void {
    this.camera.position.set(this.x, this.y + EYE_HEIGHT + bobOffset, this.z);
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
      zone: this.currentZone.id,
      uvOn: this.uvOn,
      heldItem: this.heldItem,
    };
  }
}
