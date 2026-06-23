/**
 * Metadados OPCIONAIS por rota (enriquecem a documentação).
 *
 * A chave é `MÉTODO /caminho/completo` no formato do Express (com `:param`).
 * Rotas SEM entrada aqui continuam aparecendo na documentação automaticamente
 * (apenas com método + caminho). Ou seja: este arquivo é melhoria progressiva,
 * nunca um requisito para uma rota ser documentada.
 */

export interface RouteQueryParam {
  name: string;
  required?: boolean;
  description?: string;
}

export interface RouteMeta {
  summary?: string;
  description?: string;
  /** Descrição dos parâmetros de caminho (:param). */
  params?: Record<string, string>;
  /** Parâmetros de query string. */
  query?: RouteQueryParam[];
  /** Schema (OpenAPI) do corpo da requisição. */
  body?: Record<string, unknown>;
  bodyContentType?: 'application/json' | 'multipart/form-data';
}

export const routeMetadata: Record<string, RouteMeta> = {
  // ── Sessões ─────────────────────────────────────────────────────────────
  'GET /session': {
    summary: 'Listar sessões',
    description: 'Retorna todas as sessões carregadas e seus status atuais.',
  },
  'POST /session/start/:id': {
    summary: 'Iniciar sessão',
    description: 'Inicia (ou retoma) a conexão de uma sessão. Processo assíncrono (202 Accepted).',
    params: { id: 'Identificador único da sessão.' },
  },
  'GET /session/status/:id': {
    summary: 'Status da sessão',
    description: 'Retorna o status detalhado (CONNECTED, QR_READY, INITIALIZING, etc).',
    params: { id: 'Identificador único da sessão.' },
  },
  'GET /session/qr/:id': {
    summary: 'QR Code (imagem)',
    description: 'Retorna o QR Code da sessão em formato dataURL (base64).',
    params: { id: 'Identificador único da sessão.' },
  },
  'GET /session/info/:id': {
    summary: 'Informações da sessão',
    params: { id: 'Identificador único da sessão.' },
  },
  'POST /session/restart/:id': {
    summary: 'Reiniciar sessão',
    params: { id: 'Identificador único da sessão.' },
  },
  'DELETE /session/stop/:id': {
    summary: 'Parar/deletar sessão',
    description: 'Encerra a conexão e remove os dados de autenticação locais.',
    params: { id: 'Identificador único da sessão.' },
  },

  // ── Mensagens ───────────────────────────────────────────────────────────
  'POST /message/send': {
    summary: 'Enviar mensagem',
    description: 'Envia texto ou mídia. Aceita JSON ou multipart/form-data (para arquivos).',
    bodyContentType: 'multipart/form-data',
    body: {
      type: 'object',
      required: ['sessionId', 'to'],
      properties: {
        sessionId: { type: 'string', description: 'ID da sessão conectada.' },
        to: { type: 'string', example: '5511999999999@c.us', description: 'JID do destinatário.' },
        text: { type: 'string', description: 'Texto da mensagem.' },
        file: { type: 'string', format: 'binary', description: 'Arquivo de mídia (opcional).' },
        mediaType: {
          type: 'string',
          enum: ['image', 'audio', 'video', 'document', 'ptt'],
          description: 'Tipo da mídia (opcional).',
        },
        quotedMessageId: { type: 'string', description: 'ID da mensagem a ser respondida (opcional).' },
      },
    },
  },
  'POST /message/send-location': {
    summary: 'Enviar localização',
    description: 'Envia uma mensagem de localização (pin no mapa) com coordenadas e rótulo opcional.',
    body: {
      type: 'object',
      required: ['sessionId', 'to', 'latitude', 'longitude'],
      properties: {
        sessionId: { type: 'string', description: 'ID da sessão conectada.' },
        to: { type: 'string', example: '5511999999999@c.us', description: 'JID do destinatário.' },
        latitude: { type: 'number', example: -23.55052, description: 'Latitude em graus decimais.' },
        longitude: { type: 'number', example: -46.633308, description: 'Longitude em graus decimais.' },
        name: { type: 'string', description: 'Nome do local (opcional).' },
        address: { type: 'string', description: 'Endereço do local (opcional).' },
        url: { type: 'string', description: 'URL exibida na mensagem de localização (opcional).' },
      },
    },
  },
  'POST /message/edit': {
    summary: 'Editar mensagem',
    body: {
      type: 'object',
      required: ['sessionId', 'to', 'messageId', 'newText'],
      properties: {
        sessionId: { type: 'string' },
        to: { type: 'string' },
        messageId: { type: 'string' },
        newText: { type: 'string' },
      },
    },
  },
  'POST /message/delete': {
    summary: 'Deletar mensagem',
    description: 'Apaga a mensagem para todos.',
    body: {
      type: 'object',
      required: ['sessionId', 'to', 'messageId'],
      properties: {
        sessionId: { type: 'string' },
        to: { type: 'string' },
        messageId: { type: 'string' },
      },
    },
  },
  'POST /message/react': {
    summary: 'Reagir a mensagem',
    body: {
      type: 'object',
      required: ['sessionId', 'to', 'messageId', 'emoji'],
      properties: {
        sessionId: { type: 'string' },
        to: { type: 'string' },
        messageId: { type: 'string' },
        emoji: { type: 'string', example: '👍' },
      },
    },
  },
  'POST /message/forward': {
    summary: 'Encaminhar mensagem',
    body: {
      type: 'object',
      required: ['sessionId', 'from', 'messageId', 'to'],
      properties: {
        sessionId: { type: 'string' },
        from: { type: 'string', description: 'Chat de origem da mensagem.' },
        messageId: { type: 'string' },
        to: { type: 'string', description: 'Destinatário final.' },
      },
    },
  },
  'POST /message/read': {
    summary: 'Marcar como lida',
    body: {
      type: 'object',
      required: ['sessionId', 'to'],
      properties: {
        sessionId: { type: 'string' },
        to: { type: 'string' },
      },
    },
  },
  'GET /message/history': {
    summary: 'Histórico de mensagens',
    query: [
      { name: 'sessionId', required: true, description: 'ID da sessão.' },
      { name: 'number', required: true, description: 'Número/JID do chat.' },
      { name: 'limit', required: false, description: 'Quantidade de mensagens (padrão 200).' },
    ],
  },

  // ── Contatos ────────────────────────────────────────────────────────────
  'GET /contact/:sessionId/list': {
    summary: 'Listar contatos',
    params: { sessionId: 'ID da sessão.' },
    query: [{ name: 'withProfilePic', required: false, description: 'Inclui foto de perfil.' }],
  },
  'GET /contact/:sessionId/search': {
    summary: 'Buscar contatos',
    params: { sessionId: 'ID da sessão.' },
    query: [
      { name: 'q', required: true, description: 'Termo de busca (nome, pushname ou número).' },
      { name: 'withProfilePic', required: false, description: 'Inclui foto de perfil.' },
    ],
  },
  'GET /contact/:sessionId/check/:number': {
    summary: 'Verificar número',
    description: 'Verifica se o número possui conta no WhatsApp e retorna o JID correto.',
    params: { sessionId: 'ID da sessão.', number: 'Número a verificar (ex: 5511999998888).' },
  },

  // ── Grupos ──────────────────────────────────────────────────────────────
  'GET /group/list/:sessionId': {
    summary: 'Listar grupos',
    params: { sessionId: 'ID da sessão.' },
  },
  'GET /group/:sessionId/info/:groupId': {
    summary: 'Informações do grupo',
    params: { sessionId: 'ID da sessão.', groupId: 'ID do grupo.' },
  },
  'GET /group/:sessionId/members/:groupId': {
    summary: 'Participantes do grupo',
    params: { sessionId: 'ID da sessão.', groupId: 'ID do grupo.' },
  },

  // ── Logs ────────────────────────────────────────────────────────────────
  'GET /api/logs': {
    summary: 'Listar logs (admin)',
    description: 'Recuperação de logs para a Central. Exige autorização de admin.',
  },
};

