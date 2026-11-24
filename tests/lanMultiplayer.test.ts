import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { ServerMessage } from '../src/shared/types.js';

const TEST_PORT = 3489;

function waitForMessage(ws: WebSocket, predicate: (m: ServerMessage) => boolean, timeoutMs = 4000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('Timed out waiting for WS message'));
    }, timeoutMs);
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

describe('Live LAN Server + 2-Client WebSocket Multiplayer Integration', () => {
  let serverProc: ChildProcess | null = null;

  afterAll(() => {
    serverProc?.kill('SIGTERM');
  });

  it('hosts a room over HTTP + WebSocket, connects 2 LAN clients, syncs coop puzzles & hint minigame', async () => {
    serverProc = spawn('npx', ['tsx', 'src/server/index.ts'], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until /api/info responds
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/info`);
        if (res.ok) {
          const json = (await res.json()) as { port: number; lanUrl: string };
          expect(json.port).toBe(TEST_PORT);
          expect(json.lanUrl).toContain(`:${TEST_PORT}`);
          ready = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(ready).toBe(true);

    // Connect Player 1 & create room
    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    await new Promise((res) => ws1.once('open', res));
    const p1JoinedPromise = waitForMessage(ws1, (m) => m.type === 'room_joined');
    ws1.send(JSON.stringify({ type: 'create_room', playerName: 'Apprentice One' }));
    const p1Joined = (await p1JoinedPromise) as Extract<ServerMessage, { type: 'room_joined' }>;
    expect(p1Joined.playerSlot).toBe(1);
    const roomCode = p1Joined.roomCode;

    // Verify /api/info lists the active room for LAN discovery!
    const infoRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/info`);
    const infoJson = (await infoRes.json()) as { activeRooms: { roomCode: string; playerCount: number }[] };
    expect(infoJson.activeRooms.some((r) => r.roomCode === roomCode && r.playerCount === 1)).toBe(true);

    // Connect Player 2 & join the room
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    await new Promise((res) => ws2.once('open', res));
    const p2JoinedPromise = waitForMessage(ws2, (m) => m.type === 'room_joined');
    ws2.send(JSON.stringify({ type: 'join_room', roomCode, playerName: 'Apprentice Two' }));
    const p2Joined = (await p2JoinedPromise) as Extract<ServerMessage, { type: 'room_joined' }>;
    expect(p2Joined.playerSlot).toBe(2);

    // Player 1 solves Foyer Clock -> both clients receive state_sync!
    const clockSync2 = waitForMessage(ws2, (m) => m.type === 'state_sync' && m.state.solvedPuzzles.p1_foyer_clock);
    ws1.send(JSON.stringify({ type: 'interact', targetId: 'p1_clock_set', payload: { digits: [0, 9, 3, 5] } }));
    const synced = (await clockSync2) as Extract<ServerMessage, { type: 'state_sync' }>;
    expect(synced.state.solvedPuzzles.p1_foyer_clock).toBe(true);

    // Both players pull Twin Courtyard Levers simultaneously -> Courtyard Door opens!
    const doorSync = waitForMessage(ws1, (m) => m.type === 'state_sync' && m.state.doors.courtyard_door);
    ws1.send(JSON.stringify({ type: 'interact', targetId: 'lever_foyer_left' }));
    ws2.send(JSON.stringify({ type: 'interact', targetId: 'lever_foyer_right' }));
    const doorState = (await doorSync) as Extract<ServerMessage, { type: 'state_sync' }>;
    expect(doorState.state.doors.courtyard_door).toBe(true);

    // Both players ready up for Clockwork Oracle Hint Minigame -> enters playing phase live!
    const mgStart = waitForMessage(ws2, (m) => m.type === 'state_sync' && m.state.minigame.phase === 'playing');
    ws1.send(JSON.stringify({ type: 'minigame_ready' }));
    ws2.send(JSON.stringify({ type: 'minigame_ready' }));
    const mgState = (await mgStart) as Extract<ServerMessage, { type: 'state_sync' }>;
    expect(mgState.state.minigame.phase).toBe('playing');

    ws1.close();
    ws2.close();
  }, 15000);
});
