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
