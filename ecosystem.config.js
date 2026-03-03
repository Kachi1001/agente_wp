module.exports = {
  apps: [
    {
      name: "agente_wp",
      script: "node_modules/next/dist/bin/next",
      args: "start", // Comando para iniciar o servidor de produção
      instances: 1, // Usa todos os núcleos da CPU (Modo Cluster)
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3005 // Porta que o Next vai rodar
      }
    }
  ]
} 