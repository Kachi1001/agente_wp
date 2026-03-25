---
description: Como verificar números e obter dados de contato usando whatsapp-web.js
---

# Verificação de Números e Contatos no `whatsapp-web.js`

Este documento é um guia (Skill/Workflow) para evitar a necessidade de olhar o código-fonte da biblioteca toda vez que precisar lidar com a verificação de existência de números e obtenção de dados de contatos no `whatsapp-web.js`.

## 1. Verificando se um número existe no WhatsApp

A biblioteca fornece dois métodos principais, mas um é melhor que o outro, dependendo do caso:

### ❌ `client.isRegisteredUser(id)`
Este método retorna um `Boolean` (true ou false). Internamente, na linha ~1619 do `Client.js`, ele apenas chama o `getNumberId` e converte o resultado.
**Desvantagem:** Se você precisar do ID do contato após validar e tiver usado `isRegisteredUser`, vai ter que fazer **duas requisições** para a rede do WhatsApp.

### ✅ `client.getNumberId(id)` (Recomendado)
Este método faz a requisição à rede do WhatsApp para checar se o número existe ("QueryExist").
- O parâmetro `id` aceita número puro (`5511999999999`) ou formatado (`5511999999999@c.us`). Ele auto-aplica `@c.us` se faltar.
- Retorna `null` se o usuário NÃO tiver WhatsApp.
- Retorna um objeto `Wid` (com a propriedade `_serialized`) se o usuário tiver WhatsApp.

**Exemplo Prático (A Abordagem Perfeita):**
```typescript
const id = await client.getNumberId(numero);

if (!id) {
    // Número não existe no WhatsApp
    return { exists: false };
}

// O número existe e você tem o ID definitivo e seguro:
const jid = id._serialized; // "5511999999999@c.us"
```

---

## 2. Buscando Nome de Perfil (Pushname) e Foto

Uma vez que você obteve o `id._serialized` do passo anterior, você pode usar os métodos nativos para puxar foto e nome rapidamente.

**Exemplo Completo de Verificação + Enriquecimento:**

```typescript
const id = await client.getNumberId("5511999999999");

if (!id) {
    return { exists: false, message: "Número inválido ou sem WhatsApp" };
}

// 1. Obtendo o objeto do contato
const contact = await client.getContactById(id._serialized);

// 2. Extraindo o Nome (Pushname)
// 'pushname' é o nome que a pessoa definiu no próprio perfil.
// 'name' é o nome salvo na agenda do celular host (se houver).
const pushname = contact.pushname || contact.name || null;

// 3. Extraindo a Foto de Perfil
// Nota: getProfilePicUrl é um método de rede. Se pular a função, pode demorar ou retornar timeout.
// A biblioteca recomenda tratar erros caso a pessoa tenha a foto restrita na privacidade.
let profilePicUrl = null;
try {
    profilePicUrl = await client.getProfilePicUrl(id._serialized);
} catch (error) {
    // Tratamento de falha silenciosa para foto oculta
}

return {
    exists: true,
    jid: id._serialized,
    pushname: pushname,
    profilePicUrl: profilePicUrl
};
```

## Resumo das Melhores Práticas:
- **Use `getNumberId` em vez de `isRegisteredUser`** para evitar requisições duplicadas.
- **Sempre verifique `if (id)`** antes de rodar `getContactById`. `getContactById` em um ID inexistente causará timeout ou crash.
- **Envolva a busca de imagem (`getProfilePicUrl`) em um `try/catch`**. Usuários com privacidade restrita gerarão um erro.