/**
 * Eventos Socket.IO documentados (não introspectáveis automaticamente).
 * Incluídos na spec como extensão `x-socketio` e no hash de versão.
 */
export interface SocketEventDoc {
  name: string;
  payload?: string;
  description: string;
}

export const socketEvents: {
  inbound: SocketEventDoc[];
  outbound: SocketEventDoc[];
} = {
  inbound: [
    { name: 'join_session', payload: '{ sessionId }', description: 'Entra na sala de uma sessão para receber seus eventos.' },
    { name: 'get_status', payload: '{ sessionId }', description: 'Solicita o status atual da sessão.' },
    { name: 'send_message', payload: '{ sessionId, to, text, mediaType? }', description: 'Envia uma mensagem de texto ou mídia.' },
  ],
  outbound: [
    { name: 'current_status', description: 'Status da sessão ao conectar/entrar.' },
    { name: 'events', description: 'Evento genérico que encapsula status, QR e novas mensagens.' },
    { name: 'qr', description: 'Novo QR code gerado.' },
    { name: 'ready', description: 'Sessão conectada e pronta.' },
    { name: 'message', description: 'Nova mensagem recebida.' },
    { name: 'capabilities.updated', payload: '{ hash, version, generatedAt }', description: 'Emitido ao cliente quando a API muda (novo hash de capacidades).' },
  ],
};
