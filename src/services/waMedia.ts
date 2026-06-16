import { Client, Message as WWebMessage } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';
import axios from 'axios';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers puros de mídia / fotos de perfil / classificação de erros.
//
// Extraídos do antigo SessionManager (monólito) para um módulo único, sem estado,
// importado TANTO pelo processo filho (sessionWorker) QUANTO pelo legado
// (LegacySessionManager). Mantém uma só cópia da lógica — nada de duplicação.
// ──────────────────────────────────────────────────────────────────────────────

// Padrões de erro que indicam que o Chromium/frame morreu — não há recuperação
// possível via retry; somente reiniciando o navegador (no novo modelo: reiniciando
// o processo filho).
export const DEAD_FRAME_PATTERNS = [
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

export const PROFILE_PICS_DIR = path.join(process.cwd(), 'public', 'profile_pics');
const PROFILE_PIC_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/** Retorna true se já existe cache válido (< 24h) para o JID. */
export function hasValidProfilePicCache(jid: string): boolean {
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
export async function fetchProfilePicIfNew(client: Client, contact: any): Promise<string | null> {
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

export async function fetchProfilePic(client: Client, contact: any): Promise<string | null> {
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
