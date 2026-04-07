# Implementation Plan: Suporte a Grupos no Agente WP

Este plano detalha as etapas para habilitar o envio e recebimento de mensagens de grupos no `agente_wp`.

## 1. Modificações no `SessionManager.ts`

### 1.1 Atualizar listeners de mensagem e message_create
Remover os filtros que impedem o processamento de mensagens de JIDs de grupo (`@g.us`).

- **Task**: Modificar `client.on('message', ...)` em `SessionManager.ts` (aprox. linha 385).
- **Task**: Modificar `client.on('message_create', ...)` em `SessionManager.ts` (aprox. linha 463).

### 1.2 Enriquecer Payload de Mensagem
Para mensagens de grupo, o payload deve conter o `jid` do grupo e o `userId` (autor).

- **Task**: Ajustar lógica de extração de `jid` e `author` no processamento de mensagens.
- **Task**: Adicionar campo `isGroup: boolean` e `groupName?: string`.

### 1.3 Novos métodos de gerenciamento de grupos
- **Task**: Implementar `getGroups(sessionId: string)` para retornar a lista de grupos ativos.
- **Task**: Implementar um helper para obter o nome do grupo e foto do grupo de forma cacheada.

## 2. Novos Controladores e Rotas

### 2.1 GroupController
- **Endpoint**: `GET /group/list/:sessionId` - Listar grupos.
- **Endpoint**: `GET /group/info/:sessionId/:groupId` - Obter dados de um grupo específico.

### 2.2 Atualizar MessageController
- Garantir que o `sendMessage` aceite JIDs de grupo sem tentar formatar erroneamente com `@c.us`.

## 3. Webhooks e Notificações (NotifyService)

### 3.1 NotifyService
O `NotifyService` já parece estar enviando payloads genéricos, mas precisamos garantir que ele passe os novos campos `isGroup`, `userId` e `userName`.

---

## Próximos Passos (Workflow)

1. [ ] **Step 1**: Modificar `SessionManager.ts` para capturar mensagens de grupo.
2. [ ] **Step 2**: Atualizar estrutura do payload enviado via Socket/Webhook.
3. [ ] **Step 3**: Criar endpoints para listar grupos.
4. [ ] **Step 4**: Testar envio de mensagens simples para um grupo.
5. [ ] **Step 5**: Testar envio de mídia para um grupo.
