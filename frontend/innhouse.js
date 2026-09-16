/*
 * INN-009 — House-Native Listener & Studio Experience
 * Drop-in browser module for the existing NYCE FM dashboard.
 *
 * Usage:
 *   <script src="/innhouse.js" defer></script>
 *
 * Optional configuration:
 *   window.INNHOUSE_CONFIG = {
 *     apiBase: 'https://nycefm36-9.onrender.com',
 *     defaultHouse: 'nycefm',
 *     mode: 'listener' // or 'studio'
 *   };
 *
 * The module is intentionally additive. It does not replace legacy dashboard
 * endpoints; it introduces a House-native shell that resolves tenancy from
 * the URL/config and never accepts a client-supplied station_id/house_id.
 */
(() => {
  'use strict';

  const CONFIG = Object.assign({
    apiBase: document.querySelector('meta[name="nycefm-api-base"]')?.content || window.location.origin,
    defaultHouse: 'nycefm',
    mode: 'listener',
    mount: 'innhouse-root',
  }, window.INNHOUSE_CONFIG || {});

  const state = {
    houseKey: new URLSearchParams(window.location.search).get('house') || CONFIG.defaultHouse,
    mode: new URLSearchParams(window.location.search).get('mode') || CONFIG.mode,
    house: null,
    listener: null,
    nowPlaying: null,
    chat: [],
    polls: [],
    me: null,
    broadcast: null,
    stream: null,
    anonymousId: localStorage.getItem('innhouse_anonymous_id') || crypto.randomUUID(),
    sse: null,
    timers: [],
  };

  try { localStorage.setItem('innhouse_anonymous_id', state.anonymousId); } catch (_) {}

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

  const api = async (path, options = {}) => {
    const response = await fetch(`${CONFIG.apiBase.replace(/\/$/, '')}${path}`, {
      credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
      ...options,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  };

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const get = (path) => api(path);

  function injectStyles() {
    if (document.getElementById('innhouse-style')) return;
    const style = document.createElement('style');
    style.id = 'innhouse-style';
    style.textContent = `
      #innhouse-root { position:fixed; inset:auto 18px 18px auto; z-index:2147483000; font-family:Inter,ui-sans-serif,system-ui,sans-serif; color:#eaf7f3; }
      #innhouse-root * { box-sizing:border-box; }
      .ih-pill { display:flex; align-items:center; gap:10px; padding:9px 12px; background:#06120fef; border:1px solid #19e0ad38; border-radius:999px; box-shadow:0 12px 40px #0008; }
      .ih-dot { width:8px; height:8px; border-radius:50%; background:#20e39b; box-shadow:0 0 14px #20e39b; }
      .ih-button { appearance:none; border:1px solid #20e39b35; background:#0a1e18; color:#dff9ef; border-radius:10px; padding:8px 11px; cursor:pointer; font:inherit; }
      .ih-button:hover { background:#0c2b22; }
      .ih-panel { width:min(430px,calc(100vw - 30px)); max-height:calc(100vh - 36px); overflow:auto; margin-bottom:10px; background:#04110d; border:1px solid #20e39b30; border-radius:18px; box-shadow:0 24px 80px #000b; }
      .ih-head { padding:18px; border-bottom:1px solid #20e39b18; position:sticky; top:0; background:#04110df7; backdrop-filter:blur(16px); z-index:2; }
      .ih-brand { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#20e39b; }
      .ih-title { margin-top:5px; font-size:21px; font-weight:750; }
      .ih-sub { margin-top:4px; font-size:12px; color:#81a89a; }
      .ih-body { padding:14px; display:grid; gap:12px; }
      .ih-card { border:1px solid #20e39b18; background:#071912; border-radius:14px; padding:14px; }
      .ih-label { font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:#5e8f80; margin-bottom:8px; }
      .ih-now { display:flex; align-items:center; gap:12px; }
      .ih-art { width:54px; height:54px; border-radius:11px; background:linear-gradient(145deg,#14342a,#0b201a); display:grid; place-items:center; color:#20e39b; font-weight:800; }
      .ih-track { font-weight:700; line-height:1.2; }
      .ih-muted { color:#76988e; font-size:11px; }
      .ih-chat { max-height:220px; overflow:auto; display:grid; gap:7px; }
      .ih-msg { padding:8px 9px; border-radius:9px; background:#0a211a; }
      .ih-msg strong { color:#baf9e3; font-size:11px; }
      .ih-msg div { margin-top:2px; font-size:12px; color:#d5e7e1; }
      .ih-form { display:grid; grid-template-columns:1fr auto; gap:8px; margin-top:9px; }
      .ih-input { width:100%; border:1px solid #20e39b24; background:#020b08; color:#eaf7f3; border-radius:10px; padding:10px 11px; outline:none; font:inherit; }
      .ih-input:focus { border-color:#20e39b66; }
      .ih-poll { display:grid; gap:7px; }
      .ih-option { width:100%; text-align:left; border:1px solid #20e39b1d; background:#081b15; color:#d9efe8; border-radius:10px; padding:9px; cursor:pointer; }
      .ih-option:hover { background:#0c281f; }
      .ih-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .ih-stat { border:1px solid #20e39b18; border-radius:11px; padding:11px; background:#071912; }
      .ih-stat b { font-size:20px; }
      .ih-row { display:flex; justify-content:space-between; gap:10px; align-items:center; }
      .ih-error { padding:10px 12px; border-radius:10px; background:#3a1119; color:#ffc6d2; border:1px solid #ff7a9b30; font-size:12px; }
      .ih-success { padding:10px 12px; border-radius:10px; background:#0a2a20; color:#bbf9e2; border:1px solid #20e39b30; font-size:12px; }
      .ih-small { font-size:10px; color:#6e9286; }
      .ih-tabs { display:flex; gap:7px; flex-wrap:wrap; }
      .ih-tab.active { background:#0d3327; border-color:#20e39b55; color:#72f5c2; }
      @media(max-width:700px) { #innhouse-root { inset:auto 10px 10px 10px; } .ih-panel { width:100%; } }
    `;
    document.head.appendChild(style);
  }

  function mount() {
    let root = document.getElementById(CONFIG.mount);
    if (!root) {
      root = document.createElement('div');
      root.id = CONFIG.mount;
      document.body.appendChild(root);
    }
    injectStyles();
    renderShell(root);
  }

  function renderShell(root) {
    root.innerHTML = `
      <div class="ih-pill">
        <span class="ih-dot"></span>
        <strong>${esc(state.house?.name || 'House')}</strong>
        <span class="ih-small">${esc(state.mode)}</span>
        <button class="ih-button" id="ih-open">Open</button>
      </div>
      <div class="ih-panel" id="ih-panel" hidden></div>
    `;
    root.querySelector('#ih-open').addEventListener('click', () => {
      const panel = root.querySelector('#ih-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderPanel(panel);
    });
  }

  function renderPanel(panel, notice = '') {
    panel.innerHTML = state.mode === 'studio' ? studioTemplate(notice) : listenerTemplate(notice);
    bindPanel(panel);
  }

  function listenerTemplate(notice) {
    const creator = state.listener?.house?.creator;
    const np = state.nowPlaying;
    const polls = Array.isArray(state.polls) ? state.polls : [];
    return `
      <div class="ih-head">
        <div class="ih-brand">INNHOUSE · LISTENER</div>
        <div class="ih-title">${esc(state.listener?.house?.name || state.house?.name || state.houseKey)}</div>
        <div class="ih-sub">${esc(creator?.displayName || 'House experience')} · ${esc(state.listener?.house?.timezone || '')}</div>
      </div>
      <div class="ih-body">
        ${notice ? `<div class="${notice.startsWith('ERROR') ? 'ih-error' : 'ih-success'}">${esc(notice.replace(/^ERROR:\s*/, ''))}</div>` : ''}
        <div class="ih-card">
          <div class="ih-label">Now Playing</div>
          <div class="ih-now">
            <div class="ih-art">♪</div>
            <div><div class="ih-track">${esc(np?.title || 'Nothing on air')}</div><div class="ih-muted">${esc(np?.artist || 'NYCE FM')}</div></div>
          </div>
        </div>
        <div class="ih-grid">
          <div class="ih-stat"><div class="ih-label">House</div><b>${esc(state.listener?.house?.slug || state.houseKey)}</b></div>
          <div class="ih-stat"><div class="ih-label">Presence</div><b>LIVE</b></div>
        </div>
        <div class="ih-card">
          <div class="ih-label">Chat</div>
          <div class="ih-chat">${state.chat.length ? state.chat.map((m) => `<div class="ih-msg"><strong>${esc(m.displayName || 'Listener')}</strong><div>${esc(m.body)}</div></div>`).join('') : '<div class="ih-muted">No messages yet.</div>'}</div>
          <form class="ih-form" id="ih-chat-form"><input class="ih-input" name="body" maxlength="500" placeholder="Say something…" required/><button class="ih-button">Send</button></form>
        </div>
        <div class="ih-card">
          <div class="ih-label">Active Polls</div>
          ${polls.length ? polls.map((p) => `<div class="ih-poll"><strong>${esc(p.question)}</strong>${(p.options || []).map((o) => `<button class="ih-option" data-poll="${esc(p.id)}" data-option="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>`).join('<hr style="border:0;border-top:1px solid #20e39b12;margin:12px 0"/>') : '<div class="ih-muted">No active polls.</div>'}
        </div>
        <div class="ih-card">
          <div class="ih-label">House Actions</div>
          <div class="ih-tabs">
            <button class="ih-button" data-action="presence">I'm here</button>
            <button class="ih-button" data-action="reaction" data-reaction="love">♥ Love</button>
            <button class="ih-button" data-action="reaction" data-reaction="fire">🔥 Fire</button>
          </div>
        </div>
      </div>
    `;
  }

  function studioTemplate(notice) {
    const np = state.broadcast?.nowPlaying || state.broadcast?.now_playing || {};
    const user = state.me?.user || state.me || {};
    return `
      <div class="ih-head">
        <div class="ih-brand">INNHOUSE · STUDIO</div>
        <div class="ih-title">${esc(state.house?.name || state.houseKey)}</div>
        <div class="ih-sub">${esc(user.displayName || user.email || 'Authenticated operator')}</div>
      </div>
      <div class="ih-body">
        ${notice ? `<div class="${notice.startsWith('ERROR') ? 'ih-error' : 'ih-success'}">${esc(notice.replace(/^ERROR:\s*/, ''))}</div>` : ''}
        <div class="ih-grid">
          <div class="ih-stat"><div class="ih-label">Station State</div><b>${esc(state.broadcast?.state || state.broadcast?.status || '—')}</b></div>
          <div class="ih-stat"><div class="ih-label">Control Revision</div><b>${esc(np?.control_revision ?? state.broadcast?.controlRevision ?? '—')}</b></div>
        </div>
        <div class="ih-card">
          <div class="ih-label">Now Playing</div>
          <div class="ih-track">${esc(np?.title || 'Nothing on air')}</div>
          <div class="ih-muted">${esc(np?.artist || '')}</div>
        </div>
        <div class="ih-card">
          <div class="ih-label">Broadcast Controls</div>
          <div class="ih-tabs">
            ${['pause','resume','skip','stop','emergency_stop'].map((action) => `<button class="ih-button" data-control="${action}">${action.replace('_',' ')}</button>`).join('')}
          </div>
          <div class="ih-small" style="margin-top:9px">Controls are sent with the latest observed control revision. A conflict triggers a state refresh.</div>
        </div>
        <div class="ih-card">
          <div class="ih-label">AI</div>
          <div class="ih-tabs"><button class="ih-button" data-ai="shoutout">Propose Shoutout</button><button class="ih-button" data-ai="track_intro">Propose Track Intro</button></div>
          <div class="ih-small" style="margin-top:9px">AI proposals do not bypass human approval or broadcast authorization.</div>
        </div>
      </div>
    `;
  }

  async function resolveHouse() {
    try {
      const body = await get(`/api/houses/${encodeURIComponent(state.houseKey)}/listener`);
      state.listener = body;
      state.house = body.house || body;
      state.nowPlaying = body.nowPlaying || null;
      return body;
    } catch (error) {
      state.house = null;
      throw error;
    }
  }

  async function refreshListener() {
    const body = await get(`/api/houses/${encodeURIComponent(state.houseKey)}/listener`);
    state.listener = body;
    state.house = body.house || body;
    state.nowPlaying = body.nowPlaying || null;
    try {
      const [chat, polls] = await Promise.all([
        get(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/chat`),
        get(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/polls`),
      ]);
      state.chat = chat?.messages || [];
      state.polls = polls?.polls || [];
    } catch (_) {}
    const panel = document.getElementById('ih-panel');
    if (panel && !panel.hidden) {
      renderPanel(panel);
    }
  }

  async function sendPresence() {
    await post(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/presence`, { anonymousId: state.anonymousId });
  }

  async function sendReaction(reaction) {
    await post(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/reactions`, { anonymousId: state.anonymousId, reaction });
  }

  async function sendChat(body) {
    await post(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/chat`, { anonymousId: state.anonymousId, displayName: 'Listener', body });
  }

  async function vote(pollId, optionId) {
    await post(`/api/houses/${encodeURIComponent(state.houseKey)}/listener/polls/${encodeURIComponent(pollId)}/vote`, { anonymousId: state.anonymousId, optionId });
  }

  async function loadStudio() {
    state.me = await get('/api/auth/me');
    const stateResponse = await get('/api/broadcast/state');
    state.broadcast = stateResponse;
    const panel = document.getElementById('ih-panel');
    if (panel && !panel.hidden) renderPanel(panel);
  }

  async function broadcastControl(action) {
    const controlRevision = state.broadcast?.nowPlaying?.control_revision ?? state.broadcast?.now_playing?.control_revision ?? state.broadcast?.controlRevision ?? undefined;
    const body = { action };
    if (controlRevision !== undefined && controlRevision !== null) body.expectedControlRevision = controlRevision;
    try {
      state.broadcast = await post('/api/broadcast/control', body);
    } catch (error) {
      if (error.status === 409) {
        state.broadcast = await get('/api/broadcast/state');
        throw new Error('CONTROL REVISION CONFLICT — refreshed station state. Try again.');
      }
      throw error;
    }
  }

  async function aiDecide(actionType) {
    return post('/api/ai/decide', { requestedActionType: actionType, hint: `House-native ${actionType} request` });
  }

  async function bindPanel(panel) {
    const form = panel.querySelector('#ih-chat-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = new FormData(form).get('body')?.toString().trim();
      if (!body) return;
      try { await sendChat(body); await refreshListener(); } catch (error) { renderPanel(panel, `ERROR: ${error.message}`); }
    });

    panel.querySelectorAll('[data-poll]').forEach((button) => {
      button.addEventListener('click', async () => {
        try { await vote(button.dataset.poll, button.dataset.option); renderPanel(panel, 'Vote recorded.'); } catch (error) { renderPanel(panel, `ERROR: ${error.message}`); }
      });
    });

    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          if (button.dataset.action === 'presence') await sendPresence();
          if (button.dataset.action === 'reaction') await sendReaction(button.dataset.reaction);
          renderPanel(panel, 'Action recorded.');
        } catch (error) { renderPanel(panel, `ERROR: ${error.message}`); }
      });
    });

    panel.querySelectorAll('[data-control]').forEach((button) => {
      button.addEventListener('click', async () => {
        try { await broadcastControl(button.dataset.control); renderPanel(panel, `${button.dataset.control} accepted.`); }
        catch (error) { renderPanel(panel, `ERROR: ${error.message}`); }
      });
    });

    panel.querySelectorAll('[data-ai]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const result = await aiDecide(button.dataset.ai);
          renderPanel(panel, `AI proposal created: ${result?.action?.id || result?.id || 'pending approval'}.`);
        } catch (error) { renderPanel(panel, `ERROR: ${error.message}`); }
      });
    });
  }

  function startSse() {
    if (state.sse) state.sse.close();
    const url = `${CONFIG.apiBase.replace(/\/$/, '')}/api/broadcast/control-stream`;
    try {
      state.sse = new EventSource(url, { withCredentials: true });
      state.sse.onmessage = async () => {
        if (state.mode === 'studio') {
          try { state.broadcast = await get('/api/broadcast/state'); const panel = document.getElementById('ih-panel'); if (panel && !panel.hidden) renderPanel(panel); } catch (_) {}
        }
      };
    } catch (_) {}
  }

  function cleanup() {
    state.timers.forEach((timer) => clearInterval(timer));
    state.timers = [];

    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
  }
  async function boot() {
    cleanup();
    mount();
    try {
      await resolveHouse();
      if (state.mode === 'listener') {
        await refreshListener();
        await sendPresence().catch(() => {});
        state.timers.push(setInterval(() => sendPresence().catch(() => {}), 45000));
        state.timers.push(setInterval(() => refreshListener().catch(() => {}), 15000));
      } else {
        await loadStudio();
        startSse();
      }
    } catch (error) {
      const panel = document.getElementById('ih-panel');
      if (panel) { panel.hidden = false; renderPanel(panel, `ERROR: House could not be resolved (${error.message}).`); }
    }
  }

  window.INNHouse = {
    state,
    refresh: () => state.mode === 'listener' ? refreshListener() : loadStudio(),
    setHouse: async (houseKey) => { state.houseKey = houseKey; const url = new URL(window.location.href); url.searchParams.set('house', houseKey); history.replaceState({}, '', url); await boot(); },
    setMode: async (mode) => { state.mode = mode; const url = new URL(window.location.href); url.searchParams.set('mode', mode); history.replaceState({}, '', url); await boot(); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
