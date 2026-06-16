import { Router } from 'express';
import sessionRoutes from '../routes/sessionRoutes';
import messageRoutes from '../routes/messageRoutes';
import contactRoutes from '../routes/contactRoutes';
import groupRoutes from '../routes/groupRoutes';
import logRoutes from '../routes/logRoutes';
import adminRoutes from '../routes/adminRoutes';

/**
 * Fonte ÚNICA de verdade das rotas montadas na aplicação.
 *
 * O index.ts monta os módulos a partir desta lista e o gerador OpenAPI
 * (src/docs/openapi.ts) introspecta os mesmos routers em runtime.
 * Resultado: adicionar/remover uma rota em qualquer arquivo de `routes/`
 * atualiza a documentação automaticamente — sem edição manual.
 */
export interface ApiModule {
  /** Prefixo de montagem (ex: '/session'). */
  prefix: string;
  /** Router do Express com as rotas do módulo. */
  router: Router;
  /** Nome do grupo exibido na documentação (tag OpenAPI). */
  tag: string;
  /** Descrição curta do módulo. */
  description: string;
  /**
   * Estratégia de autenticação ao montar:
   *  - 'conditional': respeita AUTH_ENABLED (igual às rotas de negócio).
   *  - 'own': o próprio módulo cuida da autorização (ex: /api/logs).
   */
  auth: 'conditional' | 'own';
}

export const apiModules: ApiModule[] = [
  {
    prefix: '/session',
    router: sessionRoutes,
    tag: 'Sessões',
    description: 'Gerencia as conexões de instâncias do WhatsApp.',
    auth: 'conditional',
  },
  {
    prefix: '/message',
    router: messageRoutes,
    tag: 'Mensagens',
    description: 'Envio e manipulação de mensagens.',
    auth: 'conditional',
  },
  {
    prefix: '/contact',
    router: contactRoutes,
    tag: 'Contatos',
    description: 'Listagem, busca e verificação de contatos.',
    auth: 'conditional',
  },
  {
    prefix: '/group',
    router: groupRoutes,
    tag: 'Grupos',
    description: 'Listagem e detalhes de grupos.',
    auth: 'conditional',
  },
  {
    prefix: '/api/logs',
    router: logRoutes,
    tag: 'Logs',
    description: 'Logs administrativos para a Central (autorização própria).',
    auth: 'own',
  },
  {
    prefix: '/admin',
    router: adminRoutes,
    tag: 'Admin',
    description: 'Painel de operações das sessões (autorização própria via ADMIN_TOKEN).',
    auth: 'own',
  },
];

/**
 * Rotas registradas diretamente no app (fora de um Router), incluídas
 * manualmente na documentação por não pertencerem a nenhum módulo.
 */
export interface ExtraRoute {
  method: string;
  path: string;
  tag: string;
  summary: string;
}

export const extraRoutes: ExtraRoute[] = [
  { method: 'get', path: '/health', tag: 'Sistema', summary: 'Health check do serviço.' },
];
