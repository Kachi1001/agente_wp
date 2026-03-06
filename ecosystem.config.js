module.exports = {
  apps: [{
    name: 'agente_wp',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' }
  }]
};