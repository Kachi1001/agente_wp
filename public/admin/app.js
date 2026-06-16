/* Painel /admin — vanilla JS, sem build. Usa REST /session/* + /admin/api/* + Socket.IO. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  // Token entregue pela Central via cookie sso_token (setado pelo backend no
  // retorno do SSO). NÃO há login local — quem autentica é a Central.
  let TOKEN = getCookie('sso_token') || '';
  let USER = null;
  let CONFIG = { authEnabled: false, sso: true, centralUrl: '', appId: '', workerMode: true };
  let logsAuto = true;

  function gotoLogin(errorCode) {
    const here = encodeURIComponent(window.location.href);
    const base = CONFIG.centralUrl || '';
    window.location.href = base + '/login?redirect=' + here +
      '&app_id=' + encodeURIComponent(CONFIG.appId || '') +
      '&error=' + (errorCode || 'no_token');
  }
  function clearToken() { TOKEN = ''; document.cookie = 'sso_token=; Max-Age=0; path=/'; }

  // ── HTTP helpers ────────────────────────────────────────────────────────────
  // O mesmo token SSO autentica /admin/api/* E as ações /session/* (o
  // authMiddleware valida o mesmo Bearer).
  function authHeaders() {
    return TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {};
  }
  async function api(method, url, body) {
    const opts = { method, headers: { ...authHeaders() } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    if (res.status === 401) { clearToken(); gotoLogin('session_expired'); }
    if (res.status === 403) { gotoLogin('forbidden'); }
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = j.error || j.message || detail; } catch {}
      throw new Error(detail + ' (' + res.status + ')');
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function fmtUptime(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  }

  function renderRows(sessions) {
    const tbody = $('rows');
    if (!sessions || sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma sessão. Crie uma acima.</td></tr>';
      return;
    }
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    tbody.innerHTML = sessions.map((s) => {
      const st = s.status || 'NOT_FOUND';
      const info = s.info ? (s.info.number || s.info.pushname || '') : '';
      const qrBtn = st === 'QR_READY'
        ? `<button class="small primary" data-act="qr" data-id="${s.id}">📷 QR</button>` : '';
      const parked = s.parked ? ' <span class="parked">• estacionada</span>' : '';
      return `<tr>
        <td><strong>${esc(s.id)}</strong>${info ? `<div class="muted mono">${esc(info)}</div>` : ''}</td>
        <td><span class="badge b-${st}"><span class="dot"></span>${st}</span>${parked}</td>
        <td class="mono">${s.pid ?? '—'}</td>
        <td class="mono">${fmtUptime(s.uptimeMs)}</td>
        <td class="mono">${s.restarts ?? 0}</td>
        <td class="muted mono" title="${esc(s.lastError || '')}">${esc(trunc(s.lastError, 40))}</td>
        <td><div class="actions">
          ${qrBtn}
          <button class="small" data-act="logs" data-id="${s.id}">📜 Logs</button>
          <button class="small" data-act="restart" data-id="${s.id}">↻ Reiniciar</button>
          <button class="small danger" data-act="stop" data-id="${s.id}">⛔ Parar</button>
        </div></td>
      </tr>`;
    }).join('');
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function trunc(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }

  // ── Data load ───────────────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      const data = await api('GET', '/admin/api/sessions');
      renderRows(data.sessions);
    } catch (e) {
      // 401 já reabre o login (tratado em api()); aqui só erros reais.
      if (!String(e.message).includes('401')) toast('Falha ao listar sessões: ' + e.message, true);
    }
  }

  async function loadConfig() {
    try {
      CONFIG = await api('GET', '/admin/api/config');
      $('modeLabel').textContent = CONFIG.workerMode ? 'modo isolado' : 'modo legado';
    } catch {}
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function createSession() {
    const id = $('newId').value.trim();
    if (!id) return toast('Informe um ID.', true);
    try {
      await api('POST', '/session/start/' + encodeURIComponent(id));
      toast('Sessão "' + id + '" iniciando…');
      $('newId').value = '';
      setTimeout(loadSessions, 600);
    } catch (e) { toast('Erro ao iniciar: ' + e.message, true); }
  }

  async function doAction(act, id) {
    try {
      if (act === 'restart') {
        await api('POST', '/session/restart/' + encodeURIComponent(id));
        toast('Reiniciando "' + id + '"…');
      } else if (act === 'stop') {
        if (!confirm('Parar e APAGAR os dados de auth da sessão "' + id + '"?')) return;
        await api('DELETE', '/session/stop/' + encodeURIComponent(id));
        toast('Sessão "' + id + '" parada.');
      } else if (act === 'qr') {
        openQr(id);
      } else if (act === 'logs') {
        openSessionTerminal(id);
        return;
      }
      setTimeout(loadSessions, 500);
    } catch (e) { toast('Erro: ' + e.message, true); }
  }

  // ── QR modal ────────────────────────────────────────────────────────────────
  let qrPoll = null, qrId = null;
  async function openQr(id) {
    qrId = id;
    $('qrTitle').textContent = 'QR — ' + id;
    $('qrImg').src = '';
    $('qrModal').classList.add('show');
    await pollQr();
    qrPoll = setInterval(pollQr, 2000);
  }
  async function pollQr() {
    if (!qrId) return;
    try {
      const data = await api('GET', '/session/qr/' + encodeURIComponent(qrId));
      if (data && data.qrCode) $('qrImg').src = data.qrCode;
    } catch (e) {
      // 404 = conectou ou QR não disponível → fecha.
      if (String(e.message).includes('404')) { $('qrSub').textContent = 'Sessão conectada ou QR indisponível.'; closeQr(); }
    }
  }
  function closeQr() {
    $('qrModal').classList.remove('show');
    if (qrPoll) clearInterval(qrPoll);
    qrPoll = null; qrId = null;
    loadSessions();
  }

  // ── Terminal por sessão (histórico + ao vivo) ───────────────────────────────
  let termSession = null;
  function logLineHtml(l) {
    const cls = l.level === 'error' ? 'll-error' : l.level === 'warn' ? 'll-warn' : 'll-info';
    const t = (l.ts || '').replace('T', ' ').replace(/\..+/, '');
    const meta = l.detail ? ' — ' + l.detail : (l.reason ? ' — ' + l.reason : '');
    return `<div class="log-line ${cls}">[${esc(t)}] ${esc(l.level)} ${esc(l.event || '')}${esc(meta)}</div>`;
  }
  async function openSessionTerminal(id) {
    termSession = id;
    $('sessTitle').textContent = '📜 Terminal — ' + id;
    $('sessLogs').innerHTML = '<div class="muted">Carregando…</div>';
    $('sessLive').className = 'dot ' + ($('liveDot').className.includes('on') ? 'on' : 'off');
    $('sessModal').classList.add('show');
    await loadSessionTerminal();
  }
  async function loadSessionTerminal() {
    if (!termSession) return;
    try {
      const level = $('sessLevel').value;
      const q = '/admin/api/logs?session=' + encodeURIComponent(termSession) + '&limit=400' + (level ? '&level=' + level : '');
      const data = await api('GET', q);
      const box = $('sessLogs');
      box.innerHTML = (data.logs || []).slice().reverse().map(logLineHtml).join('') || '<div class="muted">Sem logs ainda.</div>';
      box.scrollTop = box.scrollHeight;
    } catch (e) { toast('Falha ao carregar terminal: ' + e.message, true); }
  }
  function appendSessLine(l) {
    if (!termSession || l.sessionId !== termSession) return;
    const lvl = $('sessLevel').value;
    if (lvl && l.level !== lvl) return;
    const box = $('sessLogs');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.insertAdjacentHTML('beforeend', logLineHtml(l));
    if (near) box.scrollTop = box.scrollHeight;
  }
  function closeSessTerminal() {
    $('sessModal').classList.remove('show');
    termSession = null;
  }

  // ── Apps conectados ──────────────────────────────────────────────────────────
  function renderClients(clients) {
    const tbody = $('clients');
    if (!clients || clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">Nenhum app conectado.</td></tr>';
      return;
    }
    tbody.innerHTML = clients.map((c) => {
      const t = (c.connectedAt || '').replace('T', ' ').replace(/\..+/, '');
      return `<tr>
        <td class="mono">${esc(c.socketId)}</td>
        <td><strong>${esc(c.sessionId || '—')}</strong></td>
        <td class="mono muted">${esc(t)}</td>
        <td class="mono muted">${esc(c.address || '—')}</td>
      </tr>`;
    }).join('');
  }
  async function loadClients() {
    try {
      const data = await api('GET', '/admin/api/clients');
      renderClients(data.clients);
    } catch (e) { if (!String(e.message).includes('401')) {} }
  }

  // ── Logs ────────────────────────────────────────────────────────────────────
  async function loadLogs() {
    try {
      const level = $('logLevel').value;
      const q = '/admin/api/logs?limit=200' + (level ? '&level=' + level : '');
      const data = await api('GET', q);
      const box = $('logs');
      box.innerHTML = (data.logs || []).map((l) => {
        const cls = l.level === 'error' ? 'll-error' : l.level === 'warn' ? 'll-warn' : 'll-info';
        const t = (l.ts || '').replace('T', ' ').replace(/\..+/, '');
        const meta = l.detail ? ' — ' + l.detail : '';
        return `<div class="log-line ${cls}">[${esc(t)}] ${esc(l.level)} ${esc(l.event || '')}${esc(meta)}</div>`;
      }).join('');
    } catch (e) {
      if (!String(e.message).includes('401')) toast('Falha ao carregar logs: ' + e.message, true);
    }
  }

  // ── Identidade (SSO) ──────────────────────────────────────────────────────
  function setUserUI() {
    const name = USER ? (USER.name || USER.username || USER.email || 'usuário') : '';
    $('userLabel').textContent = USER ? ('👤 ' + name) : '';
    $('logoutBtn').style.display = TOKEN ? '' : 'none';
  }
  async function loadMe() {
    try {
      const data = await api('GET', '/admin/api/me');
      USER = data.user || null;
      setUserUI();
    } catch { /* 401 já redireciona via api() */ }
  }
  function logout() {
    clearToken();
    if (socketRef) { try { socketRef.disconnect(); } catch {} socketRef = null; }
    gotoLogin('no_token');
  }

  // ── Socket.IO (live) + polling fallback ─────────────────────────────────────
  let socketRef = null;
  function connectSocket() {
    if (typeof io === 'undefined' || !TOKEN) return;
    if (socketRef) { try { socketRef.disconnect(); } catch {} }
    socketRef = io('/', { query: { admin: '1' }, auth: { token: TOKEN } });
    socketRef.on('connect', () => { $('liveDot').className = 'dot on'; $('liveLabel').textContent = 'ao vivo'; });
    socketRef.on('disconnect', () => { $('liveDot').className = 'dot off'; $('liveLabel').textContent = 'offline'; });
    socketRef.on('admin:sessions', (snap) => { if (snap && snap.sessions) renderRows(snap.sessions); });
    socketRef.on('admin:clients', (snap) => { if (snap && snap.clients) renderClients(snap.clients); });
    socketRef.on('admin:log', (line) => appendSessLine(line));
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function bindEvents() {
    $('createBtn').onclick = createSession;
    $('newId').addEventListener('keydown', (e) => { if (e.key === 'Enter') createSession(); });
    $('refreshBtn').onclick = loadSessions;
    $('logoutBtn').onclick = logout;
    $('qrClose').onclick = closeQr;
    $('sessClose').onclick = closeSessTerminal;
    $('sessLevel').onchange = loadSessionTerminal;
    $('clientsRefresh').onclick = loadClients;
    $('logsRefresh').onclick = loadLogs;
    $('logLevel').onchange = loadLogs;
    $('logsAuto').onclick = () => {
      logsAuto = !logsAuto;
      $('logsAuto').textContent = (logsAuto ? '⏸' : '▶') + ' auto';
    };
    $('rows').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) doAction(btn.dataset.act, btn.dataset.id);
    });
  }

  async function init() {
    bindEvents();
    await loadConfig();
    // O shell /admin é protegido no backend: se chegou aqui, normalmente já há
    // cookie sso_token. Sem token (ex.: cookie expirado), volta para o SSO.
    if (!TOKEN) { gotoLogin('no_token'); return; }
    setUserUI();
    loadMe();
    connectSocket();
    loadSessions(); loadClients(); loadLogs();
    // 401 em qualquer poll reabre o login automaticamente (tratado em api()).
    setInterval(() => { if (TOKEN) loadSessions(); }, 4000);
    setInterval(() => { if (TOKEN) loadClients(); }, 6000);
    setInterval(() => { if (TOKEN && logsAuto) loadLogs(); }, 5000);
  }

  init();
})();
