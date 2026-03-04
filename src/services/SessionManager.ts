import { Client, LocalAuth, MessageMedia, Message as WWebMessage } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../index';
import qrcode from 'qrcode-terminal';

export type SessionState = 'STARTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';

interface SessionData {
  client: Client;
  status: SessionState;
  qrCode: string | null;
  webhookUrl: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers (portados do whatsapp.ts original)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Gera um texto de pré-visualização legível para qualquer tipo de mensagem.
 * Portado diretamente do whatsapp.ts original.
 */
export function getPreviewText(msg: WWebMessage): string {
  if (msg.body && !msg.hasMedia) return msg.body;
  if (!msg.hasMedia) return msg.body || '';

  const bodySuffix = msg.body ? ` ${msg.body}` : '';
  if (msg.type === 'image') return `📷 Imagem${bodySuffix}`;
  if (msg.type === 'video') return `🎥 Vídeo${bodySuffix}`;
  if (msg.type === 'audio' || msg.type === 'ptt') return '🎵 Áudio';
  if (msg.type === 'document') return `📄 Documento${bodySuffix}`;
  if (msg.type === 'sticker') return '🖼️ Figurinha';
  if (msg.type === 'vcard' || msg.type === 'multi_vcard') return '📇 Contato';
  if (msg.type === 'location') return '📍 Localização';
  return '[Mídia]';
}

/** Mapa de extensões por MIME type */
const MIME_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/plain': 'txt',
};

/**
 * Baixa a mídia e salva em /public/media.
 * Tenta até 3 vezes antes de desistir.
 * Portado diretamente do whatsapp.ts original.
 * Retorna { url, type } se salvo com sucesso, ou null caso contrário.
 */
