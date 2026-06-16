import { Client, LocalAuth, MessageMedia, Message as WWebMessage } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import qrcode from 'qrcode-terminal';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  getPreviewText,
  saveMedia,
  fetchProfilePic,
  fetchProfilePicIfNew,
  hasValidProfilePicCache,
  isDeadFrameError,
} from './waMedia';
import {
  IPC_PROTOCOL_VERSION,
  ChildToParent,
  ParentToChild,
  RpcMethod,
  WorkerEventType,
} from './ipcProtocol';

// ──────────────────────────────────────────────────────────────────────────────
// sessionWorker — processo FILHO. Dono de UM Client whatsapp-web.js + Chromium,
// para UMA sessão. Fala IPC com o Supervisor (pai).
//
// Toda a recuperação agora é por PROCESSO: um frame morto / OOM do Chromium mata
// só este filho (process.exit(1)), e o Supervisor faz respawn com backoff. Não há
// mais o loop de reboot in-process — é exatamente o que elimina o "browser is
// already running" em cascata.
// ──────────────────────────────────────────────────────────────────────────────

const SESSION_ID = process.env.WW_SESSION_ID || '';
const AUTH_FOLDER = process.env.WW_AUTH_FOLDER || path.join(process.cwd(), 'auth_keys');

let client: Client;
let connected = false;
let isExiting = false;
let healthTimer: NodeJS.Timeout | undefined;

// ── IPC helpers ───────────────────────────────────────────────────────────────
function send(msg: ChildToParent): void {
  try { process.send?.(msg); } catch { /* canal fechado — ignorado */ }
}
function emitEvent(eventType: WorkerEventType, data: any): void {
  send({ kind: 'event', eventType, data });
}
function pushState(
  status: 'STARTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED',
  extra: { qrCode?: string | null; info?: any; reason?: string } = {},
): void {
  send({ kind: 'state', status, ...extra });
}
function log(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void {
  // O logger (em modo worker) grava no arquivo DESTA sessão, imprime no stdout
  // herdado (PM2) e encaminha ao pai via IPC para o stream ao vivo do /admin.
  (logger as any)[level]?.(event, meta ?? {});
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Robustez relocada: limpeza de lock + kill agressivo do Chromium ────────────
function clearSingletonLocks(): void {
  const dir = path.join(AUTH_FOLDER, `session-${SESSION_ID}`);
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
  }
}

async function killBrowser(): Promise<void> {
  const browser = (client as any)?.pupBrowser;
  let proc: any = null;
  try { proc = browser?.process?.() ?? null; } catch {}
  try {
    const page = (client as any)?.pupPage;
    if (page && !page.isClosed?.()) await Promise.race([page.close().catch(() => {}), delay(3000)]);
  } catch {}
  try { if (browser) await Promise.race([browser.close().catch(() => {}), delay(3000)]); } catch {}
  try { await Promise.race([client?.destroy().catch(() => {}), delay(3000)]); } catch {}
  // GARANTIA: SIGKILL no processo do SO. close()/destroy() viram no-op quando o
  // CDP já morreu; sem este kill o Chromium fica zumbi segurando o SingletonLock.
  try {
    if (proc?.pid && !proc.killed) {
      proc.kill('SIGKILL');
      log('info', `[${SESSION_ID}] SIGKILL no Chromium pid ${proc.pid}`);
    }
  } catch {}
}

// ── Saída fatal (crash) → exit(1) → Supervisor respawna com backoff ───────────
async function fatalExit(reason: string): Promise<void> {
  if (isExiting) return;
  isExiting = true;
  connected = false;
  if (healthTimer) clearInterval(healthTimer);
  log('error', `[${SESSION_ID}] worker fatal`, { reason });
  pushState('DISCONNECTED', { reason });
  send({ kind: 'fatal', reason });
  try { await killBrowser(); } catch {}
  clearSingletonLocks();
  // Pequeno atraso para o canal IPC drenar as mensagens acima antes do exit.
  await delay(150);
  process.exit(1);
}

// ── Saída graciosa (stop/delete pelo Supervisor) → exit(0) → NÃO respawna ─────
async function gracefulShutdown(mode: 'graceful' | 'logout'): Promise<void> {
  if (isExiting) return;
  isExiting = true;
  connected = false;
  if (healthTimer) clearInterval(healthTimer);
  log('info', `[${SESSION_ID}] shutdown (${mode})`);
  try {
    if (mode === 'logout') await Promise.race([client?.logout().catch(() => {}), delay(5000)]);
  } catch {}
  try { await killBrowser(); } catch {}
  clearSingletonLocks();
  await delay(150);
  process.exit(0);
}

// ── Watchdogs (relocados do antigo SessionManager) ────────────────────────────
function attachPuppeteerWatchdog(): void {
  const browser = (client as any).pupBrowser;
  const page = (client as any).pupPage;
  browser?.on?.('disconnected', () => fatalExit('puppeteer browser disconnected'));
  page?.on?.('close', () => fatalExit('puppeteer page closed'));
  page?.on?.('error', (err: any) => fatalExit(`puppeteer page error: ${err?.message}`));
}

function startHealthCheck(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (isExiting || !connected) return;
    const page = (client as any).pupPage;
    if (!page || page.isClosed?.()) return void fatalExit('healthcheck: pupPage closed');
    try {
      const probe = page.evaluate(() => 1);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('healthcheck timeout')), 10000));
      await Promise.race([probe, timeout]);
    } catch (err: any) {
      fatalExit(`healthcheck: ${err?.message}`);
    }
  }, 30000);
}

