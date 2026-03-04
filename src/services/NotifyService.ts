import axios from 'axios';
import axiosRetry from 'axios-retry';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { socketService } from './SocketService';
import { config } from '../config';

// Create a custom axios instance for webhooks
const webhookClient = axios.create();

// Configure retry logic: it will automatically retry 5 times with exponential backoff 
axiosRetry(webhookClient, {
  retries: 5,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 503 || error.response?.status === 502;
  }
});

/**
 * Service to handle all outbound notifications (Socket.IO and Webhooks).
 * Socket.IO is the primary channel, Webhooks serve as a persistent fallback.
 */
export class NotifyService {
  private static authFolder: string = path.join(process.cwd(), 'auth_keys');

  /**
   * Primary method for message events. 
   * Always emits to Socket.IO, and sends to Webhook if configured.
   */
  static async notifyMessage(sessionId: string, messageData: any, targetUrl?: string) {
    const url = targetUrl || config.webhookUrl;

    const payload = {
      eventType: 'message.received',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data: messageData
    };

    // 1. Emit via Socket.IO (Primary - Ultra Fast)
    logger.info(`[Socket.IO] Emitting message.received for session "${sessionId}"`);
    socketService.emit('message.received', payload);

    // 2. Send via Webhook (Secondary - Persistent)
    if (!url) {
      logger.debug(`[Notify] No Webhook URL for session "${sessionId}" — skipping HTTP POST.`);
      return;
    }

    try {
      await webhookClient.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.webhookSecret}`
        },
        timeout: 10000
      });

      // Process cache on success
      this.processSessionCache(sessionId, url).catch(err =>
        logger.error(`[Webhook Cache] Error processing cache: ${err.message}`)
      );
    } catch (error: any) {
      logger.error(`[Webhook] Permanent failure after retries for session "${sessionId}"`);
      this.addToCache(sessionId, payload);
    }
  }

  /**
   * Primary method for status events (connected, disconnected).
   */
  static async notifyStatus(
    sessionId: string,
    eventType: 'session.connected' | 'session.disconnected',
    data: Record<string, any>,
    targetUrl?: string
  ) {
    const url = targetUrl || config.webhookUrl;

    const payload = {
      eventType,
      session: sessionId,
      timestamp: new Date().toISOString(),
      data,
    };

    // 1. Emit via Socket.IO
    logger.info(`[Socket.IO] Emitting status "${eventType}" for session "${sessionId}"`);
    socketService.emit(eventType, payload);

    // 2. Send via Webhook
    if (!url) return;

    try {
      await webhookClient.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.webhookSecret}`
        },
        timeout: 10000
      });
    } catch (error: any) {
      logger.error(`[Webhook] Failed to send status "${eventType}": ${error.message}`);
    }
  }

  private static addToCache(sessionId: string, payload: any) {
    try {
      const cachePath = path.join(this.authFolder, sessionId, 'webhook_cache.json');
      const sessionDir = path.join(this.authFolder, sessionId);

      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      let cache: any[] = [];
      if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      }

      cache.push(payload);
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      logger.warn(`[Webhook Cache] Saved message to cache for "${sessionId}". Total: ${cache.length}`);
    } catch (err: any) {
      logger.error(`[Webhook Cache] Critical error saving cache: ${err.message}`);
    }
  }

  private static async processSessionCache(sessionId: string, url: string) {
    const cachePath = path.join(this.authFolder, sessionId, 'webhook_cache.json');
    if (!fs.existsSync(cachePath)) return;

    try {
      const cache: any[] = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (cache.length === 0) return;

      const remainingCache: any[] = [];
      for (const payload of cache) {
        try {
          await webhookClient.post(url, payload, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.webhookSecret}`,
              'X-Webhook-Cached': 'true'
            }
          });
        } catch (err) {
          remainingCache.push(payload);
          break;
        }
      }

      if (remainingCache.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(remainingCache, null, 2));
      } else {
        fs.unlinkSync(cachePath);
      }
    } catch (err: any) {
      logger.error(`[Webhook Cache] Error processing cache: ${err.message}`);
    }
  }
}
