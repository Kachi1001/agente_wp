import { Client, LocalAuth, MessageMedia, Message as WWebMessage } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

export type SessionState = 'STARTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';

interface SessionData {
  client: Client;
  status: SessionState;
  qrCode: string | null;
  healthTimer?: NodeJS.Timeout;
}

// Padrões de erro que indicam que o Chromium/frame morreu — não há recuperação
// possível via retry; somente reiniciando o navegador.
const DEAD_FRAME_PATTERNS = [
  'detached Frame',
  'Target closed',
  'Session closed',
  'Protocol error',
  'Execution context was destroyed',
  'Most likely the page has been closed',
];

export function isDeadFrameError(err: any): boolean {
  const msg = err?.message || String(err || '');
  return DEAD_FRAME_PATTERNS.some(p => msg.includes(p));
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
  // Images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',

  // Video
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',

  // Audio
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'audio/opus': 'opus',
  'audio/x-m4a': 'm4a',

  // Documents
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/rtf': 'rtf',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/xml': 'xml',

  // Archives
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/x-tar': 'tar',
  'application/x-gzip': 'gz',
  'application/x-bzip2': 'bz2',
};
/**
 * Baixa a mídia e salva em /public/media/<sessionId>.
 * Tenta até 3 vezes antes de desistir.
 * Retorna { url, type } se salvo com sucesso, ou null caso contrário.
 */