// ── Helpers locais portados do monólito ───────────────────────────────────────
function formatJid(number: string): string {
  if (number.includes('@c.us') || number.includes('@g.us') || number.includes('@lid')) return number;
  return `${number}@c.us`;
}

function assertConnected(): void {
  if (!connected) throw new Error('Session not connected');
}

/**
 * Wrapper defensivo para chat.fetchMessages() — timeout + tradução de erro.
 * Portado do monólito (incompatibilidades whatsapp-web.js × WhatsApp Web).
 */
async function fetchMessagesSafe(
  chat: any,
  searchOptions: { limit?: number; fromMe?: boolean },
  timeoutMs: number = 30000,
): Promise<WWebMessage[]> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('fetchMessages timeout')), timeoutMs),
  );
  try {
    return await Promise.race([chat.fetchMessages(searchOptions), timeout]);
  } catch (err: any) {
    const msg = err?.message || String(err);
    const wm = /waitForChatLoading|loadEarlierMsgs|getLastMsgKeyForAction|timeout/i.test(msg);
    log('error',
      `[${SESSION_ID}] fetchMessages falhou (chat ${chat?.id?._serialized}): ${msg}`
      + (wm ? ' — provável incompatibilidade whatsapp-web.js × versão do WhatsApp Web.' : ''));
    throw new Error(`Falha ao buscar mensagens: ${msg}`);
  }
}

