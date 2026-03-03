import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessage,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { logger } from '../index';
import qrcode from 'qrcode-terminal';

export type SessionState = 'STARTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';

interface SessionData {
  socket: ReturnType<typeof makeWASocket>;
  status: SessionState;
  qrCode: string | null;
  webhookUrl: string;  // URL da aplicação Next.js para onde as mensagens serão roteadas
}

class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private authFolder: string = path.join(process.cwd(), 'auth_keys');

  constructor() {
    if (!fs.existsSync(this.authFolder)) {
      fs.mkdirSync(this.authFolder, { recursive: true });
    }
  }

  /**
   * Initializes a new socket connection for the given session ID
   * @param sessionId  - unique name for this WhatsApp number (e.g. "ti-suporte")
   * @param webhookUrl - URL of the Next.js app that will receive messages from this session
   */
  async startSession(sessionId: string, webhookUrl?: string): Promise<void> {
    logger.info(`Starting session: ${sessionId} → webhook: ${webhookUrl ?? '(from saved config)'}`);

    const sessionPath = path.join(this.authFolder, sessionId);

    // Persist the webhookUrl so we can reload it on restart without the caller knowing
    const configPath = path.join(sessionPath, 'session_config.json');
    let resolvedWebhookUrl = webhookUrl ?? '';
    if (webhookUrl) {
      fs.mkdirSync(sessionPath, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ webhookUrl }), 'utf-8');
    } else if (fs.existsSync(configPath)) {
      // Reload from disk on restart
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      resolvedWebhookUrl = saved.webhookUrl ?? '';
    }

    if (!resolvedWebhookUrl) {
      logger.warn(`Session ${sessionId} has no webhookUrl configured — messages will be dropped.`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info(`Session ${sessionId} using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }) as any),
      },
      generateHighQualityLinkPreview: true,
      getMessage: async (_) => { return { conversation: 'Message' } }
    });

    // Store active socket AND the resolved webhook URL
    this.sessions.set(sessionId, {
      socket,
      status: 'STARTING',
      qrCode: null,
      webhookUrl: resolvedWebhookUrl,
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      const session = this.sessions.get(sessionId);

      if (qr && session) {
        logger.info(`QR Code generated for session ${sessionId}`);
        qrcode.generate(qr, { small: true }); // Display in terminal for quick debugging
        session.qrCode = qr;
        session.status = 'QR_READY';
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

        logger.info(`Session ${sessionId} closed. Reconnect: ${shouldReconnect}, Reason: ${(lastDisconnect?.error as Boom)?.output?.statusCode}`);

        if (session) {
          session.status = 'DISCONNECTED';
        }

        // Handle reconnection if it was not explicitly logged out
        if (shouldReconnect) {
          logger.info(`Reconnecting session ${sessionId}...`);
          this.startSession(sessionId);
        } else {
          logger.info(`Session ${sessionId} logged out. To reconnect, restart or delete auth folder.`);
          this.deleteSession(sessionId);
        }
      } else if (connection === 'open') {
        logger.info(`Session ${sessionId} successfully connected!`);
        if (session) {
          session.status = 'CONNECTED';
          session.qrCode = null; // Clear QR as we don't need it now
        }
      }
    });

    // Webhook Routing
    socket.ev.on('messages.upsert', async (m) => {
      // Only process newly received messages (not history sync)
      if (m.type === 'notify') {
        logger.info(`[Session ${sessionId}] Processing ${m.messages.length} incoming messages.`);

        for (const msg of m.messages) {
          // Ignore status broadcasts and self-sent messages
          if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {

            // Extract the raw text regardless of message type (extended context, button reply, normal text, media captions)
            let textContent = '';
            if (msg.message?.conversation) {
              textContent = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage?.text) {
              textContent = msg.message.extendedTextMessage.text;
            } else if (msg.message?.imageMessage?.caption) {
              textContent = msg.message.imageMessage.caption;
            } else if (msg.message?.videoMessage?.caption) {
              textContent = msg.message.videoMessage.caption;
            } else if (msg.message?.documentMessage?.caption) {
              textContent = msg.message.documentMessage.caption;
            }

            // Detect media type
            let mediaType = 'text';
            let hasMedia = false;

            if (msg.message?.imageMessage) { mediaType = 'image'; hasMedia = true; }
            else if (msg.message?.videoMessage) { mediaType = 'video'; hasMedia = true; }
            else if (msg.message?.audioMessage) { mediaType = 'audio'; hasMedia = true; }
            else if (msg.message?.documentMessage) { mediaType = 'document'; hasMedia = true; }
            else if (msg.message?.stickerMessage) { mediaType = 'sticker'; hasMedia = true; }

            const simplifiedMsg = {
              id: msg.key.id,
              from: msg.key.remoteJid,
              text: textContent,
              pushName: msg.pushName,
              timestamp: msg.messageTimestamp,
              mediaType,
              hasMedia,
              raw: msg // Send the raw message object so Next.js can parse media if needed
            };

            import('./WebhookService').then(({ WebhookService }) => {
              const sessionData = this.sessions.get(sessionId);
              WebhookService.sendToWebhook(sessionId, simplifiedMsg, sessionData?.webhookUrl);
            });
          }
        }
      }
    });
  }

  /**
   * Gets public session state without exposing the internal socket
   */
  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, status: 'NOT_FOUND' };

    return {
      exists: true,
      status: session.status,
      qrCode: session.qrCode
    };
  }

  /**
   * Helper to format generic numbers to the format Baileys expects (JID)
   */
  private formatJid(number: string, isGroup: boolean = false): string {
    if (isGroup) {
      return number.includes('@g.us') ? number : `${number}@g.us`;
    }
    return number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
  }

  /**
   * Sends a message through an active session (supports text and media)
   */
  async sendMessage(sessionId: string, to: string, text: string, isGroup: boolean = false, mediaUrl?: string, mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt') {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      throw new Error('Session not connected');
    }

    const jid = this.formatJid(to, isGroup);

    // Send presence update to simulate typing/recording (optional but adds realism)
    const presenceType = (mediaType === 'audio' || mediaType === 'ptt') ? 'recording' : 'composing';
    await session.socket.sendPresenceUpdate(presenceType, jid);

    let messageContent: any = { text };

    // Construct message object if media is present
    if (mediaUrl && mediaType) {
      switch (mediaType) {
        case 'image':
          messageContent = { image: { url: mediaUrl }, caption: text };
          break;
        case 'video':
          messageContent = { video: { url: mediaUrl }, caption: text };
          break;
        case 'audio':
        case 'ptt': // Voice note (PTT = Push To Talk)
          messageContent = { audio: { url: mediaUrl }, ptt: mediaType === 'ptt' };
          break;
        case 'document':
          messageContent = { document: { url: mediaUrl }, fileName: text || 'document', mimetype: 'application/pdf' }; // Defaulting to pdf for generic docs
          break;
      }
    }

    // Dispatch the message
    const result = await session.socket.sendMessage(jid, messageContent);

    await session.socket.sendPresenceUpdate('paused', jid);

    return result;
  }

  /**
   * Terminates a session and removes its auth data
   */
  deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.info(`Terminating session ${sessionId}`);
      session.socket.logout(); // Also disconnects socket
      this.sessions.delete(sessionId);
    }

    const sessionPath = path.join(this.authFolder, sessionId);
    if (fs.existsSync(sessionPath)) {
      // Basic cleanup of auth directory
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info(`Auth data for session ${sessionId} deleted.`);
      } catch (e) {
        logger.error(e as Error, `Error deleting auth data for ${sessionId}`);
      }
    }
  }

  /**
   * Initialize previous connections on startup
   */
  async loadSavedSessions() {
    if (!fs.existsSync(this.authFolder)) return;

    const directories = fs.readdirSync(this.authFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    logger.info(`Found ${directories.length} saved sessions to restore: ${directories.join(', ')}`);

    for (const sessionId of directories) {
      await this.startSession(sessionId);
      // small delay to prevent rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Export a singleton instance
export const sessionManager = new SessionManager();