export async function saveMedia(sessionId: string, msg: WWebMessage): Promise<{ url: string; type: string } | null> {
  if (!msg.hasMedia) return null;

  try {
    let media = null;
    for (let i = 0; i < 3; i++) {
      try {
        media = await msg.downloadMedia();
        if (media) break;
      } catch (err: any) {
        logger.warn(`[Media] Tentativa ${i + 1} falhou para ${msg.id?.id}: ${err?.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!media) {
      logger.warn(`[Media] downloadMedia retornou null após 3 tentativas para ${msg.id?.id}`);
      return null;
    }

    // Tenta detectar a extensão de forma mais inteligente
    let ext = MIME_MAP[media.mimetype];
    if (!ext) {
      if (media.mimetype === 'application/octet-stream' || !media.mimetype.includes('/')) {
        // Fallback baseado no tipo da mensagem original
        if (msg.type === 'image') ext = 'jpg';
        else if (msg.type === 'video') ext = 'mp4';
        else if (msg.type === 'audio' || msg.type === 'ptt') ext = 'ogg';
        else ext = 'bin';
        logger.info(`[Media] MIME genérico (${media.mimetype}) detectado para tipo ${msg.type}. Usando ext: .${ext}`);
      } else {
        ext = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
      }
    }

    const safeId = msg.id.id.replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeId}.${ext}`;

    // Organizar por sessão
    const mediaDir = path.join(process.cwd(), 'public', 'media', sessionId);
    const filePath = path.join(mediaDir, filename);

    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, media.data, { encoding: 'base64' });
      logger.info(`[Media] Arquivo salvo em ${sessionId}: ${filename}`);
    }

    // Retorna URL completa
    const relativeUrl = `/media/${sessionId}/${filename}`;
    const absoluteUrl = `${config.baseUrl}${relativeUrl}`;

    return { url: absoluteUrl, type: media.mimetype };
  } catch (e: any) {
    logger.error(`[Media] Erro ao processar mídia de ${msg.id?.id}: ${e?.message}`);
    return null;
  }
}

const PROFILE_PICS_DIR = path.join(process.cwd(), 'public', 'profile_pics');
const PROFILE_PIC_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/** Retorna true se já existe cache válido (< 24h) para o JID. */
function hasValidProfilePicCache(jid: string): boolean {
  const safeId = jid.replace(/[^a-zA-Z0-9@.-]/g, '_');
  const filePath = path.join(PROFILE_PICS_DIR, `${safeId}.jpg`);
  if (!fs.existsSync(filePath)) return false;
  const age = Date.now() - fs.statSync(filePath).mtimeMs;
  return age < PROFILE_PIC_TTL_MS;
}

/**
 * Versão usada nos handlers de mensagem:
 * - Se o arquivo já existe (qualquer idade) → retorna do disco imediatamente.
 * - Se nunca existiu (contato novo) → busca uma vez no WhatsApp e salva.
 * O re-download de caches expirados fica exclusivamente no warm-up do start.
 */
async function fetchProfilePicIfNew(client: Client, contact: any): Promise<string | null> {
  const jid = contact?.id?._serialized || (typeof contact === 'string' ? contact : null);
  if (!jid) return null;

  const safeId = jid.replace(/[^a-zA-Z0-9@.-]/g, '_');
  const filePath = path.join(PROFILE_PICS_DIR, `${safeId}.jpg`);

  // Qualquer cache existente → retorna direto, sem tocar no WhatsApp
  if (fs.existsSync(filePath)) {
    return `${config.baseUrl}/profile_pics/${safeId}.jpg`;
  }

  // Contato novo → delega ao fetchProfilePic completo (baixa e salva)
  return fetchProfilePic(client, contact);
}

async function fetchProfilePic(client: Client, contact: any): Promise<string | null> {
  const jid = contact?.id?._serialized || contact;

  if (!jid || typeof jid !== 'string') return null;

  // Mock de propriedades que podem causar crash na lib
  if (contact && typeof contact === 'object') {
    if (contact.isNewsletter === undefined) contact.isNewsletter = false;
    if (contact.isGroup === undefined) contact.isGroup = false;
  }

  const safeId = jid.replace(/[^a-zA-Z0-9@.-]/g, '_');
  const filePath = path.join(PROFILE_PICS_DIR, `${safeId}.jpg`);

  if (!fs.existsSync(PROFILE_PICS_DIR)) {
    fs.mkdirSync(PROFILE_PICS_DIR, { recursive: true });
  }

  // Cache válido → retorna imediatamente sem tocar no WhatsApp
  if (hasValidProfilePicCache(jid)) {
    return `${config.baseUrl}/profile_pics/${safeId}.jpg`;
  }

  // Cache expirado ou ausente — precisa baixar
  if (fs.existsSync(filePath)) {
    logger.info(`[ProfilePic] Cache expirado para ${jid}, rebaixando...`);
  }

  // Sem objeto de contato não conseguimos buscar no WhatsApp
  if (typeof contact === 'string') return null;

  let whatsappUrl: string | null = null;

  try {
    const scanResult: any = await (client as any).pupPage.evaluate(async (contactId: string) => {
      try {
        const win = window as any;
        const Store = win.Store;
        if (!Store || !Store.WidFactory || !Store.ProfilePicThumb) return null;

        // Garante que isNewsletter existe no protótipo do WID (evita crash interno)
        try {
          const testWid = Store.WidFactory.createWid(contactId);
          const proto = Object.getPrototypeOf(testWid);
          if (proto && typeof proto.isNewsletter === 'undefined') {
            Object.defineProperty(proto, 'isNewsletter', { get: () => false, configurable: true });
          }
        } catch (_) {}

        const wid = Store.WidFactory.createWid(contactId);
        await Store.ProfilePicThumb.find(wid).catch(() => {});
        const thumb = Store.ProfilePicThumb.get(wid);
        return thumb?.eurl ?? null;
      } catch (_) {
        return null;
      }
    }, jid);

    whatsappUrl = scanResult || null;
  } catch (err: any) {
    logger.warn(`[ProfilePic] Falha ao buscar URL para ${jid}: ${err.message}`);
  }

  if (!whatsappUrl) return null;

  try {
    const response = await axios.get(whatsappUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 10000,
    });

    if (response.status === 200) {
      fs.writeFileSync(filePath, Buffer.from(response.data));
      logger.info(`[ProfilePic] Foto salva: ${safeId}.jpg`);
      return `${config.baseUrl}/profile_pics/${safeId}.jpg`;
    }
  } catch (e: any) {
    logger.warn(`[ProfilePic] Download falhou para ${jid}: ${e.message}`);
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// SessionManager
// ──────────────────────────────────────────────────────────────────────────────

class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private authFolder: string = path.join(process.cwd(), 'auth_keys');
  private rebooting: Set<string> = new Set();

  constructor() {
    if (!fs.existsSync(this.authFolder)) {
      fs.mkdirSync(this.authFolder, { recursive: true });
    }
  }

  /**
   * Initializes a new WhatsApp-Web.js client for the given session ID
   */
  async startSession(sessionId: string): Promise<void> {
    logger.info(`Starting session: ${sessionId}`);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: this.authFolder }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    this.sessions.set(sessionId, { client, status: 'STARTING', qrCode: null });

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

      // Anexa listeners diretos no Puppeteer — capturam crashes que a
      // whatsapp-web.js NÃO consegue propagar como 'disconnected' (ex.: OOM
      // do Chromium, frame detached por reload forçado da Meta).
      this.attachPuppeteerWatchdog(sessionId, client);
      // Health check ativo — dispara reboot se o pupPage parar de responder.
      this.startHealthCheck(sessionId);

      // Aquece o cache de fotos de perfil em background.
      // Delay de 5s para o WhatsApp estabilizar antes de começar as requisições.
      setTimeout(() => {
        this.warmProfilePicCache(sessionId, client).catch(() => {});
      }, 5000);

      // Notifica o status via NotifyService (Socket.IO)
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyStatus(sessionId, 'session.connected', { status: 'CONNECTED' });
      });
    });

    // ── Autenticado ─────────────────────────────────────────────────────────
    client.on('authenticated', () => {
      logger.info(`[${sessionId}] Autenticado.`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'CONNECTED'; // Pode ser refinado se necessário
      }

      // Notifica os apps que a sessão foi autenticada — permite liberar a UI
      // assim que o login é validado, sem esperar o evento 'ready'.
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyStatus(sessionId, 'session.authenticated', { status: 'CONNECTED' });
      });
    });

    client.on('auth_failure', (msg) => {
      logger.error(`[${sessionId}] AUTH FAILURE: ${msg}`);
      this.handleDisconnection(sessionId, `auth_failure: ${msg}`);
    });

    // ── Desconectado ─────────────────────────────────────────────────────────
    client.on('disconnected', (reason) => {
      logger.warn(`[${sessionId}] Desconectado: ${reason}. Acionando auto-healing...`);
      this.rebootSession(sessionId, `disconnected: ${reason}`);
    });

    // ── Mudança de Estado ───────────────────────────────────────────────────
    client.on('change_state', (state) => {
      logger.info(`[${sessionId}] Estado alterado para: ${state}`);
      if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
        this.handleDisconnection(sessionId, `state_change: ${state}`);
      }
    });

    // ── MENSAGENS RECEBIDAS (de outras pessoas) ───────────────────────────────
    // Espelha exatamente a lógica do client.on('message', ...) do whatsapp.ts
    client.on('message', async (msg: WWebMessage) => {
      // Filtro modificado: aceita mensagens de contatos individuais e grupos
      // Descarta msgs vazias sem mídia
      if (
        (msg.body === '' && !msg.hasMedia) ||
        msg.fromMe
      ) return;

      const isGroup = msg.from.includes('@g.us');
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const profilePicUrl = await fetchProfilePicIfNew(client, isGroup ? chat : contact);
      const pushName = contact.pushname || contact.name || '';
      const previewText = getPreviewText(msg);

      // Tratamento de IDs: se for @lid, guardamos no campo lid, mas para o jid tentamos usar o @c.us se disponível
      const lid = msg.from.includes('@lid') ? msg.from : null;
      let jid = msg.from;

      if (!isGroup && jid.includes('@lid') && contact && contact.id._serialized.includes('@c.us')) {
        jid = contact.id._serialized;
      }

      logger.info(`[${sessionId}] Mensagem recebida de lid ${lid} jid ${jid} | tipo: ${msg.type}`);

      let mediaUrl = null;
      let mediaMime = null;

      // Se tiver mídia, baixa AGORA antes de notificar via Socket
      if (msg.hasMedia) {
        const savedMedia = await saveMedia(sessionId, msg);
        if (savedMedia) {
          mediaUrl = savedMedia.url;
          mediaMime = savedMedia.type;
        } else {
          // Fallback se falhar o download
          mediaUrl = `${config.baseUrl}/media/error-media.png`;
          mediaMime = 'image/png';
        }
      }

      // Extrai mensagem respondida (quoted) se houver
      let quotedMsg: any = null;
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          if (quoted) {
            quotedMsg = quoted.id._serialized
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      // Dispara o evento apenas APÓS o processamento da mídia
      const payload: any = {
        id: msg.id.id,
        serializedId: msg.id._serialized,
        fromMe: false,
        jid: jid,
        lid: lid,
        userId: msg.author || msg.from,
        userName: pushName,
        isGroup: isGroup,
        groupName: isGroup ? chat.name : null,
        text: msg.body || '',
        pushName,
        previewText,
        timestamp: msg.timestamp,
        mediaType: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl,
        mediaMime,
        vCards: (msg.type === 'vcard' || msg.type === 'multi_vcard') ? msg.vCards : [],
        quotedMsg,
        isForwarded: msg.isForwarded,
        forwardingScore: msg.forwardingScore,
        profilePicUrl,
      };

      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessage(sessionId, payload);
      });
    });

    // ── MENSAGENS ENVIADAS POR MIM ────────────────────────────────────────────
    // Espelha exatamente a lógica do client.on('message_create', ...) do whatsapp.ts
    client.on('message_create', async (msg: WWebMessage) => {
      // Só processa mensagens que eu enviei
      if (!msg.fromMe) return;
      // Ignora newsletters e status (grupos agora são permitidos)
      if (
        msg.from.includes('newsletter') ||
        msg.from.includes('status@broadcast')
      ) return;

      const previewText = getPreviewText(msg);

      let mediaUrl = null;
      let mediaMime = null;

      // Se tiver mídia, baixa AGORA antes de notificar via Socket
      if (msg.hasMedia) {
        const savedMedia = await saveMedia(sessionId, msg);
        if (savedMedia) {
          mediaUrl = savedMedia.url;
          mediaMime = savedMedia.type;
        } else {
          // Fallback se falhar
          mediaUrl = `${config.baseUrl}/media/error-media.png`;
          mediaMime = 'image/png';
        }
      }

      // Extrai mensagem respondida (quoted) se houver
      let quotedMsg: any = null;
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          if (quoted) {
            quotedMsg = quoted.id._serialized
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      const isGroup = msg.to.includes('@g.us')
      const chat = await msg.getChat()
      const contact = await client.getContactById(isGroup ? (msg.author || msg.from) : msg.to)
      const profilePicUrl = await fetchProfilePicIfNew(client, isGroup ? chat : contact);

      // Tratamento de IDs na mensagem enviada (message_create)
      const lid = msg.to.includes('@lid') ? msg.to : null;
      let jid = chat.id._serialized;

      // Se o chat for @lid e o contato tiver @c.us, preferimos o @c.us para o JID da conversa
      if (!isGroup && jid.includes('@lid') && contact && contact.id._serialized.includes('@c.us')) {
        jid = contact.id._serialized;
      }

      const payload: any = {
        id: msg.id.id,
        serializedId: msg.id._serialized,
        fromMe: true,
        lid: lid,
        jid: jid,
        userId: msg.author || (client.info ? client.info.wid._serialized : null), // No caso de msg enviada por mim
        userName: contact.pushname || contact.name || '',
        isGroup: isGroup,
        groupName: isGroup ? chat.name : null,
        text: msg.body || '',
        pushName: contact.pushname || contact.name || jid.split('@')[0],
        previewText,
        timestamp: msg.timestamp,
        mediaType: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl,
        mediaMime,
        vCards: (msg.type === 'vcard' || msg.type === 'multi_vcard') ? msg.vCards : [],
        quotedMsg,
        isForwarded: msg.isForwarded,
        forwardingScore: msg.forwardingScore,
        profilePicUrl,
      };

      logger.info(`[${sessionId}] Mensagem ENVIADA para lid ${lid} jid ${jid} | tipo: ${msg.type}`);
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessage(sessionId, payload);
      });
    });

    client.on('message_edit', async (msg, newBody, prevBody) => {
      logger.info(`[${sessionId}] Mensagem EDITADA (${msg.id.id}): ${prevBody} -> ${newBody}`);
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessageEdit(sessionId, {
          id: msg.id.id,
          newText: newBody,
          timestamp: msg.timestamp
        });
      });
    });

    client.on('message_revoke_everyone', async (msg, revokedMsg) => {
      const id = revokedMsg ? revokedMsg.id.id : msg.id.id;
      logger.info(`[${sessionId}] Mensagem EXCLUÍDA (${id})`);
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessageDelete(sessionId, { id });
      });
    });

    client.on('message_reaction', async (reaction) => {
      logger.info(`[${sessionId}] REAÇÃO recebida na mensagem ${reaction.msgId}: ${reaction.reaction}`);
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessageReaction(sessionId, {
          id: reaction.msgId,
          reaction: {
            text: reaction.reaction,
            senderId: reaction.senderId
          }
        });
      });
    });

    client.on('message_ack', async (msg, ack) => {
      logger.info(`[${sessionId}] ACK recebido na mensagem ${msg.id.id} | valor: ${ack}`);
      import('./NotifyService').then(({ NotifyService }) => {
        NotifyService.notifyMessageAck(sessionId, {
          id: msg.id.id,
          ack
        });
      });
    });

    client.initialize().catch(err => {
      logger.error(`[${sessionId}] Falha ao inicializar: ${err.message}`);

      // "The browser is already connected/running" — o processo anterior ainda
      // não morreu. A lib não resolve sozinha; acionamos um novo reboot para
      // que killBrowser() mate o zumbi antes da próxima tentativa.
      const msg: string = err?.message || '';
      if (
        msg.includes('browser is already') ||
        msg.includes('Failed to launch') ||
        isDeadFrameError(err)
      ) {
        logger.warn(`[${sessionId}] Erro de inicialização recuperável — agendando reboot.`);
        // Remove da lista de rebooting para que rebootSession() consiga entrar
        this.rebooting.delete(sessionId);
        setTimeout(() => this.rebootSession(sessionId, `initialize error: ${msg}`), 3000);
      }
    });
  }

  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, status: 'NOT_FOUND' };
    return { exists: true, status: session.status, qrCode: session.qrCode };
  }

  getAllSessions() {
    const sessions: any[] = [];
    this.sessions.forEach((data, id) => {
      sessions.push({
        id,
        status: data.status,
        qrCode: data.qrCode
      });
    });
    return sessions;
  }

  private formatJid(number: string): string {
    if (number.includes('@c.us') || number.includes('@g.us') || number.includes('@lid')) return number;
    return `${number}@c.us`;
  }

  async sendMessage(
    sessionId: string,
    to: string,
    text: string,
    mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt',
    mediaBuffer?: Buffer,
    mediaMime?: string,
    quotedMessageId?: string
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(to);
    let options: any = {};
    let content: any = text;

    if (mediaBuffer && mediaMime) {
      // Envio direto via Buffer (Memória) - Usado pelo Frontend
      const media = new MessageMedia(mediaMime, mediaBuffer.toString('base64'), `file_${Date.now()}`);
      content = media;
      options.caption = text;
      if (mediaType === 'ptt') options.sendAudioAsVoice = true;
    }

    // Se for uma resposta a outra mensagem, usa msg.reply() para garantir o quote
    if (quotedMessageId) {
      try {
        const quotedMsg = await session.client.getMessageById(quotedMessageId);
        if (quotedMsg) {
          const resp = await quotedMsg.reply(content, jid, options);
          return {
            id: resp.id.id,
            serializedId: resp.id._serialized,
            fromMe: resp.fromMe,
            to: resp.to,
            text: resp.body,
            timestamp: resp.timestamp
          };
        }
      } catch (err: any) {
        logger.warn(`[${sessionId}] Falha ao buscar mensagem citada ${quotedMessageId}: ${err.message}. Enviando sem quote.`);
      }
    }

    // Tenta com JID formatado; se der "No LID for user", tenta o numero puro
    try {
      const resp = await session.client.sendMessage(jid, content, options);
      return {
        id: resp.id.id,
        serializedId: resp.id._serialized,
        fromMe: resp.fromMe,
        to: resp.to,
        text: resp.body,
        timestamp: resp.timestamp
      };
    } catch (err: any) {
      if (err.message?.includes('No LID for user')) {
        logger.warn(`[${sessionId}] No LID para ${jid}, tentando numero direto: ${to}@c.us`);
        const resp = await session.client.sendMessage(`${to.replace(/@.*/, '')}@c.us`, content, options);
        return {
          id: resp.id.id,
          serializedId: resp.id._serialized,
          fromMe: resp.fromMe,
          to: resp.to,
          text: resp.body,
          timestamp: resp.timestamp
        };
      }

      if (isDeadFrameError(err)) {
        logger.error(`[${sessionId}] Frame morto detectado em sendMessage: ${err?.message}`);
        this.rebootSession(sessionId, `sendMessage frame crash: ${err?.message}`);
        throw new Error('Sessão em recuperação automática');
      }

      throw err;
    }
  }

  /**
   * Anexa listeners diretos no Puppeteer (browser/page). Necessário porque a
   * whatsapp-web.js às vezes não emite 'disconnected' quando o Chromium morre
   * de forma abrupta — o próprio runtime que emitiria o evento já está morto.
   */
  private attachPuppeteerWatchdog(sessionId: string, client: Client) {
    const browser = (client as any).pupBrowser;
    const page = (client as any).pupPage;

    if (browser && typeof browser.on === 'function') {
      browser.on('disconnected', () => {
        logger.error(`[${sessionId}] Puppeteer browser DISCONNECTED — acionando reboot.`);
        this.rebootSession(sessionId, 'puppeteer browser disconnected');
      });
    }

    if (page && typeof page.on === 'function') {
      page.on('close', () => {
        logger.error(`[${sessionId}] Puppeteer page CLOSED — acionando reboot.`);
        this.rebootSession(sessionId, 'puppeteer page closed');
      });
      page.on('error', (err: any) => {
        logger.error(`[${sessionId}] Puppeteer page ERROR: ${err?.message} — acionando reboot.`);
        this.rebootSession(sessionId, `puppeteer page error: ${err?.message}`);
      });
    }
  }

  /**
   * Health check ativo: a cada 30s, faz uma operação leve no pupPage. Se
   * falhar (frame detached, contexto destruído, timeout), dispara reboot.
   * Cobre o cenário em que o frame trava sem emitir nenhum evento.
   */
  private startHealthCheck(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.healthTimer) clearInterval(session.healthTimer);

    session.healthTimer = setInterval(async () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.status !== 'CONNECTED' || this.rebooting.has(sessionId)) return;

      const page = (s.client as any).pupPage;
      if (!page || page.isClosed?.()) {
        logger.error(`[${sessionId}] HealthCheck: pupPage ausente/fechado — reboot.`);
        this.rebootSession(sessionId, 'healthcheck: pupPage closed');
        return;
      }

      try {
        const probe = page.evaluate(() => 1);
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('healthcheck timeout')), 10000));
        await Promise.race([probe, timeout]);
      } catch (err: any) {
        logger.error(`[${sessionId}] HealthCheck falhou (${err?.message}) — reboot.`);
        this.rebootSession(sessionId, `healthcheck: ${err?.message}`);
      }
    }, 30000);
  }

  /**
   * Mata o processo do Chromium de forma agressiva antes de destruir o client.
   * Necessário porque destroy() às vezes retorna sem ter fechado o browser —
   * o processo fica zumbi e o próximo initialize() lança "The browser is already".
   */
  private async killBrowser(client: Client): Promise<void> {
    // 1. Tenta fechar a página graciosamente
    try {
      const page = (client as any).pupPage;
      if (page && !page.isClosed?.()) await page.close().catch(() => {});
    } catch {}

    // 2. Fecha o browser
    try {
      const browser = (client as any).pupBrowser;
      if (browser) await browser.close().catch(() => {});
    } catch {}

    // 3. Por último, destroy() da lib para limpar o estado interno
    try {
      await client.destroy().catch(() => {});
    } catch {}
  }

  /**
   * Aquece o cache local de fotos de perfil logo após a sessão conectar.
   *
   * Gatilho deliberadamente ENXUTO: em vez de varrer a agenda inteira
   * (getContacts → milhares de downloads a cada reconexão/auto-healing),
   * pré-carrega apenas os contatos das CONVERSAS MAIS RECENTES — os que de
   * fato aparecem na UI. Todo o resto é baixado sob demanda pelo
   * fetchProfilePicIfNew quando chega/sai uma mensagem.
   */
  private async warmProfilePicCache(sessionId: string, client: Client): Promise<void> {
    // Quantos chats recentes pré-aquecer. O restante fica sob demanda.
    const RECENT_CHATS_LIMIT = 30;

    logger.info(`[${sessionId}] Iniciando warm-up do cache de fotos de perfil...`);
    try {
      const chats = await client.getChats();

      // Conversas individuais, mais recentes primeiro, limitadas ao teto.
      const recent = chats
        .filter(chat => {
          const jid = chat.id?._serialized || '';
          return (
            !chat.isGroup &&
            !jid.includes('@g.us') &&
            !jid.includes('@newsletter') &&
            !jid.includes('@broadcast') &&
            !jid.includes('@lid')
          );
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, RECENT_CHATS_LIMIT);

      // Só baixa quem ainda não tem cache válido (< 24h)
      const stale = recent.filter(c => !hasValidProfilePicCache(c.id._serialized));
      logger.info(`[${sessionId}] Warm-up: ${stale.length}/${recent.length} chats recentes sem cache válido.`);

      if (stale.length === 0) return;

      const BATCH = 5;
      const DELAY_MS = 400; // entre lotes — evita rate-limit do WhatsApp

      for (let i = 0; i < stale.length; i += BATCH) {
        // Abort se a sessão cair durante o warm-up
        const s = this.sessions.get(sessionId);
        if (!s || s.status !== 'CONNECTED') {
          logger.info(`[${sessionId}] Warm-up interrompido — sessão desconectada.`);
          return;
        }

        await Promise.allSettled(
          stale.slice(i, i + BATCH).map(c => fetchProfilePic(client, c).catch(() => null))
        );

        if (i + BATCH < stale.length) {
          await new Promise(r => setTimeout(r, DELAY_MS));
        }
      }

      logger.info(`[${sessionId}] Warm-up de fotos concluído.`);
    } catch (err: any) {
      logger.warn(`[${sessionId}] Warm-up de fotos falhou: ${err.message}`);
    }
  }

  /**
   * Auto-healing: derruba o cliente atual (incluindo kill do Chromium) e sobe
   * um novo navegador limpo após um breve atraso.
   * Isolado por sessionId — não afeta sessões paralelas.
   */
  private rebootSession(sessionId: string, reason: string) {
    if (this.rebooting.has(sessionId)) {
      logger.info(`[${sessionId}] Reboot já em andamento — ignorando novo gatilho (${reason}).`);
      return;
    }
    this.rebooting.add(sessionId);

    logger.warn(`[${sessionId}] Iniciando reboot da sessão. Motivo: ${reason}`);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'DISCONNECTED';
      if (session.healthTimer) {
        clearInterval(session.healthTimer);
        session.healthTimer = undefined;
      }
    }

    this.handleDisconnection(sessionId, reason);

    // Kill async — não bloqueia o fluxo, mas garante que o browser morre
    // antes de subirmos o novo startSession (o setTimeout cobre a janela).
    if (session) {
      this.killBrowser(session.client).catch(() => {});
    }

    setTimeout(async () => {
      try {
        this.sessions.delete(sessionId);
        await this.startSession(sessionId);
        logger.info(`[${sessionId}] Reboot concluído — sessão reinicializada.`);
      } catch (e: any) {
        logger.error(`[${sessionId}] Falha no reboot: ${e?.message}`);
        this.rebooting.delete(sessionId);
      }
    }, 7000);
  }

  /**
   * Wrapper defensivo para chat.fetchMessages().
   *
   * fetchMessages dispara a paginação interna do WhatsApp Web (loadEarlierMsgs →
   * PrivateChat.fetchMessages). Quando o WhatsApp faz rollout de uma versão nova
   * que diverge do que o whatsapp-web.js injeta, esse path quebra com erros crus
   * como "Cannot read properties of undefined (reading 'waitForChatLoading')" e
   * pode até travar. Aqui aplicamos timeout + tradução do erro para não derrubar
   * o fluxo do controller a cada rollout.
   */
  private async fetchMessagesSafe(
    chat: any,
    searchOptions: { limit?: number; fromMe?: boolean },
    sessionId: string,
    timeoutMs: number = 30000,
  ): Promise<WWebMessage[]> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('fetchMessages timeout')), timeoutMs),
    );
    try {
      return await Promise.race([chat.fetchMessages(searchOptions), timeout]);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const wm
        = /waitForChatLoading|loadEarlierMsgs|getLastMsgKeyForAction|timeout/i.test(msg);
      logger.error(
        `[${sessionId}] fetchMessages falhou (chat ${chat?.id?._serialized}): ${msg}`
        + (wm
          ? ' — provável incompatibilidade whatsapp-web.js × versão do WhatsApp Web.'
          : ''),
      );
      throw new Error(`Falha ao buscar mensagens: ${msg}`);
    }
  }

  async getMessages(sessionId: string, number: string, limit: number = 50) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await this.fetchMessagesSafe(chat, { limit }, sessionId);


    return await Promise.all(messages.map(async (msg) => {
      let mediaUrl = null;
      let mediaMime = null;

      if (msg.hasMedia) {
        const savedMedia = await saveMedia(sessionId, msg);
        if (savedMedia) {
          mediaUrl = savedMedia.url;
          mediaMime = savedMedia.type;
        } else {
          mediaUrl = `${config.baseUrl}/media/error-media.png`;
          mediaMime = 'image/png';
        }
      }

      // Resolve contact for LID/Jid mapping
      const contact = await msg.getContact();

      // Extrai mensagem respondida (quoted) se houver
      let quotedMsg: any = null;
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          if (quoted) {
            quotedMsg = quoted.id._serialized
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      return {
        id: msg.id.id,
        serializedId: msg.id._serialized,
        fromMe: msg.fromMe,
        from: msg.from,
        to: msg.to,
        text: msg.body || '',
        pushName: contact.pushname || contact.name || '',
        previewText: getPreviewText(msg),
        timestamp: msg.timestamp,
        mediaType: msg.type,
        hasMedia: msg.hasMedia,
        mediaUrl,
        mediaMime,
        vCards: (msg.type === 'vcard' || msg.type === 'multi_vcard') ? msg.vCards : [],
        quotedMsg,
        isForwarded: msg.isForwarded,
        forwardingScore: msg.forwardingScore,
        profilePicUrl: await fetchProfilePicIfNew(session.client, contact),
      };
    }));
  }

  async editMessage(sessionId: string, number: string, messageId: string, newText: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await this.fetchMessagesSafe(chat, { limit: 100 }, sessionId);
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error('Message not found');
    return await msg.edit(newText);
  }

  async deleteMessage(sessionId: string, number: string, messageId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await this.fetchMessagesSafe(chat, { limit: 100 }, sessionId);
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error('Message not found');
    return await msg.delete(true);
  }

  async forwardMessage(sessionId: string, fromNumber: string, messageId: string, toNumber: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const fromJid = this.formatJid(fromNumber);
    const toJid = this.formatJid(toNumber);

    const chat = await session.client.getChatById(fromJid);
    const messages = await this.fetchMessagesSafe(chat, { limit: 100 }, sessionId);
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error(`Message ${messageId} not found in chat ${fromJid}`);

    await msg.forward(toJid);
  }

  async reactToMessage(sessionId: string, number: string, messageId: string, emoji: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await this.fetchMessagesSafe(chat, { limit: 100 }, sessionId);
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error('Message not found');
    return await msg.react(emoji);
  }

  async getContacts(sessionId: string, opts: { withProfilePic?: boolean } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const rawContacts = await session.client.getContacts();

    // Filtra e formata os contatos, resolvendo LID para JID se necessário
    const formattedContacts = await Promise.all(rawContacts.map(async (contact) => {
      let jid = contact.id._serialized;

      // Ignora grupos, newsletters e status
      if (jid.includes('@g.us') || jid.includes('@newsletter') || jid.includes('@broadcast')) {
        return null;
      }

      // Se for @lid, tentamos obter o @c.us (JID)
      if (jid.includes('@lid')) {
        try {
          const resolvedContact = await session.client.getContactById(jid);
          if (resolvedContact && resolvedContact.id._serialized.includes('@c.us')) {
            jid = resolvedContact.id._serialized;
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao resolver LID ${jid}: ${err}`);
        }
      }

      // Extrai o número de telefone a partir do JID (ex: "5511999998888@c.us" → "5511999998888")
      const number = jid.includes('@') ? jid.split('@')[0] : jid;

      // Foto de perfil (opcional — pode ser lento para listas grandes)
      let profilePicUrl: string | null = null;
      if (opts.withProfilePic) {
        profilePicUrl = await fetchProfilePic(session.client, contact).catch(() => null);
      }

      return {
        jid,
        number,
        name: contact.name || '',
        pushname: contact.pushname || '',
        isMyContact: (contact as any).isMyContact ?? false,
        isUser: (contact as any).isUser ?? true,
        profilePicUrl,
      };
    }));

    // Remove duplicatas caso a resolução de LID tenha resultado em um JID que já existe na lista
    const uniqueContacts = Array.from(new Map(
      formattedContacts
        .filter((c): c is NonNullable<typeof formattedContacts[0]> => c !== null)
        .map(c => [c.jid, c])
    ).values());

    return uniqueContacts;
  }

  async searchContacts(sessionId: string, query: string, opts: { withProfilePic?: boolean } = {}) {
    const contacts = await this.getContacts(sessionId, opts);
    const q = query.toLowerCase().trim();
    if (!q) return contacts;

    return contacts.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.pushname.toLowerCase().includes(q) ||
      c.number.includes(q)
    );
  }

  getSessionInfo(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const info = (session.client as any).info;
    if (!info) throw new Error('Session info not available yet');

    return {
      jid: info.wid?._serialized ?? null,
      number: info.wid?.user ?? null,
      pushname: info.pushname ?? null,
      platform: info.platform ?? null,
    };
  }

  triggerReboot(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    this.rebootSession(sessionId, 'manual restart via API');
  }

  async getGroups(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const chats = await session.client.getChats();
    const groups = chats.filter(chat => chat.isGroup);

    return Promise.all(groups.map(async (group: any) => {
      const profilePicUrl = await fetchProfilePic(session.client, group);
      return {
        jid: group.id._serialized,
        name: group.name,
        description: group.description ?? null,
        unreadCount: group.unreadCount,
        timestamp: group.timestamp,
        participantCount: group.participants?.length ?? null,
        profilePicUrl
      };
    }));
  }

  async getGroupInfo(sessionId: string, groupId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
    const chat = await session.client.getChatById(jid) as any;
    if (!chat || !chat.isGroup) throw new Error('Group not found');

    const profilePicUrl = await fetchProfilePic(session.client, chat).catch(() => null);

    let inviteCode: string | null = null;
    try { inviteCode = await chat.getInviteCode(); } catch {}

    return {
      jid: chat.id._serialized,
      name: chat.name,
      description: chat.description ?? null,
      inviteLink: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null,
      participantCount: chat.participants?.length ?? 0,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      profilePicUrl,
    };
  }

  async getGroupMembers(sessionId: string, groupId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
    const chat = await session.client.getChatById(jid) as any;
    if (!chat || !chat.isGroup) throw new Error('Group not found');

    return Promise.all((chat.participants ?? []).map(async (p: any) => {
      const memberJid: string = p.id._serialized;
      const number = memberJid.includes('@') ? memberJid.split('@')[0] : memberJid;
      const profilePicUrl = await fetchProfilePic(session.client, memberJid).catch(() => null);
      return {
        jid: memberJid,
        number,
        isAdmin: p.isAdmin ?? false,
        isSuperAdmin: p.isSuperAdmin ?? false,
        profilePicUrl,
      };
    }));
  }

  async markAsRead(sessionId: string, chatId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(chatId);
    const chat = await session.client.getChatById(jid);
    await chat.sendSeen();
  }

  /**
   * Verifica se um número está registrado no WhatsApp.
   * Retorna o ID formatado (JID) se existir, ou null caso contrário.
   */
  async checkNumber(sessionId: string, number: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;

    try {
      const id = await session.client.getNumberId(formattedNumber);

      let pushname = null;
      let profilePicUrl = null;
      let jid = null;
      let lid = null;

      if (id) {
        const contact = await session.client.getContactById(id._serialized);
        pushname = contact.pushname || contact.name || null;
        profilePicUrl = await fetchProfilePic(session.client, contact);
        jid = contact.id._serialized.includes('@c.us') ? contact.id._serialized : null
        lid = id._serialized.includes('@lid') ? id._serialized : null
      }
      return {
        exists: !!id,
        jid: jid,
        lid: lid,
        number: number,
        pushname: pushname,
        profilePicUrl: profilePicUrl
      };
    } catch (err: any) {
      logger.error(`[${sessionId}] Erro ao verificar número ${number}: ${err.message}`);
      throw err;
    }
  }

  async deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.info(`[${sessionId}] Encerrando sessao...`);
      if (session.healthTimer) {
        clearInterval(session.healthTimer);
        session.healthTimer = undefined;
      }
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

  /**
   * Centraliza o tratamento de desconexão e notificação via Socket
   */
  private handleDisconnection(sessionId: string, reason: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'DISCONNECTED';
    }

    // Notifica a queda via NotifyService para que o front possa bloquear a tela
    import('./NotifyService').then(({ NotifyService }) => {
      NotifyService.notifyStatus(sessionId, 'session.disconnected', {
        status: 'DISCONNECTED',
        reason,
        message: 'WhatsApp desconectado ou inacessível'
      });
    });
  }
}

export const sessionManager = new SessionManager();
