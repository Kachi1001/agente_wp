import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { logger } from '../utils/logger';
import { sessionManager } from './SessionManager';
import * as fs from 'fs';
import * as path from 'path';

import { config } from '../config';
import { getApiVersion } from '../docs/openapi';

interface ConnectedClient {
  socketId: string;
  sessionId: string | null;
  connectedAt: string;
  address: string | null;
  userAgent: string | null;
}

class SocketService {
  private io: SocketIOServer | null = null;
  // Clientes (apps consumidores) atualmente conectados — alimenta o menu
  // "apps conectados" do painel /admin.
  private clients: Map<string, ConnectedClient> = new Map();

  init(httpServer: HttpServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    // ── AUTHENTICATION MIDDLEWARE (só ativo com AUTH_ENABLED=true) ──
    const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
    if (AUTH_ENABLED) {
      this.io.use((socket, next) => {
        const token = socket.handshake.query.token || socket.handshake.auth.token;
        const secret = config.webhookSecret;

        // Sem segredo configurado, libera (útil em dev)
        if (!secret) return next();

        if (token === secret) return next();

        logger.error(`[Socket.IO] Auth falhou para cliente ${socket.id} — token inválido.`);
        return next(new Error('Authentication error: Invalid token'));
      });
    }

    this.io.on('connection', (socket) => {
      const sessionId = socket.handshake.query.sessionId as string;
      logger.info(`[Socket.IO] New client connected: ${socket.id}${sessionId ? ` (Session: ${sessionId})` : ''}`);

      // Registra o cliente para o menu "apps conectados" do painel.
      this.clients.set(socket.id, {
        socketId: socket.id,
        sessionId: sessionId || (socket.handshake.query.admin ? '(admin)' : null),
        connectedAt: new Date().toISOString(),
        address: socket.handshake.address || null,
        userAgent: (socket.handshake.headers['user-agent'] as string) || null,
      });
      this.broadcastClients();

      // Informa o hash atual de capacidades da API ao cliente recém-conectado.
      // Se ele tiver um hash diferente do guardado, rebusca /api/docs/openapi.json.
      socket.emit('capabilities.updated', getApiVersion());

      // ── VERIFICAR SESSÃO AO CONECTAR ──
      if (sessionId) {
        socket.join(sessionId); // Entra na "sala" exclusiva desta sessão
        const status = sessionManager.getSessionStatus(sessionId);
        // Emite o status atual especificamente para este cliente recém-conectado
        socket.emit('current_status', { sessionId, ...status });

        // ── PROCESSAR CACHE IMEDIATAMENTE (Se houver) ──
        this.processCache(sessionId);
      }

      // ── ENVIAR MENSAGEM VIA SOCKET ──
      socket.on('send_message', async (data: {
        sessionId: string,
        to: string,
        text: string,
        mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt'
      }, callback) => {
        try {
          const { sessionId, to, text, mediaType } = data;
          logger.info(`[Socket.IO] Request to send message from "${sessionId}" to "${to}"`);

          const result = await sessionManager.sendMessage(sessionId, to, text, mediaType);

          if (callback) callback({ success: true, messageId: result.id, serializedId: result.serializedId });
        } catch (err: any) {
          logger.error(`[Socket.IO] Error sending message: ${err.message}`);
          if (callback) callback({ success: false, error: err.message });
        }
      });

      // ── SOLICITAR STATUS OU ENTRAR NA SESSÃO ──
      socket.on('join_session', (data: { sessionId: string }, callback) => {
        try {
          const { sessionId } = data;
          socket.join(sessionId); // Entra na "sala" da sessão informada
          const c = this.clients.get(socket.id);
          if (c) { c.sessionId = sessionId; this.broadcastClients(); }
          const status = sessionManager.getSessionStatus(sessionId);
          logger.info(`[Socket.IO] Client ${socket.id} joined session ${sessionId}. Status: ${status.status}`);

          socket.emit('current_status', { sessionId, ...status });

          // ── PROCESSAR CACHE AO ENTRAR ──
          this.processCache(sessionId);

          if (callback) callback({ success: true, ...status });
        } catch (err: any) {
          logger.error(`[Socket.IO] Error in join_session: ${err.message}`);
          if (callback) callback({ success: false, error: err.message });
        }
      });

      // ── PEDIR STATUS DA SESSÃO ──
      socket.on('get_status', (data: { sessionId: string }, callback) => {
        try {
          const status = sessionManager.getSessionStatus(data.sessionId);
          if (callback) callback(status);
        } catch (err: any) {
          if (callback) callback({ exists: false, error: err.message });
        }
      });

      socket.on('disconnect', () => {
        logger.info(`[Socket.IO] Client disconnected: ${socket.id}`);
        this.clients.delete(socket.id);
        this.broadcastClients();
      });
    });

    logger.info('[Socket.IO] Initialized');
  }

