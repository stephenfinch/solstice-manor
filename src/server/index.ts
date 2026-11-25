import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessage, HintMode, ServerMessage } from '../shared/types.js';
import { GameRoom } from './roomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DIST_CLIENT = path.join(ROOT_DIR, 'dist/client');

const PORT = Number(process.env.PORT || 3000);

function getLanIpAddresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

interface ClientSocket extends WebSocket {
  playerId?: string;
  roomCode?: string;
  isAlive?: boolean;
}

const rooms = new Map<string, GameRoom>();
const roomSockets = new Map<string, Set<ClientSocket>>();

function createRoom(hintMode: HintMode = 'oracle'): GameRoom {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
  }
  const sockets = new Set<ClientSocket>();
  roomSockets.set(code, sockets);

  const room = new GameRoom(
    code,
    {
      broadcast: (msg: ServerMessage, excludePlayerId?: string) => {
        const payload = JSON.stringify(msg);
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN && ws.playerId !== excludePlayerId) {
            ws.send(payload);
          }
        }
      },
      sendTo: (playerId: string, msg: ServerMessage) => {
        const payload = JSON.stringify(msg);
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN && ws.playerId === playerId) {
            ws.send(payload);
          }
        }
      },
    },
    hintMode,
  );
  room.startLoop();
  rooms.set(code, room);
  return room;
}

const app = express();
app.use(express.json());

// LAN discovery & active sessions API
app.get('/api/info', (_req, res) => {
  const lanIps = getLanIpAddresses();
  const primaryIp = lanIps[0] || 'localhost';
  const activeRooms = Array.from(rooms.values())
    .map((r) => {
      const players = Object.values(r.state.players);
      const connected = players.filter((p) => p.connected);
      return {
        roomCode: r.state.roomCode,
        playerCount: connected.length,
        playerNames: connected.map((p) => p.name),
        completed: r.state.completedAt !== null,
      };
    })
    .filter((r) => r.playerCount > 0 && !r.completed);

  res.json({
    port: PORT,
    lanIps,
    lanUrl: `http://${primaryIp}:${PORT}`,
    activeRooms,
  });
});

// Serve built client in production mode (or if dist/client exists)
if (fs.existsSync(DIST_CLIENT)) {
  app.use(express.static(DIST_CLIENT));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_CLIENT, 'index.html'));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Heartbeat to detect dropped Wi-Fi / sleeping laptops cleanly so slots free up for reconnect
setInterval(() => {
  for (const client of wss.clients) {
    const cs = client as ClientSocket;
    if (cs.isAlive === false) {
      cs.terminate();
      continue;
    }
    cs.isAlive = false;
    cs.ping();
  }
}, 8000);

wss.on('connection', (ws: ClientSocket) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'create_room') {
      const room = createRoom(msg.hintMode);
      const player = room.addOrReconnectPlayer(msg.playerName, undefined, msg.appearance);
      if (!player) {
        send(ws, { type: 'error', message: 'Failed to create room.' });
        return;
      }
      ws.playerId = player.id;
      ws.roomCode = room.state.roomCode;
      roomSockets.get(room.state.roomCode)!.add(ws);

      send(ws, {
        type: 'room_joined',
        roomCode: room.state.roomCode,
        playerId: player.id,
        playerSlot: player.slot,
        state: room.getSanitizedState(),
      });
      return;
    }

    if (msg.type === 'join_room') {
      const code = (msg.roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: `Room "${code}" not found on this LAN server.` });
        return;
      }
      const player = room.addOrReconnectPlayer(msg.playerName, msg.playerId, msg.appearance);
      if (!player) {
        send(ws, {
          type: 'error',
          message: `Room "${code}" already has 2 apprentices connected!`,
        });
        return;
      }
      ws.playerId = player.id;
      ws.roomCode = code;
      roomSockets.get(code)!.add(ws);

      send(ws, {
        type: 'room_joined',
        roomCode: code,
        playerId: player.id,
        playerSlot: player.slot,
        state: room.getSanitizedState(),
      });
      room.emitEvent('info', `${player.name} joined Solstice Manor.`, 'pickup');
      room.syncAll();
      return;
    }

    if (!ws.roomCode || !ws.playerId) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    switch (msg.type) {
      case 'update_appearance':
        room.handleUpdateAppearance(ws.playerId, msg.appearance);
        break;
      case 'player_move':
        room.updatePlayerTransform(ws.playerId, msg.transform);
        break;
      case 'interact':
        room.handleInteract(ws.playerId, msg.targetId, msg.payload);
        break;
      case 'pickup_item':
        room.handlePickup(ws.playerId, msg.itemId);
        break;
      case 'give_or_drop_item':
        room.handleGiveOrDropItem(ws.playerId, msg.itemId, msg.mode, msg.x, msg.y, msg.z);
        break;
      case 'toggle_prop':
        room.handleToggleProp(ws.playerId, msg.propId);
        break;
      case 'unlock_door':
        room.handleUnlockDoor(ws.playerId, msg.doorId);
        break;
      case 'discover_clue':
        room.handleDiscoverClue(msg.clueId);
        break;
      case 'uv_reveal':
        room.handleUvReveal(msg.frameIndex);
        break;
      case 'update_notes':
        room.handleUpdateNotes(msg.text);
        break;
      case 'coop_ping':
        room.handleCoopPing(ws.playerId, msg.x, msg.y, msg.z);
        break;
      case 'request_unlimited_hint':
        room.handleRequestUnlimitedHint(ws.playerId, msg.targetPuzzleId);
        break;
      case 'minigame_ready':
        room.handleMinigameReady(ws.playerId, msg.targetPuzzleId);
        break;
      case 'minigame_cancel':
        room.handleMinigameCancel(ws.playerId);
        break;
      case 'minigame_input':
        room.handleMinigameInput(ws.playerId, msg.angle, msg.pulse);
        break;
      case 'minigame_pick_casket':
        room.handleMinigamePickCasket(ws.playerId, msg.casketIndex);
        break;
      case 'debug_unlock_all':
        room.handleDebugUnlockAll();
        break;
      case 'request_sync':
        send(ws, { type: 'state_sync', state: room.getSanitizedState() });
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !ws.playerId) return;
    const sockets = roomSockets.get(ws.roomCode);
    sockets?.delete(ws);
    const room = rooms.get(ws.roomCode);
    if (room) {
      room.disconnectPlayer(ws.playerId);
      // Clean up empty rooms after 30 minutes of complete inactivity
      const anyConnected = Object.values(room.state.players).some((p) => p.connected);
      if (!anyConnected) {
        const code = ws.roomCode;
        setTimeout(() => {
          const r = rooms.get(code);
          if (r && !Object.values(r.state.players).some((p) => p.connected)) {
            r.stopLoop();
            rooms.delete(code);
            roomSockets.delete(code);
          }
        }, 30 * 60 * 1000);
      }
    }
  });
});

// Listen on 0.0.0.0 so ANY device on the local Wi-Fi/LAN can connect!
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIpAddresses();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        ☀️  SOLSTICE MANOR — 2P LAN ESCAPE ROOM  ☀️        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}                          ║`);
  for (const ip of ips) {
    const line = `  LAN URL: http://${ip}:${PORT}`;
    console.log(`║${line.padEnd(58)}║`);
  }
  console.log('║  Share the LAN URL with your partner on the same Wi-Fi!  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
