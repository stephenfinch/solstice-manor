import { ClientMessage, ServerMessage } from '../shared/types.js';

export type ServerMessageHandler = (msg: ServerMessage) => void;

export class LanNetworkClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<ServerMessageHandler>();
  private reconnectInfo: { roomCode: string; playerName: string; playerId: string } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isIntentionalClose = false;

  public connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.isIntentionalClose = false;

      ws.onopen = () => {
        if (this.reconnectInfo) {
          this.send({
            type: 'join_room',
            roomCode: this.reconnectInfo.roomCode,
            playerName: this.reconnectInfo.playerName,
            playerId: this.reconnectInfo.playerId,
          });
        }
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('Could not connect to Solstice Manor LAN server.'));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          if (msg.type === 'room_joined') {
            this.reconnectInfo = {
              roomCode: msg.roomCode,
              playerName: msg.state.players[msg.playerId]?.name ?? 'Apprentice',
              playerId: msg.playerId,
            };
          }
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!this.isIntentionalClose && this.reconnectInfo) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {});
          }, 1500);
        }
      };
    });
  }

  public onMessage(handler: ServerMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  public send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public disconnect(): void {
    this.isIntentionalClose = true;
    this.reconnectInfo = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
