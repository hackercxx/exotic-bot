import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '../middleware/auth';

export type WsEvent =
  | { type: 'event:new'; data: unknown }
  | { type: 'message:new'; data: unknown }
  | { type: 'message:updated'; data: unknown }
  | { type: 'post:updated'; data: unknown }
  | { type: 'account:updated'; data: unknown }
  | { type: 'counters'; data: unknown };

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function setupWebSocket(server: HttpServer) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') return; // let vite HMR / other upgrades pass (none here)
    const token = url.searchParams.get('token');
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    // heartbeat keeps proxies from idling the socket
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(ping);
    }, 25000);
    ws.send(JSON.stringify({ type: 'connected', data: { at: new Date().toISOString() } }));
  });

  return wss;
}

export function broadcast(event: WsEvent) {
  if (clients.size === 0) return;
  const frame = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}

export function connectedClients(): number {
  return clients.size;
}
