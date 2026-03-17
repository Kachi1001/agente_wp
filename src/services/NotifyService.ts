import { logger } from '../utils/logger';
import { socketService } from './SocketService';

/**
 * Service to handle all outbound notifications (Socket.IO).
 * Webhooks have been removed in favor of Socket.IO with persistent caching.
 */
export class NotifyService {
  private static messageQueue: any[] = [];
  private static isProcessingQueue: boolean = false;
  private static QUEUE_DELAY_MS: number = 200; // 200ms delay between emissions

  /**
   * Primary method for message events. 
   * Pushes to queue to be emitted to Socket.IO.
   */
  static async notifyMessage(sessionId: string, messageData: any) {
    const payload = {
      eventType: 'message.received',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data: messageData
    };

    this.messageQueue.push(payload);

    // Start processing if not already running
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Processes the message queue with a delay between each emission
   */
  private static async processQueue() {
    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const payload = this.messageQueue.shift();
      if (payload) {
        logger.info(`[NotifyService] Disparando mensagem com delay. Restam na fila: ${this.messageQueue.length}`);
        socketService.emit('message.received', payload);
      }

      // Delay before next emission
      await new Promise(resolve => setTimeout(resolve, this.QUEUE_DELAY_MS));
    }

    this.isProcessingQueue = false;
  }

  /**
   * Status notification for message editing.
   */
  static async notifyMessageEdit(sessionId: string, data: any) {
    const payload = {
      eventType: 'message.edit',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data
    };
    logger.info(`[NotifyService] Notificando edição de mensagem na sessão ${sessionId}`);
    socketService.emit('message.edit', payload);
  }

  /**
   * Status notification for message deletion (revoke).
   */
  static async notifyMessageDelete(sessionId: string, data: any) {
    const payload = {
      eventType: 'message.delete',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data
    };
    logger.info(`[NotifyService] Notificando exclusão de mensagem na sessão ${sessionId}`);
    socketService.emit('message.delete', payload);
  }

  /**
   * Status notification for message reaction.
   */
  static async notifyMessageReaction(sessionId: string, data: any) {
    const payload = {
      eventType: 'message.reaction',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data
    };
    logger.info(`[NotifyService] Notificando reação de mensagem na sessão ${sessionId}`);
    socketService.emit('message.reaction', payload);
  }

  /**
   * Status notification for message ACK (send/delivered/read).
   */
  static async notifyMessageAck(sessionId: string, data: any) {
    const payload = {
      eventType: 'message.ack',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data
    };
    logger.info(`[NotifyService] Notificando ACK de mensagem na sessão ${sessionId} | ACK: ${data.ack}`);
    socketService.emit('message.ack', payload);
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
