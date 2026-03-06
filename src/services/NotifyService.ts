import { logger } from '../utils/logger';
import { socketService } from './SocketService';

/**
 * Service to handle all outbound notifications (Socket.IO).
 * Webhooks have been removed in favor of Socket.IO with persistent caching.
 */
export class NotifyService {
  /**
   * Primary method for message events. 
   * Emits to Socket.IO.
   */
  static async notifyMessage(sessionId: string, messageData: any) {
    const payload = {
      eventType: 'message.received',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data: messageData
    };

    socketService.emit('message.received', payload);
  }

  /**
   * Primary method for status events (connected, disconnected).
   */
  static async notifyStatus(
    sessionId: string,
    eventType: 'session.connected' | 'session.disconnected',
    data: Record<string, any>
  ) {
    const payload = {
      eventType,
      session: sessionId,
      timestamp: new Date().toISOString(),
      data,
    };

    logger.info(`[Socket.IO] Emitting status "${eventType}" for session "${sessionId}"`);
    socketService.emit(eventType, payload);
  }
}
