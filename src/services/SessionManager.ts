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

async function fetchProfilePic(client: Client, contact: any): Promise<string | null> {
  const jid = contact?.id?._serialized || contact;
  logger.info(`[ProfilePicDebug] Started fetchProfilePic for JID: ${jid}, typeof contact: ${typeof contact}`);

  if (!jid || typeof jid !== 'string') {
    logger.info(`[ProfilePicDebug] Aborting, invalid jid: ${jid}`);
    return null;
  }

  // Mock de propriedades que podem estar faltando e causando crash na lib
  if (contact && typeof contact === 'object') {
    if (contact.isNewsletter === undefined) contact.isNewsletter = false;
    if (contact.isGroup === undefined) contact.isGroup = false;
  }

  // Verifica cache local
  const safeId = jid.replace(/[^a-zA-Z0-9@.-]/g, '_'); // Sanitizar o JID para ser nome de arquivo
  const profilePicsDir = path.join(process.cwd(), 'public', 'profile_pics');
  const filePath = path.join(profilePicsDir, `${safeId}.jpg`);
  
  // Confere existência da pasta
  if (!fs.existsSync(profilePicsDir)) {
    fs.mkdirSync(profilePicsDir, { recursive: true });
  }

  // Lógica de cache (24 horas)
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const msInDay = 24 * 60 * 60 * 1000;
    const isOld = (new Date().getTime() - stats.mtime.getTime()) > msInDay;
    
    // Se ainda for válido (não é old), retorna direto a URL cacheada local
    if (!isOld) {
      logger.info(`[ProfilePicDebug] Returning cached profile pic for ${jid}: ${safeId}.jpg`);
      return `${config.baseUrl}/profile_pics/${safeId}.jpg`;
    } else {
      logger.info(`[ProfilePicDebug] Cache is old for ${jid}, proceeding to download.`);
    }
    // Caso seja antigo, continua para baixar, tentar sobrescrever
  } else {
    logger.info(`[ProfilePicDebug] No local cache found for ${jid} at ${filePath}`);
  }

  // Se o client/contact não for objeto, interrompe o download via internet
  if (typeof contact === 'string') {
    logger.info(`[ProfilePicDebug] Contact is string, cannot fetch URL from WhatsApp for ${jid}`);
    return null;
  }

  let whatsappUrl = null;
  
  try {
    logger.info(`[ProfilePicDebug] Attempting direct WWebJS.getProfilePicUrl bypass for ${jid}`);
    const scanResult: any = await (client as any).pupPage.evaluate(async (contactId: string) => {
      try {
        const win = window as any;
        const Store = win.Store;
        if (!Store || !Store.WidFactory || !Store.ProfilePic) return { error: 'No Store/ProfilePic' };
        
        // --- REMÉDIO GLOBAL (GOLPE DE MESTRE) ---
        // A causa do erro é que o WhatsApp Web espera que TODOS os WIDs tenham 'isNewsletter'.
        // Vamos injetar isso no protótipo de TODOS os WIDs para que nunca mais dê undefined.
        try {
            const testWid = Store.WidFactory.createWid(contactId);
            const WidProto = Object.getPrototypeOf(testWid);
            if (WidProto && typeof WidProto.isNewsletter === 'undefined') {
                Object.defineProperty(WidProto, 'isNewsletter', {
                    get: function() { return false; },
                    configurable: true
                });
            }
        } catch (e) {}
        
        const wid = Store.WidFactory.createWid(contactId);
        
        let eurl = null;
        try {
            // Tenta forçar a sincronização caso a foto não esteja na memória
            await Store.ProfilePicThumb.find(wid).catch(() => {});
            
            // Pega o modelo de foto diretamente da coleção unificada
            const thumb = Store.ProfilePicThumb.get(wid);
            if (thumb && thumb.eurl) {
                eurl = thumb.eurl;
            }
        } catch(e) {}
        
        return eurl;
      } catch (e: any) {
        return null;
      }
    }, jid);

    whatsappUrl = scanResult || null;
    
    logger.info(`[ProfilePicDebug] Result: ${whatsappUrl}`);
  } catch (err: any) {
    logger.error(`[ProfilePicDebug] pupPage evaluation failed: ${err.message}`);
  }

  if (!whatsappUrl) {
    logger.info(`[ProfilePicDebug] Both getProfilePicUrl attempts failed or returned null for ${jid}. Returning null.`);
    return null;
  }

  // Realizar o download com axios interceptando
  try {
    logger.info(`[ProfilePicDebug] Downloading image from URL: ${whatsappUrl}`);
    const response = await axios.get(whatsappUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      },
      timeout: 10000 // Timeout de 10 segundos
    });

    // Se OK, salvar no disco e retornar URI local
    if (response.status === 200) {
      fs.writeFileSync(filePath, Buffer.from(response.data));
      logger.info(`[ProfilePicDebug] Successfully downloaded and saved image to ${filePath}`);
      return `${config.baseUrl}/profile_pics/${safeId}.jpg`;
    } else {
      logger.info(`[ProfilePicDebug] Axios download returned status ${response.status}`);
    }
  } catch (e: any) {
    logger.error(`[ProfilePicDebug] Axios download failed: ${e.message}`);
  }

  // Falha final, mas sem quebrar.
  logger.info(`[ProfilePicDebug] Reached the end with failure for ${jid}`);
  return null;
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
    });

    client.on('auth_failure', (msg) => {
      logger.error(`[${sessionId}] AUTH FAILURE: ${msg}`);
      this.handleDisconnection(sessionId, `auth_failure: ${msg}`);
    });

    // ── Desconectado ─────────────────────────────────────────────────────────
    client.on('disconnected', (reason) => {
      logger.warn(`[${sessionId}] Desconectado: ${reason}. Reconectando em 5s...`);
      this.handleDisconnection(sessionId, reason);
      setTimeout(() => this.startSession(sessionId), 5000);
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
      const profilePicUrl = await fetchProfilePic(client, isGroup ? chat : contact);
      const pushName = contact.pushname || contact.name || '';
      const previewText = getPreviewText(msg);

      const lid = msg.from.includes('@lid') ? msg.from : null;
      const jid = msg.from; // Usa o JID da conversa (grupo ou contato)

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

      const lid = msg.to
      const isGroup = lid.includes('@g.us')
      const chat = await msg.getChat()
      const contact = await client.getContactById(isGroup ? (msg.author || msg.from) : lid)
      const profilePicUrl = await fetchProfilePic(client, isGroup ? chat : contact);
      const jid = chat.id._serialized

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
      throw err;
    }
  }

  async getMessages(sessionId: string, number: string, limit: number = 50) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await chat.fetchMessages({ limit });


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
        profilePicUrl: await fetchProfilePic(session.client, contact),
      };
    }));
  }

  async editMessage(sessionId: string, number: string, messageId: string, newText: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error('Message not found');
    return await msg.edit(newText);
  }

  async deleteMessage(sessionId: string, number: string, messageId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await chat.fetchMessages({ limit: 100 });
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
    const messages = await chat.fetchMessages({ limit: 100 });
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error(`Message ${messageId} not found in chat ${fromJid}`);

    await msg.forward(toJid);
  }

  async reactToMessage(sessionId: string, number: string, messageId: string, emoji: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const jid = this.formatJid(number);
    const chat = await session.client.getChatById(jid);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);

    if (!msg) throw new Error('Message not found');
    return await msg.react(emoji);
  }

  async getContacts(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') throw new Error('Session not connected');

    const rawContacts = await session.client.getContacts();

    // Filtra e formata os contatos, resolvendo LID para JID se necessário
    const formattedContacts = await Promise.all(rawContacts.map(async (contact) => {
      let jid = contact.id._serialized;

      if (jid.includes('@g.us') || jid.includes('@newsletter')) {
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

      return {
        jid,
        name: contact.name || '',
        pushname: contact.pushname || ''
      };
    }));

    // Remove duplicatas caso a resolução de LID tenha resultado em um JID que já existe na lista
    const uniqueContacts = Array.from(new Map(
      formattedContacts
        .filter((c): c is { jid: string; name: string; pushname: string } => c !== null)
        .map(c => [c.jid, c])
    ).values());

    return uniqueContacts;
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
        unreadCount: group.unreadCount,
        timestamp: group.timestamp,
        profilePicUrl
      };
    }));
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