export async function saveMedia(msg: WWebMessage): Promise<{ url: string; type: string } | null> {
  if (!msg.hasMedia) return null;

  try {
    let media = null;
    for (let i = 0; i < 3; i++) {
      try {
        media = await msg.downloadMedia();
        if (media) break;
      } catch (err: any) {
        logger.warn(`[Media] Tentativa ${i + 1} fallou para ${msg.id?.id}: ${err?.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!media) {
      logger.warn(`[Media] downloadMedia retornou null após 3 tentativas para ${msg.id?.id}`);
      return null;
    }

    const ext = MIME_MAP[media.mimetype] || media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
    const safeId = msg.id.id.replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeId}.${ext}`;
    const mediaDir = path.join(process.cwd(), 'public', 'media');
    const filePath = path.join(mediaDir, filename);

    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, media.data, { encoding: 'base64' });
      logger.info(`[Media] Arquivo salvo: ${filename}`);
    }

    return { url: `/media/${filename}`, type: media.mimetype };
  } catch (e: any) {
    logger.error(`[Media] Erro ao processar mídia de ${msg.id?.id}: ${e?.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SessionManager
// ──────────────────────────────────────────────────────────────────────────────

class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private authFolder: string = path.join(process.cwd(), 'auth_keys');

  constructor() {
    if (!fs.existsSync(this.authFolder)) {
      fs.mkdirSync(this.authFolder, { recursive: true });
    }
  }

  /**
   * Initializes a new WhatsApp-Web.js client for the given session ID
   */
  async startSession(sessionId: string, webhookUrl?: string): Promise<void> {
    logger.info(`Starting session: ${sessionId} → webhook: ${webhookUrl ?? '(from saved config)'}`);

    const sessionPath = path.join(this.authFolder, sessionId);
    const configPath = path.join(this.authFolder, sessionId, 'session_config.json');
    let resolvedWebhookUrl = webhookUrl ?? '';

    if (webhookUrl) {
      if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ webhookUrl }), 'utf-8');
    } else if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      resolvedWebhookUrl = saved.webhookUrl ?? '';
    }

    if (!resolvedWebhookUrl) {
      logger.warn(`Session ${sessionId} has no webhookUrl configured — messages will be dropped.`);
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: this.authFolder }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    this.sessions.set(sessionId, { client, status: 'STARTING', qrCode: null, webhookUrl: resolvedWebhookUrl });

    // ── QR Code ──────────────────────────────────────────────────────────────
    client.on('qr', (qr) => {
      logger.info(`[${sessionId}] QR Code gerado.`);
      qrcode.generate(qr, { small: true });
      const session = this.sessions.get(sessionId);
      if (session) { session.qrCode = qr; session.status = 'QR_READY'; }
    });

    // ── Pronto ───────────────────────────────────────────────────────────────
    client.on('ready', () => {
      logger.info(`[${sessionId}] Sessao conectada com sucesso!`);
      const session = this.sessions.get(sessionId);
      if (session) { session.status = 'CONNECTED'; session.qrCode = null; }

      // Notifica o webhook que a sessão está online (útil após uma reconexão)
      import('./WebhookService').then(({ WebhookService }) => {
        const sessionData = this.sessions.get(sessionId);
        WebhookService.sendToWebhook(sessionId, {
          eventType: 'session.connected',
          session: sessionId,
          timestamp: new Date().toISOString(),
          data: { status: 'CONNECTED' }
        }, sessionData?.webhookUrl);
      });
    });

    client.on('authenticated', () => logger.info(`[${sessionId}] Autenticado.`));

    client.on('auth_failure', (msg) => {
      logger.error(`[${sessionId}] AUTH FAILURE: ${msg}`);
      const session = this.sessions.get(sessionId);
      if (session) session.status = 'DISCONNECTED';
    });

    // ── Desconectado ─────────────────────────────────────────────────────────
    client.on('disconnected', (reason) => {
      logger.warn(`[${sessionId}] Desconectado: ${reason}. Reconectando em 5s...`);
      const session = this.sessions.get(sessionId);
      if (session) session.status = 'DISCONNECTED';

      // Notifica o webhook que o WhatsApp caiu
      import('./WebhookService').then(({ WebhookService }) => {
        const sessionData = this.sessions.get(sessionId);
        WebhookService.sendToWebhook(sessionId, {
          eventType: 'session.disconnected',
          session: sessionId,
          timestamp: new Date().toISOString(),
          data: { status: 'DISCONNECTED', reason }
        }, sessionData?.webhookUrl);
      });

      setTimeout(() => this.startSession(sessionId), 5000);
    });

    // ── MENSAGENS RECEBIDAS (de outras pessoas) ───────────────────────────────
    // Espelha exatamente a lógica do client.on('message', ...) do whatsapp.ts
    client.on('message', async (msg: WWebMessage) => {
      // Filtro: só aceita mensagens de contatos individuais (@c.us) ou LID
      // Descarta msgs vazias sem mídia (ex: notificações de grupo)
      if (
        !(msg.from.includes('@c.us') || msg.from.includes('@lid')) ||
        (msg.body === '' && !msg.hasMedia)
      ) return;

      logger.info(`[${sessionId}] Mensagem recebida de ${msg.from} | tipo: ${msg.type}`);

      const contact = await msg.getContact();
      const pushName = contact.pushname || contact.name || '';
      const previewText = getPreviewText(msg);

      // Dispara o webhook IMEDIATAMENTE sem esperar o download da mídia
      // Isso evita bloquear o event loop por até 6s (3 tentativas × 2s)
      const payload: any = {
        id: msg.id.id,
        fromMe: false,
        jid: contact.id._serialized,
        lid: msg.from,
        text: msg.body || '',
        pushName,
        previewText,
        timestamp: msg.timestamp,
        mediaType: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl: null,
        mediaMime: null,
        // raw: msg,
      };

      import('./WebhookService').then(({ WebhookService }) => {
        const sessionData = this.sessions.get(sessionId);
        WebhookService.sendToWebhook(sessionId, payload, sessionData?.webhookUrl);
      });

      // Download de mídia em background — não bloqueia a fila de mensagens
      if (msg.hasMedia) {
        saveMedia(msg).then(media => {
          if (!media) return;
          import('./WebhookService').then(({ WebhookService }) => {
            const sessionData = this.sessions.get(sessionId);
            WebhookService.sendToWebhook(sessionId, {
              ...payload,
              eventType: 'media.ready',
              mediaUrl: media.url,
              mediaMime: media.type,
            }, sessionData?.webhookUrl);
          });
        }).catch(err => logger.error(`[${sessionId}] Erro background saveMedia: ${err.message}`));
      }
    });

    // ── MENSAGENS ENVIADAS POR MIM ────────────────────────────────────────────
    // Espelha exatamente a lógica do client.on('message_create', ...) do whatsapp.ts
    client.on('message_create', async (msg: WWebMessage) => {
      // Só processa mensagens que eu enviei
      if (!msg.fromMe) return;
      // Ignora grupos, newsletters e status
      if (
        msg.from.includes('@g.us') ||
        msg.from.includes('newsletter') ||
        msg.from.includes('status@broadcast')
      ) return;

      logger.info(`[${sessionId}] Mensagem ENVIADA para ${msg.to} | tipo: ${msg.type}`);

      const previewText = getPreviewText(msg);
      // Dispara o webhook imediatamente (sem aguardar mídia)
      const payload: any = {
        id: msg.id.id,
        fromMe: true,
        jid: '',
        lid: msg.to,
        text: msg.body || '',
        pushName: null,
        previewText,
        timestamp: msg.timestamp,
        mediaType: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl: null,
        mediaMime: null,
        // raw: msg,
      };

      import('./WebhookService').then(({ WebhookService }) => {
        const sessionData = this.sessions.get(sessionId);
        WebhookService.sendToWebhook(sessionId, payload, sessionData?.webhookUrl);
      });

      // Download de mídia em background
      if (msg.hasMedia) {
        saveMedia(msg).then(media => {
          if (!media) return;
          import('./WebhookService').then(({ WebhookService }) => {
            const sessionData = this.sessions.get(sessionId);
            WebhookService.sendToWebhook(sessionId, {
              ...payload,
              eventType: 'media.ready',
              mediaUrl: media.url,
              mediaMime: media.type,
            }, sessionData?.webhookUrl);
          });
        }).catch(err => logger.error(`[${sessionId}] Erro background saveMedia (fromMe): ${err.message}`));
      }
    });

    client.initialize().catch(err => {
      logger.error(`[${sessionId}] Falha ao inicializar: ${err.message}`);
    });
  }

  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, status: 'NOT_FOUND' };
    return { exists: true, status: session.status, qrCode: session.qrCode };
  }

  private formatJid(number: string, isGroup: boolean = false): string {
    if (isGroup) return number.includes('@g.us') ? number : `${number}@g.us`;
    return number.includes('@c.us') ? number : `${number}@c.us`;
  }

  async sendMessage(
    sessionId: string,
    to: string,
    text: string,
    // isGroup: boolean = false,
    mediaUrl?: string,
    mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt'
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(to);
    let options: any = {};
    let content: any = text;

    if (mediaUrl) {
      const media = await MessageMedia.fromUrl(mediaUrl);
      content = media;
      options.caption = text;
      if (mediaType === 'ptt') options.sendAudioAsVoice = true;
    }

    // Tenta com JID formatado; se der "No LID for user", tenta o numero puro
    try {
      return await session.client.sendMessage(jid, content, options);
    } catch (err: any) {
      if (err.message?.includes('No LID for user')) {
        logger.warn(`[${sessionId}] No LID para ${jid}, tentando numero direto: ${to}@c.us`);
        return await session.client.sendMessage(`${to.replace(/@.*/, '')}@c.us`, content, options);
      }
      throw err;
    }
  }

  async deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.info(`[${sessionId}] Encerrando sessao...`);
      try {
        await session.client.logout();
        await session.client.destroy();
      } catch (err) {
        logger.error(`[${sessionId}] Erro ao destruir cliente: ${err}`);
      }
      this.sessions.delete(sessionId);
    }

    const sessionPath = path.join(this.authFolder, `session-${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info(`[${sessionId}] Dados de auth deletados.`);
      } catch (e) {
        logger.error(e as Error, `[${sessionId}] Erro ao deletar dados de auth.`);
      }
    }
  }

  async loadSavedSessions() {
    if (!fs.existsSync(this.authFolder)) return;

    const directories = fs.readdirSync(this.authFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('session-'))
      .map(dirent => dirent.name.replace('session-', ''));

    logger.info(`Sessões salvas encontradas: ${directories.length} → [${directories.join(', ')}]`);

    for (const sessionId of directories) {
      await this.startSession(sessionId);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export const sessionManager = new SessionManager();
