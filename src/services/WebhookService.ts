import axios from 'axios';
import axiosRetry from 'axios-retry';
import * as fs from 'fs';
import * as path from 'path';
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
  }
});

export class WebhookService {
  private static authFolder: string = path.join(process.cwd(), 'auth_keys');

  static async sendToWebhook(sessionId: string, messageData: any, targetUrl?: string) {
    // Priority: session-specific URL > global fallback from .env
    const url = targetUrl || config.webhookUrl;

    if (!url) {
      logger.warn(`[Webhook] No URL configured for session "${sessionId}" — message dropped.`);
      return;
    }

    const payload = {
      eventType: 'message.received',
      session: sessionId,
      timestamp: new Date().toISOString(),
      data: messageData
    };

    try {
      const response = await webhookClient.post(url as string, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.webhookSecret}`
        },
        timeout: 10000 // 10s por tentativa
      });

      logger.info(`[Webhook] Mensagem da sessão "${sessionId}" encaminhada para ${url}. Status: ${response.status}`);

      // Se enviou com sucesso, tenta esvaziar o cache de mensagens falhas anteriores
      this.processSessionCache(sessionId, url).catch(err =>
        logger.error(`[Webhook Cache] Erro ao processar cache da sessão ${sessionId}: ${err.message}`)
      );

    } catch (error: any) {
      // Chegou aqui após esgotar todas as tentativas de retry do Axios
      logger.error(`[Webhook] FALHA DEFINITIVA após 5 tentativas: sessão "${sessionId}" → ${url}`);

      // Salva no cache para tentar depois
      this.addToCache(sessionId, payload);

      if (error.response) {
        logger.error(
          `Última resposta do servidor: ${error.response.status} – ${JSON.stringify(error.response.data)}`
        );
      } else {
        logger.error(`Último erro de rede: ${error.message}`);
      }
    }
  }

  /**
   * Adiciona um payload falho ao cache em disco
   */
  private static addToCache(sessionId: string, payload: any) {
    try {
      const cachePath = path.join(this.authFolder, sessionId, 'webhook_cache.json');
      const sessionDir = path.join(this.authFolder, sessionId);

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      let cache: any[] = [];
      if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      }

      cache.push(payload);
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

      logger.warn(`[Webhook Cache] Mensagem salva no cache da sessão "${sessionId}". Total: ${cache.length}`);
    } catch (err: any) {
      logger.error(`[Webhook Cache] Erro crítico ao salvar cache: ${err.message}`);
    }
  }

  /**
   * Tenta reenviar todas as mensagens do cache
   */
  private static async processSessionCache(sessionId: string, url: string) {
    const cachePath = path.join(this.authFolder, sessionId, 'webhook_cache.json');

    if (!fs.existsSync(cachePath)) return;

    try {
      const cache: any[] = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (cache.length === 0) return;

      logger.info(`[Webhook Cache] Tentando reenviar ${cache.length} mensagens pendentes para a sessao "${sessionId}"...`);

      const remainingCache: any[] = [];
      let successCount = 0;

      for (const payload of cache) {
        try {
          // Adiciona um header para o Next.js saber que é uma mensagem vinda do cache (antiga)
          await webhookClient.post(url, payload, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.webhookSecret}`,
              'X-Webhook-Cached': 'true'
            },
            timeout: 10000
          });
          successCount++;
        } catch (err) {
          // Se falhar de novo, mantém no cache
          remainingCache.push(payload);
          // Para o loop se o servidor caiu de novo durante o processo
          break;
        }
      }

      if (remainingCache.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(remainingCache, null, 2));
        logger.warn(`[Webhook Cache] Restaram ${remainingCache.length} mensagens no cache da sessão "${sessionId}".`);
      } else {
        fs.unlinkSync(cachePath);
        logger.info(`[Webhook Cache] Cache da sessão "${sessionId}" limpo com sucesso! (${successCount} mensagens enviadas)`);
      }
    } catch (err: any) {
      logger.error(`[Webhook Cache] Erro ao processar arquivo de cache: ${err.message}`);
    }
  }
}