/** Aquece o cache de fotos das conversas recentes (idêntico ao monólito). */
async function warmProfilePicCache(): Promise<void> {
  const RECENT_CHATS_LIMIT = 30;
  log('info', `[${SESSION_ID}] Iniciando warm-up do cache de fotos de perfil...`);
  try {
    const chats = await client.getChats();
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

    const stale = recent.filter(c => !hasValidProfilePicCache(c.id._serialized));
    log('info', `[${SESSION_ID}] Warm-up: ${stale.length}/${recent.length} chats recentes sem cache válido.`);
    if (stale.length === 0) return;

    const BATCH = 5;
    const DELAY_MS = 400;
    for (let i = 0; i < stale.length; i += BATCH) {
      if (isExiting || !connected) {
        log('info', `[${SESSION_ID}] Warm-up interrompido — sessão indisponível.`);
        return;
      }
      await Promise.allSettled(stale.slice(i, i + BATCH).map(c => fetchProfilePic(client, c).catch(() => null)));
      if (i + BATCH < stale.length) await delay(DELAY_MS);
    }
    log('info', `[${SESSION_ID}] Warm-up de fotos concluído.`);
  } catch (err: any) {
    log('warn', `[${SESSION_ID}] Warm-up de fotos falhou: ${err?.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Operações RPC (corpo idêntico ao monólito, sem o lookup this.sessions.get).
// ──────────────────────────────────────────────────────────────────────────────

async function sendMessage(
  to: string,
  text: string,
  mediaType?: 'image' | 'audio' | 'video' | 'document' | 'ptt',
  mediaBase64?: string,
  mediaMime?: string,
  quotedMessageId?: string,
) {
  assertConnected();
  const jid = formatJid(to);
  const options: any = {};
  let content: any = text;

  if (mediaBase64 && mediaMime) {
    const media = new MessageMedia(mediaMime, mediaBase64, `file_${Date.now()}`);
    content = media;
    options.caption = text;
    if (mediaType === 'ptt') options.sendAudioAsVoice = true;
  }

  if (quotedMessageId) {
    try {
      const quotedMsg = await client.getMessageById(quotedMessageId);
      if (quotedMsg) {
        const resp = await quotedMsg.reply(content, jid, options);
        return { id: resp.id.id, serializedId: resp.id._serialized, fromMe: resp.fromMe, to: resp.to, text: resp.body, timestamp: resp.timestamp };
      }
    } catch (err: any) {
      log('warn', `[${SESSION_ID}] Falha ao buscar citada ${quotedMessageId}: ${err?.message}. Enviando sem quote.`);
    }
  }

  try {
    const resp = await client.sendMessage(jid, content, options);
    return { id: resp.id.id, serializedId: resp.id._serialized, fromMe: resp.fromMe, to: resp.to, text: resp.body, timestamp: resp.timestamp };
  } catch (err: any) {
    if (err.message?.includes('No LID for user')) {
      log('warn', `[${SESSION_ID}] No LID para ${jid}, tentando numero direto: ${to}@c.us`);
      const resp = await client.sendMessage(`${to.replace(/@.*/, '')}@c.us`, content, options);
      return { id: resp.id.id, serializedId: resp.id._serialized, fromMe: resp.fromMe, to: resp.to, text: resp.body, timestamp: resp.timestamp };
    }
    if (isDeadFrameError(err)) {
      // Mantém a mensagem voltada ao usuário do monólito; isDeadFrame:true faz o
      // dispatcher fatalExit() e o Supervisor respawnar.
      const e: any = new Error('Sessão em recuperação automática');
      e.isDeadFrame = true;
      throw e;
    }
    throw err;
  }
}

async function getMessages(number: string, limit: number = 50) {
  assertConnected();
  const jid = formatJid(number);
  const chat = await client.getChatById(jid);
  const messages = await fetchMessagesSafe(chat, { limit });

  return await Promise.all(messages.map(async (msg) => {
    let mediaUrl = null;
    let mediaMime = null;
    if (msg.hasMedia) {
      const savedMedia = await saveMedia(SESSION_ID, msg);
      if (savedMedia) { mediaUrl = savedMedia.url; mediaMime = savedMedia.type; }
      else { mediaUrl = `${config.baseUrl}/media/error-media.png`; mediaMime = 'image/png'; }
    }
    const contact = await msg.getContact();
    let quotedMsg: any = null;
    if (msg.hasQuotedMsg) {
      try { const quoted = await msg.getQuotedMessage(); if (quoted) quotedMsg = quoted.id._serialized; }
      catch (err) { log('warn', `[${SESSION_ID}] Falha ao obter quoted: ${err}`); }
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
      profilePicUrl: await fetchProfilePicIfNew(client, contact),
    };
  }));
}

async function editMessage(number: string, messageId: string, newText: string) {
  assertConnected();
  const jid = formatJid(number);
  const chat = await client.getChatById(jid);
  const messages = await fetchMessagesSafe(chat, { limit: 100 });
  const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);
  if (!msg) throw new Error('Message not found');
  return await msg.edit(newText);
}

async function deleteMessage(number: string, messageId: string) {
  assertConnected();
  const jid = formatJid(number);
  const chat = await client.getChatById(jid);
  const messages = await fetchMessagesSafe(chat, { limit: 100 });
  const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);
  if (!msg) throw new Error('Message not found');
  return await msg.delete(true);
}

async function forwardMessage(fromNumber: string, messageId: string, toNumber: string) {
  assertConnected();
  const fromJid = formatJid(fromNumber);
  const toJid = formatJid(toNumber);
  const chat = await client.getChatById(fromJid);
  const messages = await fetchMessagesSafe(chat, { limit: 100 });
  const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);
  if (!msg) throw new Error(`Message ${messageId} not found in chat ${fromJid}`);
  await msg.forward(toJid);
}

async function reactToMessage(number: string, messageId: string, emoji: string) {
  assertConnected();
  const jid = formatJid(number);
  const chat = await client.getChatById(jid);
  const messages = await fetchMessagesSafe(chat, { limit: 100 });
  const msg = messages.find(m => m.id.id === messageId || m.id._serialized === messageId);
  if (!msg) throw new Error('Message not found');
  return await msg.react(emoji);
}

async function markAsRead(chatId: string) {
  assertConnected();
  const jid = formatJid(chatId);
  const chat = await client.getChatById(jid);
  await chat.sendSeen();
}

async function checkNumber(number: string) {
  assertConnected();
  const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
  const id = await client.getNumberId(formattedNumber);
  let pushname = null, profilePicUrl = null, jid = null, lid = null;
  if (id) {
    const contact = await client.getContactById(id._serialized);
    pushname = contact.pushname || contact.name || null;
    profilePicUrl = await fetchProfilePic(client, contact);
    jid = contact.id._serialized.includes('@c.us') ? contact.id._serialized : null;
    lid = id._serialized.includes('@lid') ? id._serialized : null;
  }
  return { exists: !!id, jid, lid, number, pushname, profilePicUrl };
}

async function getContacts(opts: { withProfilePic?: boolean } = {}) {
  assertConnected();
  const rawContacts = await client.getContacts();
  const formattedContacts = await Promise.all(rawContacts.map(async (contact) => {
    let jid = contact.id._serialized;
    if (jid.includes('@g.us') || jid.includes('@newsletter') || jid.includes('@broadcast')) return null;
    if (jid.includes('@lid')) {
      try {
        const resolved = await client.getContactById(jid);
        if (resolved && resolved.id._serialized.includes('@c.us')) jid = resolved.id._serialized;
      } catch (err) { log('warn', `[${SESSION_ID}] Falha ao resolver LID ${jid}: ${err}`); }
    }
    const number = jid.includes('@') ? jid.split('@')[0] : jid;
    let profilePicUrl: string | null = null;
    if (opts.withProfilePic) profilePicUrl = await fetchProfilePic(client, contact).catch(() => null);
    return {
      jid, number,
      name: contact.name || '',
      pushname: contact.pushname || '',
      isMyContact: (contact as any).isMyContact ?? false,
      isUser: (contact as any).isUser ?? true,
      profilePicUrl,
    };
  }));
  return Array.from(new Map(
    formattedContacts
      .filter((c): c is NonNullable<typeof formattedContacts[0]> => c !== null)
      .map(c => [c.jid, c]),
  ).values());
}

async function searchContacts(query: string, opts: { withProfilePic?: boolean } = {}) {
  const contacts = await getContacts(opts);
  const q = query.toLowerCase().trim();
  if (!q) return contacts;
  return contacts.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.pushname.toLowerCase().includes(q) ||
    c.number.includes(q));
}

async function getGroups() {
  assertConnected();
  const chats = await client.getChats();
  const groups = chats.filter(chat => chat.isGroup);
  return Promise.all(groups.map(async (group: any) => {
    const profilePicUrl = await fetchProfilePic(client, group);
    return {
      jid: group.id._serialized,
      name: group.name,
      description: group.description ?? null,
      unreadCount: group.unreadCount,
      timestamp: group.timestamp,
      participantCount: group.participants?.length ?? null,
      profilePicUrl,
    };
  }));
}

async function getGroupInfo(groupId: string) {
  assertConnected();
  const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
  const chat = await client.getChatById(jid) as any;
  if (!chat || !chat.isGroup) throw new Error('Group not found');
  const profilePicUrl = await fetchProfilePic(client, chat).catch(() => null);
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

async function getGroupMembers(groupId: string) {
  assertConnected();
  const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
  const chat = await client.getChatById(jid) as any;
  if (!chat || !chat.isGroup) throw new Error('Group not found');
  return Promise.all((chat.participants ?? []).map(async (p: any) => {
    const memberJid: string = p.id._serialized;
    const number = memberJid.includes('@') ? memberJid.split('@')[0] : memberJid;
    const profilePicUrl = await fetchProfilePic(client, memberJid).catch(() => null);
    return { jid: memberJid, number, isAdmin: p.isAdmin ?? false, isSuperAdmin: p.isSuperAdmin ?? false, profilePicUrl };
  }));
}

function getSessionInfo() {
  assertConnected();
  const info = (client as any).info;
  if (!info) throw new Error('Session info not available yet');
  return {
    jid: info.wid?._serialized ?? null,
    number: info.wid?.user ?? null,
    pushname: info.pushname ?? null,
    platform: info.platform ?? null,
  };
}

// ── Tabela de dispatch RPC ────────────────────────────────────────────────────
const handlers: Record<RpcMethod, (...args: any[]) => Promise<any> | any> = {
  sendMessage,
  getMessages,
  editMessage,
  deleteMessage,
  forwardMessage,
  reactToMessage,
  markAsRead,
  checkNumber,
  getContacts,
  searchContacts,
  getGroups,
  getGroupInfo,
  getGroupMembers,
  getSessionInfo,
};

// ──────────────────────────────────────────────────────────────────────────────
// Construção do Client — réplica exata do antigo startSession().
// ──────────────────────────────────────────────────────────────────────────────
function buildInfo(): any {
  const info = (client as any).info;
  if (!info) return null;
  return {
    jid: info.wid?._serialized ?? null,
    number: info.wid?.user ?? null,
    pushname: info.pushname ?? null,
    platform: info.platform ?? null,
  };
}

async function boot(): Promise<void> {
  clearSingletonLocks();

  client = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_ID, dataPath: AUTH_FOLDER }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      protocolTimeout: 600000,
    },
  });

  pushState('STARTING');

  client.on('qr', (qr) => {
    log('info', `[${SESSION_ID}] QR Code gerado.`);
    qrcode.generate(qr, { small: true });
    pushState('QR_READY', { qrCode: qr });
  });

  client.on('authenticated', () => {
    log('info', `[${SESSION_ID}] Autenticado.`);
    connected = true;
    pushState('CONNECTED');
    emitEvent('session.authenticated', { status: 'CONNECTED' });
  });

  client.on('ready', () => {
    log('info', `[${SESSION_ID}] Sessao conectada com sucesso!`);
    connected = true;
    pushState('CONNECTED', { qrCode: null, info: buildInfo() });
    emitEvent('session.connected', { status: 'CONNECTED' });
    attachPuppeteerWatchdog();
    startHealthCheck();
    setTimeout(() => { warmProfilePicCache().catch(() => {}); }, 5000);
  });

  client.on('auth_failure', (msg) => fatalExit(`auth_failure: ${msg}`));
  client.on('disconnected', (reason) => fatalExit(`disconnected: ${reason}`));
  client.on('change_state', (state) => {
    log('info', `[${SESSION_ID}] Estado alterado para: ${state}`);
    if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
      fatalExit(`state_change: ${state}`);
    }
  });

  // ── Mensagens recebidas ──────────────────────────────────────────────────
  client.on('message', async (msg: WWebMessage) => {
    if (isExiting) return;
    if ((msg.body === '' && !msg.hasMedia) || msg.fromMe) return;

    const isGroup = msg.from.includes('@g.us');
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const profilePicUrl = await fetchProfilePicIfNew(client, isGroup ? chat : contact);
    const pushName = contact.pushname || contact.name || '';
    const previewText = getPreviewText(msg);

    const lid = msg.from.includes('@lid') ? msg.from : null;
    let jid = msg.from;
    if (!isGroup && jid.includes('@lid') && contact && contact.id._serialized.includes('@c.us')) {
      jid = contact.id._serialized;
    }

    log('info', `[${SESSION_ID}] Mensagem recebida de lid ${lid} jid ${jid} | tipo: ${msg.type}`);

    let mediaUrl = null, mediaMime = null;
    if (msg.hasMedia) {
      const savedMedia = await saveMedia(SESSION_ID, msg);
      if (savedMedia) { mediaUrl = savedMedia.url; mediaMime = savedMedia.type; }
      else { mediaUrl = `${config.baseUrl}/media/error-media.png`; mediaMime = 'image/png'; }
    }

    let quotedMsg: any = null;
    if (msg.hasQuotedMsg) {
      try { const quoted = await msg.getQuotedMessage(); if (quoted) quotedMsg = quoted.id._serialized; }
      catch (err) { log('warn', `[${SESSION_ID}] Falha ao obter quoted: ${err}`); }
    }

    emitEvent('message.received', {
      id: msg.id.id,
      serializedId: msg.id._serialized,
      fromMe: false,
      jid,
      lid,
      userId: msg.author || msg.from,
      userName: pushName,
      isGroup,
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
    });
  });

  // ── Mensagens enviadas por mim ───────────────────────────────────────────
  client.on('message_create', async (msg: WWebMessage) => {
    if (isExiting) return;
    if (!msg.fromMe) return;
    if (msg.from.includes('newsletter') || msg.from.includes('status@broadcast')) return;

    const previewText = getPreviewText(msg);
    let mediaUrl = null, mediaMime = null;
    if (msg.hasMedia) {
      const savedMedia = await saveMedia(SESSION_ID, msg);
      if (savedMedia) { mediaUrl = savedMedia.url; mediaMime = savedMedia.type; }
      else { mediaUrl = `${config.baseUrl}/media/error-media.png`; mediaMime = 'image/png'; }
    }

    let quotedMsg: any = null;
    if (msg.hasQuotedMsg) {
      try { const quoted = await msg.getQuotedMessage(); if (quoted) quotedMsg = quoted.id._serialized; }
      catch (err) { log('warn', `[${SESSION_ID}] Falha ao obter quoted: ${err}`); }
    }

    const isGroup = msg.to.includes('@g.us');
    const chat = await msg.getChat();
    const contactId = isGroup ? (msg.author || msg.from) : msg.to;
    let contact: any = null;
    try { contact = await client.getContactById(contactId); }
    catch (err) { log('warn', `[${SESSION_ID}] Falha ao obter contato ${contactId}: ${err}`); }
    const profilePicUrl = await fetchProfilePicIfNew(client, isGroup ? chat : (contact || chat));

    const lid = msg.to.includes('@lid') ? msg.to : null;
    let jid = chat.id._serialized;
    if (!isGroup && jid.includes('@lid') && contact && contact.id._serialized.includes('@c.us')) {
      jid = contact.id._serialized;
    }

    log('info', `[${SESSION_ID}] Mensagem ENVIADA para lid ${lid} jid ${jid} | tipo: ${msg.type}`);

    emitEvent('message.received', {
      id: msg.id.id,
      serializedId: msg.id._serialized,
      fromMe: true,
      lid,
      jid,
      userId: msg.author || ((client as any).info ? (client as any).info.wid._serialized : null),
      userName: (contact && (contact.pushname || contact.name)) || '',
      isGroup,
      groupName: isGroup ? chat.name : null,
      text: msg.body || '',
      pushName: (contact && (contact.pushname || contact.name)) || jid.split('@')[0],
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
    });
  });

  client.on('message_edit', async (msg, newBody, _prevBody) => {
    log('info', `[${SESSION_ID}] Mensagem EDITADA (${msg.id.id})`);
    emitEvent('message.edit', { id: msg.id.id, newText: newBody, timestamp: msg.timestamp });
  });

  client.on('message_revoke_everyone', async (msg, revokedMsg) => {
    const id = revokedMsg ? revokedMsg.id.id : msg.id.id;
    log('info', `[${SESSION_ID}] Mensagem EXCLUÍDA (${id})`);
    emitEvent('message.delete', { id });
  });

  client.on('message_reaction', async (reaction) => {
    log('info', `[${SESSION_ID}] REAÇÃO na mensagem ${reaction.msgId}: ${reaction.reaction}`);
    emitEvent('message.reaction', { id: reaction.msgId, reaction: { text: reaction.reaction, senderId: reaction.senderId } });
  });

  client.on('message_ack', async (msg, ack) => {
    log('info', `[${SESSION_ID}] ACK na mensagem ${msg.id.id} | valor: ${ack}`);
    emitEvent('message.ack', { id: msg.id.id, ack });
  });

  client.initialize().catch((err) => fatalExit(`initialize error: ${err?.message}`));
}

// ──────────────────────────────────────────────────────────────────────────────
// Loop de mensagens do Supervisor (pai → filho).
// ──────────────────────────────────────────────────────────────────────────────
process.on('message', async (m: ParentToChild) => {
  try {
    if (m.kind === 'shutdown') return void gracefulShutdown(m.mode);
    if (m.kind === 'ping') {
      // Liveness app-level: confirma que o pupPage responde, não só o event loop.
      if (!connected) return void send({ kind: 'pong', id: m.id });
      const page = (client as any).pupPage;
      if (!page || page.isClosed?.()) return void fatalExit('ping: pupPage closed');
      try {
        await Promise.race([page.evaluate(() => 1), delay(8000).then(() => { throw new Error('ping evaluate timeout'); })]);
        send({ kind: 'pong', id: m.id });
      } catch (err: any) {
        fatalExit(`ping: ${err?.message}`);
      }
      return;
    }
    if (m.kind === 'rpc') {
      const { id, method, args } = m;
      try {
        const fn = handlers[method];
        if (!fn) throw new Error(`Unknown RPC method: ${method}`);
        const result = await fn(...args);
        send({ kind: 'rpc:res', id, ok: true, result });
      } catch (err: any) {
        const dead = isDeadFrameError(err) || err?.isDeadFrame === true;
        send({
          kind: 'rpc:res', id, ok: false,
          error: { message: err?.message ?? String(err), name: err?.name ?? 'Error', code: err?.code, isDeadFrame: dead },
        });
        if (dead) fatalExit(`RPC ${method} dead frame: ${err?.message}`);
      }
    }
  } catch (err: any) {
    log('error', `[${SESSION_ID}] erro no handler de mensagem IPC`, { detail: err?.message });
  }
});

// ── Rede de segurança: nunca deixe um worker meio-morto ───────────────────────
process.on('uncaughtException', (e: any) => {
  log('error', 'uncaughtException', { detail: e?.message, stack: e?.stack });
  fatalExit(`uncaughtException: ${e?.message}`);
});
process.on('unhandledRejection', (e: any) => {
  // whatsapp-web.js emite rejeições transitórias; só dead-frame derruba o worker.
  if (isDeadFrameError(e)) {
    fatalExit(`unhandledRejection (dead frame): ${e?.message ?? e}`);
  } else {
    log('warn', 'unhandledRejection', { detail: e?.message ?? String(e) });
  }
});
process.on('SIGTERM', () => gracefulShutdown('graceful'));

// Handshake + boot.
send({ kind: 'hello', sessionId: SESSION_ID, protocol: IPC_PROTOCOL_VERSION, pid: process.pid });
boot().catch((err) => fatalExit(`boot error: ${err?.message}`));
