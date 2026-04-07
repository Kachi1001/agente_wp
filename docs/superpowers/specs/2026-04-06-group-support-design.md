# Design Spec: Suporte a Grupos no Agente WP

## Objetivo
Habilitar o envio, recebimento e tratamento de mensagens de grupos do WhatsApp no serviço `agente_wp`, garantindo que o frontend receba as informações necessárias sem quebrar a lógica de interface existente.

## Problemas Atuais
1. Filtros explícitos em `SessionManager.ts` ignoram mensagens de `@g.us`.
2. A estrutura de `payload` de mensagem atual não diferencia entre chats individuais e em grupo.
3. Não há um campo padronizado para identificar o autor de uma mensagem dentro de um grupo.
4. `getContacts` e `checkNumber` são focados apenas em contatos individuais (`@c.us` e `@lid`).

## Proposta de Solução

### 1. Extensão do Payload de Mensagem
Para minimizar impactos no frontend, manteremos a estrutura rica em metadados, adicionando campos específicos de grupo:

```typescript
interface MessagePayload {
  id: string;             // ID único da mensagem
  serializedId: string;   // ID serializado completo
  fromMe: boolean;        // Se foi enviada pela própria sessão
  jid: string;            // ID do Chat (@c.us para privado, @g.us para grupo)
  userId: string;         // ID do Autor (@c.us) - No privado é igual ao jid
  userName: string;       // Nome de exibição do autor
  groupName?: string;     // Nome do grupo (apenas se isGroup for true)
  isGroup: boolean;       // Flag para identificar o tipo de chat
  text: string;           // Conteúdo de texto
  // ... outros campos existentes (mediaUrl, timestamp, quotedMsg, etc.)
}
```

### 2. Mudanças no SessionManager (Backend)
- **Remover Filtros**: Atualizar `client.on('message')` e `client.on('message_create')` para aceitar `@g.us`.
- **Tratamento de Autor**: Para mensagens de grupo, usar `msg.author` ou `msg.from` dependendo do contexto para preencher o `userId`.
- **Metadados de Grupo**: Buscar o nome do grupo e a foto de perfil do grupo se necessário.
- **Novos Endpoints**:
  - `GET /group/list/:sessionId`: Lista os grupos em que o usuário participa.
  - `GET /group/info/:sessionId/:groupId`: Retorna detalhes de um grupo específico.

### 3. Estratégia de Envio para o Frontend
O frontend receberá mensagens via Socket.IO. Se o `jid` terminar em `@g.us`, o frontend saberá que é um grupo.
**Vantagem**: A interface pode agrupar as mensagens pelo `jid` (que é o ID da conversa), mantendo a compatibilidade com o sistema de abas/chats atual.

## Plano de Implementação

### Fase 1: Atualização do Core (Services)
- Habilitar suporte a grupos no listener de mensagens.
- Refatorar `getPreviewText` e `saveMedia` se necessário (já parecem genéricos o suficiente).
- Implementar `getGroups` em `SessionManager`.

### Fase 2: Controladores e Rotas
- Criar `GroupController` e `groupRoutes`.
- Adicionar lógica de envio de mensagem especificamente para grupos (ou unificar com `sendMessage`).

### Fase 3: Validação e Testes
- Testar recebimento de texto e mídia em grupos.
- Testar resposta (reply) a uma mensagem dentro de um grupo.
- Validar se o `jid` do grupo não conflita com `jid` de contatos individuais.

---
**Data**: 2026-04-06
**Autor**: Antigravity AI
