import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
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

    // Persist the webhookUrl
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

    // Initialize client with LocalAuth
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: this.authFolder
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    this.sessions.set(sessionId, {
      client,
      status: 'STARTING',
      qrCode: null,
      webhookUrl: resolvedWebhookUrl,
    });

    // Event Listeners
    client.on('qr', (qr) => {
      logger.info(`QR Code generated for session ${sessionId}`);
      qrcode.generate(qr, { small: true });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.qrCode = qr;
        session.status = 'QR_READY';
      }
    });

    client.on('ready', () => {
      logger.info(`Session ${sessionId} successfully connected!`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'CONNECTED';
        session.qrCode = null;
      }
    });

    client.on('authenticated', () => {
      logger.info(`Session ${sessionId} authenticated.`);
    });

    client.on('auth_failure', (msg) => {
      logger.error(`Session ${sessionId} AUTH FAILURE: ${msg}`);
      const session = this.sessions.get(sessionId);
      if (session) session.status = 'DISCONNECTED';
    });

    client.on('disconnected', (reason) => {
      logger.info(`Session ${sessionId} was disconnected: ${reason}`);
      const session = this.sessions.get(sessionId);
      if (session) session.status = 'DISCONNECTED';
      // Auto-reconnect logic
      setTimeout(() => this.startSession(sessionId), 5000);
    });

    // Handle incoming/outgoing messages to forward to Webhook
    client.on('message_create', async (msg: any) => {
      // Ignore status broadcasts and newsletter messages
      if (msg.from === 'status@broadcast' || msg.from?.includes('@newsletter')) {
        return;
      }

      // Detect media type
      let mediaType = 'text';
      let hasMedia = msg.hasMedia;

      if (hasMedia) {
        mediaType = msg.type; // image, video, audio, ptt, document, sticker
      }

      let pushName = '';
      try {
        const contact = await msg.getContact();
        pushName = contact.pushname || contact.name || '';
      } catch (e) {
        logger.error(`Error getting contact name: ${e}`);
      }

      const simplifiedMsg = {
        id: msg.id.id,
        fromMe: msg.fromMe,
        jid: msg.author || msg.from,
        lid: msg.from,
        text: msg.body || '',
        pushName: pushName,
        timestamp: msg.timestamp,
        mediaType,
        hasMedia,
        raw: msg
      };

      import('./WebhookService').then(({ WebhookService }) => {
        const sessionData = this.sessions.get(sessionId);
        WebhookService.sendToWebhook(sessionId, simplifiedMsg, sessionData?.webhookUrl);
      });
    });

    client.initialize().catch(err => {
      logger.error(`Failed to initialize session ${sessionId}: ${err.message}`);
    });
  }

  /**
   * Gets public session state
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
   * Helper to format generic numbers to the format wwebjs expects
   */
  private formatJid(number: string, isGroup: boolean = false): string {
    if (isGroup) {
      return number.includes('@g.us') ? number : `${number}@g.us`;
    }
    return number.includes('@c.us') ? number : `${number}@c.us`;
  }

  /**
   * Sends a message through an active session
   */
  async sendMessage(sessionId: string, to: string, text: string, isGroup: boolean = false, mediaUrl?: string, mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt') {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      throw new Error('Session not connected');
    }

    const jid = this.formatJid(to, isGroup);
    let options: any = {};
    let content: any = text;

    if (mediaUrl) {
      const media = await MessageMedia.fromUrl(mediaUrl);
      content = media;
      options.caption = text;
      if (mediaType === 'ptt') {
        options.sendAudioAsVoice = true;
      }
    }

    const result = await session.client.sendMessage(jid, content, options);
    return result;
  }

  /**
   * Terminates a session and removes its auth data
   */
  async deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.info(`Terminating session ${sessionId}`);
      try {
        await session.client.logout();
        await session.client.destroy();
      } catch (err) {
        logger.error(`Error destroying client for ${sessionId}: ${err}`);
      }
      this.sessions.delete(sessionId);
    }

    const sessionPath = path.join(this.authFolder, `session-${sessionId}`);
    if (fs.existsSync(sessionPath)) {
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

    // LocalAuth stores sessions as folders named session-<id>
    const directories = fs.readdirSync(this.authFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('session-'))
      .map(dirent => dirent.name.replace('session-', ''));

    logger.info(`Found ${directories.length} saved sessions to restore: ${directories.join(', ')}`);

    for (const sessionId of directories) {
      await this.startSession(sessionId);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export const sessionManager = new SessionManager();
