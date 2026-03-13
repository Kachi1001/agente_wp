const { execSync } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ================= COLOQUE SEUS DADOS AQUI =================
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || ''; // URL de Automação do Bitrix
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''; // Chave do OpenRouter no .env
const OPENROUTER_MODEL = 'openrouter/free'; // Modelo gratuito do OpenRouter
// ==========================================================

const IA_OPTIONS = {
    temperature: 0.1
}

const IA_PROMPT = {
    system: `Você é um Tech Lead sênior prestativo e analítico.
                REGRA 1: Baseie-se APENAS no código fornecido. Não invente nomes, dados ou features.
                REGRA 2: Explique de forma resumida qual é o objetivo da feature baseado no código.
                REGRA 3: Traga um resumo executivo claro e vá direto ao ponto.
                REGRA 4: Use Emojis! 🚀 Deixe a leitura mais visual e agradável, usando emojis como marcadores de lista ou para destacar pontos chave (ex: ✨ Feature, 🐛 Bugfix, 📝 Doc, ♻️ Refactor, 🔐 Security, ⚡ Performance, 🎨 UI/UX, 🛢️ Database, 🔗 Integration, 🧪 Testing, ✅ adição, ❌ remoção, ⚠️ alteração).`
}

async function enviarParaOpenRouter(prompt) {
    if (!OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY não encontrada no .env");
    }

    const response = await axios.post(OPENROUTER_API_URL, {
        model: OPENROUTER_MODEL,
        messages: [
            { role: "system", content: IA_PROMPT.system },
            { role: "user", content: prompt }
        ],
        ...IA_OPTIONS
    }, {
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://github.com/Kachi1001/agente_wp", // Opcional, para o OpenRouter rankings
            "Content-Type": "application/json"
        }
    });

    return response.data.choices[0].message.content;
}

async function analisarArquivosIndividualmente() {
    try {
        console.log("🤖 Iniciando AI Reviewer com OpenRouter...");

        // Pega apenas arquivos Adicionados (A) ou Modificados (M) no último commit
        const outputArquivos = execSync('git diff --name-only --diff-filter=AM HEAD~1 HEAD').toString().trim();

        if (!outputArquivos) {
            console.log('✅ Nenhum arquivo elegível para análise no último commit.');
            return;
        }

        const arquivosValidos = outputArquivos.split('\n').filter(arquivo => {
            // Filtro Blindado: Ignora binários e arquivos de tráfego pesado
            const ignorados = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.ico', '.pdf', '.zip', '.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
            const ext = path.extname(arquivo).toLowerCase();
            const name = path.basename(arquivo).toLowerCase();
            return !ignorados.includes(ext) && !ignorados.includes(name);
        });

        if (arquivosValidos.length === 0) {
            console.log('✅ Nenhum arquivo de código elegível para análise.');
            return;
        }

        let changelogGlobal = `\n## Atualização - ${new Date().toLocaleString('pt-BR')}\n`;
        let resumoParaBitrix = '';

        for (const arquivo of arquivosValidos) {
            console.log(`\n⏳ Enviando o arquivo ${arquivo} para o OpenRouter analisar...`);
            const diffDoArquivo = execSync(`git diff HEAD~1 HEAD -- "${arquivo}"`).toString();

            if (!diffDoArquivo.trim()) {
                console.log(`⚠️ Diff vazio para ${arquivo}, pulando...`);
                continue;
            }

            const prompt = `Você é um AI Reviewer especialista. Analise as seguintes mudanças feitas exclusivamente no arquivo "${arquivo}" e resuma o que foi feito de forma direta:\n\n${diffDoArquivo}`;
            const respostaIA = await enviarParaOpenRouter(prompt);

            console.log(`--- RESPOSTA DA IA PARA: ${arquivo} ---`);
            console.log(respostaIA);

            changelogGlobal += `\n### 📄 Arquivo: \`${arquivo}\`\n${respostaIA}\n`;
            resumoParaBitrix += `\n**\nArquivo: ${arquivo}**\n${respostaIA}\n`;
        }

        changelogGlobal += `\n---\n`;

        // Salva histórico no repositório local
        fs.appendFileSync(path.join(__dirname, '../AI_CHANGELOG.md'), changelogGlobal);
        console.log("✅ Arquivo AI_CHANGELOG.md atualizado localmente com sucesso!");

        // Disparo para o Bitrix de Tarefas (Ex: [TASK_123])
        const gitLogMsg = execSync('git log -1 --pretty=format:"%s : %b"').toString();
        const matches = gitLogMsg.match(/\[TASK_\d+\]/g) || [];
        const taskIds = [...new Set(matches.map(m => m.replace(/\D/g, '')))];

        for (const id of taskIds) {
            if (!BITRIX_WEBHOOK) continue;
            try {
                await axios.post(`${BITRIX_WEBHOOK}task.commentitem.add`, {
                    taskId: id,
                    fields: { "POST_MESSAGE": `🤖 **Review do Gênio Local:**\n${resumoParaBitrix}` }
                });
                console.log(`✅ Bitrix atualizado na tarefa ${id}!`);
            } catch (err) { }
        }

    } catch (error) {
        console.error('❌ Erro global ao executar a análise:', error.message);
    }
}

analisarArquivosIndividualmente();
