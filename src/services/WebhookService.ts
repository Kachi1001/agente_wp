import axios from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '../index';
import { config } from '../config';

// Create a custom axios instance for webhooks
const webhookClient = axios.create();

// Configure retry logic: it will automatically retry 5 times with exponential backoff 
// (e.g., if Next.js is restarting or the network lags)
axiosRetry(webhookClient, {
  retries: 5,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    // Retry on network errors or 5xx server errors
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 503 || error.response?.status === 502;
  },
  onRetry: (retryCount, error, requestConfig) => {
    logger.warn(`[Webhook Retry] Attempt ${retryCount}/5 to ${requestConfig.url}. Error: ${error.message}`);
  }
});

export class WebhookService {
  static async sendToWebhook(sessionId: string, messageData: any, targetUrl?: string) {
    // Priority: session-specific URL > global fallback from .env
    const url = targetUrl || config.webhookUrl;

    if (!url) {
      logger.warn(`[Webhook] No URL configured for session "${sessionId}" — message dropped.`);
      return;
    }

    try {
      const payload = {
        eventType: 'message.received',
        session: sessionId,
        timestamp: new Date().toISOString(),
        data: messageData
      };

      const response = await webhookClient.post(url as string, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.webhookSecret}`
        },
        timeout: 10000 // 10s por tentativa
      });

      logger.info(`[Webhook] Mensagem da sessão "${sessionId}" encaminhada para ${url}. Status: ${response.status}`);

    } catch (error: any) {
      // Chegou aqui após esgotar todas as tentativas de retry
      logger.error(`[Webhook] FALHA DEFINITIVA após 5 tentativas: sessão "${sessionId}" → ${url}`);
      if (error.response) {
        logger.error(
          `Última resposta do servidor: ${error.response.status} – ${JSON.stringify(error.response.data)}`
        );
      } else {
        logger.error(`Último erro de rede: ${error.message}`);
      }
    }
  }
}
