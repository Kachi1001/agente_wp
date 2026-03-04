import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { logger } from '../utils/logger';
import { sessionManager } from './SessionManager';

class SocketService {
  private io: SocketIOServer | null = null;

  init(httpServer: HttpServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    this.io.on('connection', (socket) => {
      logger.info(`[Socket.IO] New client connected: ${socket.id}`);

      // ── ENVIAR MENSAGEM VIA SOCKET ──
      socket.on('send_message', async (data: {
        sessionId: string,
        to: string,
        text: string,
        mediaUrl?: string,
        mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt'
      }, callback) => {
        try {
          const { sessionId, to, text, mediaUrl, mediaType } = data;
          logger.info(`[Socket.IO] Request to send message from "${sessionId}" to "${to}"`);

          const result = await sessionManager.sendMessage(sessionId, to, text, mediaUrl, mediaType);

          if (callback) callback({ success: true, messageId: result.id.id });
        } catch (err: any) {
          logger.error(`[Socket.IO] Error sending message: ${err.message}`);
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
      });
    });

    logger.info('[Socket.IO] Initialized');
  }

  emit(event: string, payload: any) {
    if (!this.io) {
      logger.warn(`[Socket.IO] Attempted to emit "${event}" before initialization`);
      return;
    }
    this.io.emit(event, payload);
    // Generic fallback for all events
    if (event !== 'events') {
      this.io.emit('events', payload);
    }
  }

  getIO(): SocketIOServer | null {
    return this.io;
  }
}

export const socketService = new SocketService();