  /**
   * Broadcast dedicado do snapshot de sessões para o painel /admin.
   * Vai para todos os clientes conectados no evento 'admin:sessions' SEM o mirror
   * de 'events' (não polui os listeners de mensagens das sessões).
   */
  broadcastAdmin(snapshot: any) {
    if (!this.io) return;
    this.io.emit('admin:sessions', snapshot);
  }

  /** Stream ao vivo de log por sessão para o painel /admin (terminal por sessão). */
  broadcastAdminLog(sessionId: string, line: { ts: string; level: string; event: string; meta?: any }) {
    if (!this.io) return;
    this.io.emit('admin:log', { sessionId, ...line });
  }

  /** Clientes (apps consumidores) atualmente conectados — para o painel. */
  getConnectedClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  /** Push do menu "apps conectados" sempre que a lista muda. */
  private broadcastClients() {
    if (!this.io) return;
    this.io.emit('admin:clients', { ts: new Date().toISOString(), clients: this.getConnectedClients() });
  }

  emit(event: string, payload: any) {
    if (!this.io) {
      logger.warn(`[Socket.IO] Attempted to emit "${event}" before initialization`);
      return;
    }

    // Se o evento é para uma sessão específica, emite apenas para os clientes que entraram nela
    if (payload && payload.session) {
      const sessionId = payload.session;
      const room = this.io.sockets.adapter.rooms.get(sessionId);
      const hasListeners = room && room.size > 0;

      if (hasListeners) {
        logger.info(`[Socket.IO] Emitting ${event} for session "${sessionId}"`);

        this.io.to(sessionId).emit(event, payload);
        if (event !== 'events') {
          this.io.to(sessionId).emit('events', payload);
        }
      } else {
        // logger.info(`[Socket.IO] No active listeners for session "${sessionId}". Caching event "${event}".`);
        this.addToCache(sessionId, { event, payload, timestamp: new Date().toISOString() });
      }
    } else {
      // Fallback: broadcast para todos
      this.io.emit(event, payload);
      if (event !== 'events') {
        this.io.emit('events', payload);
      }
    }
  }

  private addToCache(sessionId: string, data: any) {
    try {
      const authFolder = this.getAuthFolder();
      const sessionDir = path.join(authFolder, sessionId);
      const cachePath = path.join(sessionDir, 'socket_cache.json');

      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      let cache: any[] = [];
      if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      }

      cache.push(data);
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      logger.warn(`[Socket Cache] Event cached for "${sessionId}". Total: ${cache.length}`);
    } catch (err: any) {
      logger.error(`[Socket Cache] Error saving cache: ${err.message}`);
    }
  }

  private async processCache(sessionId: string) {
    if (!this.io) return;

    try {
      const authFolder = this.getAuthFolder();
      const cachePath = path.join(authFolder, sessionId, 'socket_cache.json');

      if (!fs.existsSync(cachePath)) return;

      const cache: any[] = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (cache.length === 0) {
        fs.unlinkSync(cachePath);
        return;
      }

      logger.info(`[Socket Cache] Delivering ${cache.length} cached events for session "${sessionId}"`);

      for (const item of cache) {
        const payload = { ...item.payload, _cached: true };
        this.io.to(sessionId).emit(item.event, payload);
        if (item.event !== 'events') {
          this.io.to(sessionId).emit('events', payload);
        }
      }

      fs.unlinkSync(cachePath);
      logger.info(`[Socket Cache] All cached events delivered and cache cleared for "${sessionId}"`);
    } catch (err: any) {
      logger.error(`[Socket Cache] Error processing cache: ${err.message}`);
    }
  }

  private getAuthFolder(): string {
    return path.join(process.cwd(), 'auth_keys');
  }

  getIO(): SocketIOServer | null {
    return this.io;
  }
}

export const socketService = new SocketService();
