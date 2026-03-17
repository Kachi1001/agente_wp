import { Client, LocalAuth, MessageMedia, Message as WWebMessage } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';
import qrcode from 'qrcode-terminal';

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
  if (!jid || typeof jid !== 'string') return null;
  console.log(contact)
  try {
    // Tenta primeiro via client, que costuma ser mais estável e evita erros internos do objeto contact
    const url = await client.getProfilePicUrl(jid);
    if (url) return url;
  } catch (err: any) {
    // Silencioso aqui, tenta fallback
  }

  try {
    // Fallback para o método do contato se o primeiro falhar
    if (contact && typeof contact.getProfilePicUrl === 'function') {
      const url = await contact.getProfilePicUrl();
      return url || null;
    }
  } catch (err: any) {
    logger.warn(`[ProfilePic] Fallback failed for ${jid}: ${err?.message}`);
  }

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
      // Filtro: só aceita mensagens de contatos individuais (@c.us) ou LID
      // Descarta msgs vazias sem mídia (ex: notificações de grupo)
      if (
        !(msg.from.includes('@c.us') || msg.from.includes('@lid')) ||
        (msg.body === '' && !msg.hasMedia) ||
        msg.fromMe
      ) return;

      const contact = await msg.getContact();
      const profilePicUrl = await fetchProfilePic(client, contact);
      const pushName = contact.pushname || contact.name || '';
      const previewText = getPreviewText(msg);

      const lid = msg.from.includes('@lid') ? msg.from : null
      const jid = contact.id._serialized.includes('@c.us') ? contact.id._serialized : null

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
            quotedMsg = quoted.id.id
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      // Dispara o evento apenas APÓS o processamento da mídia
      const payload: any = {
        id: msg.id.id,
        fromMe: false,
        jid: jid,
        lid: lid,
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
      // Ignora grupos, newsletters e status
      if (
        msg.from.includes('@g.us') ||
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
            quotedMsg = quoted.id.id
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      const lid = msg.to
      const contact = await client.getContactById(lid)
      const profilePicUrl = await fetchProfilePic(client, contact);
      const jid = contact.id._serialized

      const payload: any = {
        id: msg.id.id,
        fromMe: true,
        lid: lid,
        jid: jid,
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

    client.initialize().catch(err => {
      logger.error(`[${sessionId}] Falha ao inicializar: ${err.message}`);
    });
  }

  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { exists: false, status: 'NOT_FOUND' };
    return { exists: true, status: session.status, qrCode: session.qrCode };
  }

  private formatJid(number: string): string {
    return number.includes('@c.us') ? number : `${number}@c.us`;
  }

  async sendMessage(
    sessionId: string,
    to: string,
    text: string,
    mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt',
    mediaBuffer?: Buffer,
    mediaMime?: string
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
            quotedMsg = quoted.id.id
          }
        } catch (err) {
          logger.warn(`[${sessionId}] Falha ao obter quoted message: ${err}`);
        }
      }

      return {
        id: msg.id.id,
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
