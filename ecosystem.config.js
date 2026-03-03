module.exports = {
  apps: [{
    name: 'agente_wp',
    script: 'dist/index.js',
    env: { NODE_ENV: 'production' }
  }]
};