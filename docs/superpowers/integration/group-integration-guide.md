# Manual de Integração: Suporte a Grupos no Frontend

Este guia ensina como adaptar o seu frontend para lidar com as novas mensagens de grupos enviadas pelo `agente_wp`.

## 1. O Novo Modelo de Mensagem

O payload enviado via Socket.IO ou retornado por `/history` agora contém campos específicos que você deve usar para diferenciar mensagens individuais de mensagens de grupo.

### Exemplo de Payload (Mensagem de Grupo):
```json
{
  "id": "ABCD1234EFGH5678",
  "fromMe": false,
  "jid": "12036302345678@g.us",   // ID da Conversa (Grupo)
  "userId": "5511999998888@c.us", // Quem enviou de fato
  "userName": "João Silva",       // Nome de quem enviou
  "isGroup": true,                // Identificador de grupo
  "groupName": "Equipe de Vendas", // Nome do grupo
  "text": "Olá pessoal, como estão?",
  "timestamp": 1712412345,
  "profilePicUrl": "http://.../profile_pics/12036302345678@g_us.jpg"
}
```

## 2. Como Adaptar sua Interface

### Regra de Ouro: Identificador de Chat
Para que o frontend não se perca, use sempre o campo **`jid`** como o ID único do chat na sua lista de conversas.
*   Se `jid` termina em `@c.us`, é um chat privado.
*   Se `jid` termina em `@g.us`, é um chat de grupo.

### Exibição de Nome e Avatar
Na sua lista de chats (sidebar):
*   Se `isGroup` for `true`, o avatar deve ser o do grupo e o nome exibido deve ser o `groupName`.

Dentro da janela de conversa:
*   Se `isGroup` for `true`, exiba o `userName` acima da bolha de cada mensagem recebida (Exceto nas suas próprias mensagens, onde `fromMe` é `true`).

## 3. Buscando a Lista de Grupos

Sempre que a sua aplicação iniciar ou a sessão conectar, chame o novo endpoint para preencher a sua lista de canais/grupos:

`GET /group/list/:sessionId`

**Resposta:**
```json
{
  "success": true,
  "groups": [
    {
      "jid": "12036302345678@g.us",
      "name": "Equipe de Vendas",
      "unreadCount": 0,
      "timestamp": 1712412345,
      "profilePicUrl": "..."
    }
  ]
}
```

## 4. Enviando Mensagens para Grupos

O endpoint de envio de mensagens (`POST /message/send`) e o evento de socket (`send_message`) aceitam o JID do grupo no campo `to` normalmente. O `agente_wp` detecta automaticamente que se trata de um grupo e formata a mensagem corretamente.

Exemplo Socket.IO:
```javascript
socket.emit('send_message', {
  sessionId: 'minha-sessao',
  to: '12036302345678@g.us', // JID do grupo
  text: 'Mensagem enviada via central!'
});
```

## 5. Cuidados Importantes

1.  **Lote de Mensagens**: Grupos podem ter um volume muito maior de mensagens. Certifique-se de que seu componente de lista no React/Next.js usa virtualização ou não trava ao receber muitas notificações seguidas.
2.  **Autor vs Chat**: Nunca use `userId` para identificar a conversa. O `userId` serve apenas para saber "quem falou dentro do grupo". Use sempre o `jid` para saber "onde a mensagem deve aparecer".
