// 유튜브 채널 조회수 모니터 - 프론트엔드 (바닐라 JS)
(function () {
  'use strict';

  const $app = document.getElementById('app');

  const FILTERS = [
    { key: 200000, label: '20만+' },
    { key: 500000, label: '50만+' },
    { key: 1000000, label: '100만+' }
  ];

  const state = {
    tab: 'dashboard',
    booted: false,
    settings: { hasApiKey: false, apiKeyMasked: null },
    channels: [],
    runs: [],
    currentRunId: null,
    currentRun: null,
    currentQueue: null,
    currentVideos: [],
    minViews: 200000,
    runBusy: false,
    importBusy: false,
    importProgress: null, // { total, done, added, duplicated, failed, log: [] }
    channelFilter: ''
  };

  // ---------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString('ko-KR');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return '방금 전';
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const day = Math.floor(hr / 24);
    return `${day}일 전`;
  }

  function viewBadge(views) {
    if (views >= 1000000) return { cls: 'badge-red', text: '🔥 100만+' };
    if (views >= 500000) return { cls: 'badge-yellow', text: '⭐ 50만+' };
    if (views >= 200000) return { cls: 'badge-blue', text: '👍 20만+' };
    return null;
  }

  function showToast(msg, isError) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let json = {};
    try { json = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const msg = json && json.error ? json.error : `요청 실패 (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return json;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------

  async function loadSettings() {
    state.settings = await api('/api/settings');
  }

  async function loadChannels() {
    const r = await api('/api/channels');
    state.channels = r.channels || [];
  }

  async function loadRuns() {
    const r = await api('/api/runs');
    state.runs = r.runs || [];
  }

  async function loadVideosForCurrentRun() {
    if (!state.currentRunId) { state.currentVideos = []; return; }
    const r = await api(`/api/runs/${state.currentRunId}/videos?minViews=${state.minViews}`);
    state.currentVideos = r.videos || [];
  }

  async function selectRun(runId) {
    state.currentRunId = runId;
    const r = await api(`/api/runs/${runId}`);
    state.currentRun = r.run;
    state.currentQueue = r.queue;
    await loadVideosForCurrentRun();
    render();
  }

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  async function saveApiKey() {
    const input = document.getElementById('api-key-input');
    const val = (input && input.value || '').trim();
    if (!val) { showToast('API 키를 입력해주세요.', true); return; }
    const btn = document.getElementById('api-key-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = '확인 중...'; }
    try {
      await api('/api/settings/api-key', { method: 'POST', body: JSON.stringify({ apiKey: val }) });
      await loadSettings();
      showToast('API 키가 저장되었습니다.');
      render();
    } catch (e) {
      showToast(e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = '저장'; }
    }
  }

  async function deleteApiKey() {
    if (!confirm('등록된 API 키를 삭제하시겠습니까?')) return;
    await api('/api/settings/api-key', { method: 'DELETE' });
    await loadSettings();
    showToast('API 키가 삭제되었습니다.');
    render();
  }

  async function runBulkImport() {
    const textarea = document.getElementById('bulk-import-textarea');
    const raw = (textarea && textarea.value) || '';
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) { showToast('등록할 채널 URL/ID를 입력해주세요.', true); return; }
    if (!state.settings.hasApiKey) { showToast('먼저 설정 탭에서 YouTube API 키를 등록해주세요.', true); return; }

    const CHUNK = 15;
    state.importBusy = true;
    state.importProgress = { total: lines.length, done: 0, added: 0, duplicated: 0, failed: 0, log: [] };
    render();

    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      try {
        const r = await api('/api/channels/resolve-batch', { method: 'POST', body: JSON.stringify({ lines: chunk }) });
        for (const item of (r.results || [])) {
          state.importProgress.done++;
          if (item.status === 'added') state.importProgress.added++;
          else if (item.status === 'duplicated') state.importProgress.duplicated++;
          else state.importProgress.failed++;
          state.importProgress.log.unshift(item);
        }
        renderImportProgressOnly();
        if (r.quotaExceeded) {
          showToast('YouTube API 일일 쿼터가 초과되어 등록을 중단했습니다.', true);
          break;
        }
      } catch (e) {
        state.importProgress.failed += chunk.length;
        state.importProgress.done += chunk.length;
        state.importProgress.log.unshift({ raw: chunk.join(', '), status: 'failed', error: e.message });
        renderImportProgressOnly();
      }
      await sleep(150);
    }

    await loadChannels();
    state.importBusy = false;
    showToast(`등록 완료: 추가 ${state.importProgress.added} · 중복 ${state.importProgress.duplicated} · 실패 ${state.importProgress.failed}`);
    render();
  }

  async function deleteChannel(id) {
    if (!confirm('이 채널을 목록에서 삭제하시겠습니까?')) return;
    await api(`/api/channels/${id}`, { method: 'DELETE' });
    await loadChannels();
    render();
  }

  async function toggleChannelActive(id, active) {
    await api(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    await loadChannels();
    render();
  }

  async function deleteRun(id) {
    if (!confirm('이 실행 기록과 결과를 삭제하시겠습니까?')) return;
    await api(`/api/runs/${id}`, { method: 'DELETE' });
    if (state.currentRunId === id) {
      state.currentRunId = null;
      state.currentRun = null;
      state.currentVideos = [];
    }
    await loadRuns();
    render();
  }

  async function startRun() {
    if (!state.settings.hasApiKey) { showToast('먼저 설정 탭에서 YouTube API 키를 등록해주세요.', true); return; }
    const activeCount = state.channels.filter((c) => c.active).length;
    if (activeCount === 0) { showToast('활성화된 채널이 없습니다. 채널 관리 탭에서 채널을 등록해주세요.', true); return; }

    try {
      const r = await api('/api/runs', { method: 'POST' });
      state.currentRunId = r.run.id;
      state.currentRun = r.run;
      state.runBusy = true;
      render();
      await stepRunLoop(r.run.id);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function stepRunLoop(runId) {
    state.runBusy = true;
    try {
      while (true) {
        const r = await api(`/api/runs/${runId}/step`, { method: 'POST' });
        state.currentRun = r.run;
        state.currentQueue = r.queue;
        render();
        if (r.quotaExceeded) {
          showToast('YouTube API 일일 쿼터가 초과되어 체크가 중단되었습니다. 지금까지 수집된 결과는 유지됩니다.', true);
        }
        if (r.done) break;
        await sleep(120);
      }
    } catch (e) {
      showToast(e.message, true);
    }
    state.runBusy = false;
    await loadRuns();
    await loadVideosForCurrentRun();
    render();
  }

  async function resumeIfRunning() {
    const running = state.runs.find((r) => r.status === 'running');
    if (running) {
      state.currentRunId = running.id;
      state.currentRun = running;
      render();
      await stepRunLoop(running.id);
    }
  }

  function setFilter(minViews) {
    state.minViews = minViews;
    loadVideosForCurrentRun().then(render);
  }

  function setTab(tab) {
    state.tab = tab;
    render();
  }

  // ---------------------------------------------------------------------
  // Render: pieces
  // ---------------------------------------------------------------------

  function renderHeader() {
    return `
      <div class="header">
        <h1><span class="dot"></span> 유튜브 조회수 모니터</h1>
        <div class="tabs">
          <button class="tab-btn ${state.tab === 'dashboard' ? 'active' : ''}" data-action="tab" data-tab="dashboard">대시보드</button>
          <button class="tab-btn ${state.tab === 'channels' ? 'active' : ''}" data-action="tab" data-tab="channels">채널 관리 (${state.channels.length})</button>
          <button class="tab-btn ${state.tab === 'settings' ? 'active' : ''}" data-action="tab" data-tab="settings">설정</button>
        </div>
      </div>
    `;
  }

  function renderApiKeyWarning() {
    if (state.settings.hasApiKey) return '';
    return `
      <div class="panel" style="border-color:#5a3232;">
        <div class="row" style="justify-content:space-between;">
          <div>⚠️ <b>YouTube API 키가 등록되지 않았습니다.</b> <span class="muted">설정 탭에서 먼저 등록해주세요.</span></div>
          <button class="btn-primary" data-action="tab" data-tab="settings">설정으로 이동</button>
        </div>
      </div>
    `;
  }

  function renderRunPanel() {
    const activeCount = state.channels.filter((c) => c.active).length;
    const run = state.currentRun;
    const isRunningState = run && run.status === 'running';
    const queue = state.currentQueue;

    let progressHtml = '';
    if (isRunningState || state.runBusy) {
      const total = run ? run.total_channels : 0;
      const done = queue ? (queue.done + queue.failed) : (run ? run.channels_checked + run.channels_failed : 0);
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      progressHtml = `
        <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
        <div class="row" style="justify-content:space-between;">
          <span class="muted">채널 확인 중: ${fmtNum(done)} / ${fmtNum(total)}</span>
          <span class="muted">발견된 영상: ${fmtNum(run ? run.videos_found : 0)}개</span>
        </div>
      `;
    } else if (run) {
      progressHtml = `
        <div class="stat-cards">
          <div class="stat-card"><div class="num">${fmtNum(run.total_channels)}</div><div class="label">확인 채널</div></div>
          <div class="stat-card"><div class="num">${fmtNum(run.videos_found)}</div><div class="label">발견 영상</div></div>
          <div class="stat-card"><div class="num">${fmtNum(run.channels_failed)}</div><div class="label">실패</div></div>
          <div class="stat-card"><div class="num">${fmtNum(run.api_calls_used)}</div><div class="label">API 호출</div></div>
        </div>
      `;
    }

    const disabled = state.runBusy || activeCount === 0 || !state.settings.hasApiKey;

    return `
      <div class="panel">
        <h2>오늘의 체크</h2>
        <p class="muted">등록된 활성 채널 ${fmtNum(activeCount)}개를 기준으로, 최근 24시간 내 업로드된 영상을 확인합니다.</p>
        <div class="row">
          <button class="btn-primary" data-action="start-run" ${disabled ? 'disabled' : ''}>
            ${state.runBusy ? '체크 진행 중...' : '오늘 체크 시작'}
          </button>
          ${!state.settings.hasApiKey ? '<span class="muted">※ API 키를 먼저 등록해주세요.</span>' : ''}
          ${state.settings.hasApiKey && activeCount === 0 ? '<span class="muted">※ 활성화된 채널이 없습니다.</span>' : ''}
        </div>
        ${progressHtml}
      </div>
    `;
  }

  function renderHistoryPanel() {
    if (state.runs.length === 0) {
      return `
        <div class="panel">
          <h2>히스토리</h2>
          <div class="empty-state"><div class="big">🗒️</div>아직 실행 기록이 없습니다.</div>
        </div>
      `;
    }
    const rows = state.runs.map((r) => {
      const statusBadge = r.status === 'running'
        ? '<span class="badge badge-yellow">진행중</span>'
        : r.status === 'failed'
          ? '<span class="badge badge-red">중단됨</span>'
          : '<span class="badge badge-green">완료</span>';
      const selected = state.currentRunId === r.id ? 'style="border-color:var(--accent)"' : '';
      return `
        <div class="run-row" ${selected} data-action="select-run" data-id="${r.id}">
          <div class="date">${esc(r.run_date)} ${statusBadge}</div>
          <div class="stats">채널 ${fmtNum(r.total_channels)} · 영상 ${fmtNum(r.videos_found)} · 실패 ${fmtNum(r.channels_failed)}</div>
          <button class="btn-danger" data-action="delete-run" data-id="${r.id}">삭제</button>
        </div>
      `;
    }).join('');
    return `
      <div class="panel">
        <h2>히스토리</h2>
        <div class="runs-list">${rows}</div>
      </div>
    `;
  }

  function renderResultsPanel() {
    if (!state.currentRunId) {
      return `
        <div class="panel">
          <h2>결과</h2>
          <div class="empty-state"><div class="big">📺</div>체크를 실행하거나 히스토리에서 날짜를 선택해주세요.</div>
        </div>
      `;
    }

    const filterChips = FILTERS.map((f) => `
      <button class="filter-chip ${state.minViews === f.key ? 'active' : ''}" data-action="set-filter" data-views="${f.key}">
        ${f.label}
      </button>
    `).join('');

    let gridHtml;
    if (state.currentVideos.length === 0) {
      gridHtml = `<div class="empty-state"><div class="big">🔍</div>선택한 조회수 기준을 만족하는 영상이 없습니다.</div>`;
    } else {
      const cards = state.currentVideos.map((v) => {
        const badge = viewBadge(v.view_count);
        return `
          <a class="video-card" href="${esc(v.video_url)}" target="_blank" rel="noopener">
            <div class="video-thumb">
              <img src="${esc(v.thumbnail)}" alt="" loading="lazy" />
              ${v.duration ? `<span class="duration">${esc(v.duration)}</span>` : ''}
              ${badge ? `<span class="view-badge ${badge.cls === 'badge-red' ? '' : ''}">${badge.text}</span>` : ''}
            </div>
            <div class="video-info">
              <div class="video-title">${esc(v.title)}</div>
              <div class="video-channel">
                ${v.channel_thumbnail ? `<img src="${esc(v.channel_thumbnail)}" alt="" />` : ''}
                <span>${esc(v.channel_title)}</span>
              </div>
              <div class="video-meta">
                <span class="views">👁 ${fmtNum(v.view_count)}회</span>
                <span>${timeAgo(v.published_at)}</span>
              </div>
            </div>
          </a>
        `;
      }).join('');
      gridHtml = `<div class="video-grid">${cards}</div>`;
    }

    return `
      <div class="panel">
        <h2>결과 <span class="muted" style="font-weight:400;">(${state.currentRun ? esc(state.currentRun.run_date) : ''})</span></h2>
        <div class="filter-bar">${filterChips}</div>
        <div class="muted" style="margin-bottom:10px;">조건을 만족하는 영상: ${fmtNum(state.currentVideos.length)}개</div>
        ${gridHtml}
      </div>
    `;
  }

  function renderDashboard() {
    return `
      ${renderApiKeyWarning()}
      ${renderRunPanel()}
      ${renderHistoryPanel()}
      ${renderResultsPanel()}
    `;
  }

  function renderImportProgress() {
    if (!state.importProgress) return '';
    const p = state.importProgress;
    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    const logRows = p.log.slice(0, 40).map((item) => {
      const badge = item.status === 'added'
        ? '<span class="badge badge-green">추가됨</span>'
        : item.status === 'duplicated'
          ? '<span class="badge badge-gray">중복</span>'
          : '<span class="badge badge-red">실패</span>';
      return `
        <div class="import-result-row">
          ${badge}
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(item.title || item.raw)}</span>
          ${item.error ? `<span class="muted">${esc(item.error)}</span>` : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="row" style="justify-content:space-between;">
        <span class="muted">${fmtNum(p.done)} / ${fmtNum(p.total)} 처리됨</span>
        <span class="muted">추가 ${p.added} · 중복 ${p.duplicated} · 실패 ${p.failed}</span>
      </div>
      <div class="import-result-list">${logRows}</div>
    `;
  }

  function renderChannels() {
    const filtered = state.channelFilter
      ? state.channels.filter((c) => (c.title || '').toLowerCase().includes(state.channelFilter.toLowerCase()) || (c.handle || '').toLowerCase().includes(state.channelFilter.toLowerCase()))
      : state.channels;

    const channelRows = filtered.map((c) => `
      <div class="channel-row">
        <img src="${esc(c.thumbnail || '')}" alt="" />
        <div class="name">${esc(c.title || c.channel_id)} <span class="sub">${esc(c.handle || '')}</span></div>
        <label class="muted" style="display:flex; align-items:center; gap:4px; font-size:12px;">
          <input type="checkbox" data-action="toggle-active" data-id="${c.id}" ${c.active ? 'checked' : ''} />
          활성
        </label>
        <button class="btn-danger" data-action="delete-channel" data-id="${c.id}">삭제</button>
      </div>
    `).join('');

    return `
      ${renderApiKeyWarning()}
      <div class="panel">
        <h2>채널 대량 등록</h2>
        <p class="muted">유튜브 채널 URL, @핸들, 채널ID를 한 줄에 하나씩 붙여넣으세요. (최대 약 200개 권장)</p>
        <textarea id="bulk-import-textarea" placeholder="https://www.youtube.com/@somechannel&#10;https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx&#10;@another_handle" ${state.importBusy ? 'disabled' : ''}></textarea>
        <div class="row" style="margin-top:10px;">
          <button class="btn-primary" data-action="bulk-import" ${state.importBusy ? 'disabled' : ''}>
            ${state.importBusy ? '등록 중...' : '일괄 등록'}
          </button>
        </div>
        ${renderImportProgress()}
      </div>

      <div class="panel">
        <div class="row" style="justify-content:space-between;">
          <h2 style="margin:0;">등록된 채널 (${state.channels.length}개)</h2>
          <input type="text" id="channel-filter-input" placeholder="채널명 검색..." value="${esc(state.channelFilter)}" style="min-width:200px;" />
        </div>
        <div class="channel-list">
          ${channelRows || '<div class="empty-state"><div class="big">📭</div>등록된 채널이 없습니다.</div>'}
        </div>
      </div>
    `;
  }

  function renderSettings() {
    return `
      <div class="panel">
        <h2>YouTube Data API v3 키</h2>
        ${state.settings.hasApiKey ? `
          <div class="api-key-status">
            <span class="badge badge-green">등록됨</span>
            <span class="muted">${esc(state.settings.apiKeyMasked)}</span>
            <button class="btn-danger" data-action="delete-api-key">삭제</button>
          </div>
          <p class="muted" style="margin-top:12px;">키를 교체하려면 아래에 새 키를 입력 후 저장하세요.</p>
        ` : `
          <div class="api-key-status">
            <span class="badge badge-red">미등록</span>
            <span class="muted">API 키를 등록해야 채널 등록 및 체크 기능을 사용할 수 있습니다.</span>
          </div>
        `}
        <div class="row" style="margin-top:14px;">
          <input type="password" id="api-key-input" placeholder="AIzaSy..." style="min-width:320px;" />
          <button class="btn-primary" id="api-key-save-btn" data-action="save-api-key">저장</button>
        </div>
        <p class="muted" style="margin-top:16px; line-height:1.6;">
          Google Cloud Console → API 및 서비스 → 라이브러리에서 <b>YouTube Data API v3</b>를 활성화한 뒤,<br/>
          사용자 인증 정보에서 API 키를 발급받아 붙여넣으세요. 키는 서버(D1)에 안전하게 저장되며 화면에는 마스킹되어 표시됩니다.
        </p>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Render root
  // ---------------------------------------------------------------------

  function render() {
    let body;
    if (state.tab === 'channels') body = renderChannels();
    else if (state.tab === 'settings') body = renderSettings();
    else body = renderDashboard();

    $app.innerHTML = renderHeader() + body;
  }

  function renderImportProgressOnly() {
    // 임포트 중 매 청크마다 전체 재렌더 (텍스트에어리어는 disabled 상태이므로 포커스 문제 없음)
    render();
  }

  // ---------------------------------------------------------------------
  // Event delegation
  // ---------------------------------------------------------------------

  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');

    if (action === 'tab') { setTab(el.getAttribute('data-tab')); return; }
    if (action === 'save-api-key') { saveApiKey(); return; }
    if (action === 'delete-api-key') { deleteApiKey(); return; }
    if (action === 'bulk-import') { runBulkImport(); return; }
    if (action === 'delete-channel') { deleteChannel(Number(el.getAttribute('data-id'))); return; }
    if (action === 'start-run') { startRun(); return; }
    if (action === 'set-filter') { setFilter(Number(el.getAttribute('data-views'))); return; }
    if (action === 'select-run') {
      e.stopPropagation();
      selectRun(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'delete-run') {
      e.stopPropagation();
      deleteRun(Number(el.getAttribute('data-id')));
      return;
    }
  });

  $app.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (action === 'toggle-active') {
      toggleChannelActive(Number(el.getAttribute('data-id')), el.checked);
    }
  });

  $app.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'channel-filter-input') {
      state.channelFilter = e.target.value;
      // 채널 목록만 다시 그리되, 포커스 유지를 위해 목록 부분만 갱신
      const listEl = $app.querySelector('.channel-list');
      if (listEl) {
        const filtered = state.channelFilter
          ? state.channels.filter((c) => (c.title || '').toLowerCase().includes(state.channelFilter.toLowerCase()) || (c.handle || '').toLowerCase().includes(state.channelFilter.toLowerCase()))
          : state.channels;
        const channelRows = filtered.map((c) => `
          <div class="channel-row">
            <img src="${esc(c.thumbnail || '')}" alt="" />
            <div class="name">${esc(c.title || c.channel_id)} <span class="sub">${esc(c.handle || '')}</span></div>
            <label class="muted" style="display:flex; align-items:center; gap:4px; font-size:12px;">
              <input type="checkbox" data-action="toggle-active" data-id="${c.id}" ${c.active ? 'checked' : ''} />
              활성
            </label>
            <button class="btn-danger" data-action="delete-channel" data-id="${c.id}">삭제</button>
          </div>
        `).join('');
        listEl.innerHTML = channelRows || '<div class="empty-state"><div class="big">📭</div>검색 결과가 없습니다.</div>';
      }
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  async function boot() {
    try {
      await Promise.all([loadSettings(), loadChannels(), loadRuns()]);
      if (!state.settings.hasApiKey) state.tab = 'settings';
      if (state.runs.length > 0) {
        const latest = state.runs[0];
        if (latest.status !== 'running') {
          await selectRun(latest.id);
        }
      }
      render();
      await resumeIfRunning();
    } catch (e) {
      $app.innerHTML = `<div class="empty-state"><div class="big">⚠️</div>초기 로딩 중 오류가 발생했습니다: ${esc(e.message)}</div>`;
    }
  }

  boot();
})();
