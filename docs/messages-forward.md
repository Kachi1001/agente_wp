# POST /api/messages/forward

Encaminha uma mensagem existente de um chat para outro.

## Request

**Content-Type:** `application/json`

| Campo       | Tipo     | Obrigatório | Descrição                                                                                      |
|-------------|----------|-------------|------------------------------------------------------------------------------------------------|
| `sessionId` | `string` | ✅          | ID da sessão WhatsApp conectada                                                                |
| `from`      | `string` | ✅          | Número ou JID do **chat de origem** onde a mensagem está (ex: `"5511999887766"` ou `"5511999887766@c.us"`) |
| `messageId` | `string` | ✅          | ID ou `_serialized` da mensagem a ser encaminhada                                              |
| `to`        | `string` | ✅          | Número ou JID do **chat de destino** para onde encaminhar (ex: `"5511888776655"` ou `"5511888776655@c.us"`) |

### Exemplo de Body

```json
{
  "sessionId": "minha-sessao",
  "from": "5511999887766",
  "messageId": "ABCDEF1234567890",
  "to": "5511888776655"
}
```

> **Nota:** `messageId` pode ser tanto o `id` curto (ex: `"ABCDEF..."`) quanto o `_serialized` completo (ex: `"true_5511999887766@c.us_ABCDEF..."`).

---

## Response

### Sucesso — `200 OK`

```json
{
  "success": true,
  "message": "Message forwarded successfully"
}
```

### Erros

| Status | Motivo                                                          |
|--------|-----------------------------------------------------------------|
| `400`  | Parâmetros obrigatórios ausentes                                |
| `500`  | Sessão desconectada, mensagem não encontrada ou erro interno    |

#### Exemplo de erro 400
```json
{
  "error": "Missing required parameters: sessionId, from, messageId, to"
}
```

#### Exemplo de erro 500 (mensagem não encontrada)
```json
{
  "error": "Failed to forward message",
  "details": "Message ABCDEF1234567890 not found in chat 5511999887766@c.us"
}
```

---

## Como funciona

1. Busca o chat de origem pelo `from` (aceita número com ou sem `@c.us`).
2. Faz fetch das últimas **100 mensagens** desse chat.
3. Localiza a mensagem pelo `messageId` (aceita `id` curto ou `_serialized`).
4. Chama `.forward(toJid)` para encaminhar ao destino.

> O WhatsApp marca a mensagem encaminhada com o ícone de "Encaminhado" automaticamente.

---

## Exemplo com cURL

```bash
curl -X POST http://localhost:3000/api/messages/forward \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "minha-sessao",
    "from": "5511999887766",
    "messageId": "ABCDEF1234567890",
    "to": "5511888776655"
  }'
```

## Exemplo com JavaScript (fetch)

```javascript
const res = await fetch('http://localhost:3000/api/messages/forward', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'minha-sessao',
    from: '5511999887766',
    messageId: 'ABCDEF1234567890',
    to: '5511888776655'
  })
});

const data = await res.json();
console.log(data); // { success: true, message: 'Message forwarded successfully' }
```
