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
    folders: [], // { id, parent_id, name, sort_order }
    runs: [],
    currentRunId: null,
    currentRun: null,
    currentQueue: null,
    currentVideos: [],
    minViews: 200000,
    runBusy: false,
    importBusy: false,
    importProgress: null, // { total, done, added, duplicated, failed, log: [] }
    channelFilter: '',
    channelFolderFilter: 'all', // 'all' | 'unassigned' | <folderId>
    expandedFolders: new Set(),
    addingChildTo: null, // 인라인 하위폴더 추가 입력을 표시할 부모 폴더 id
    selectedChannelIds: new Set(),
    runFolderIds: [], // 오늘의 체크 범위로 선택된 폴더 id 목록 (비어있으면 전체)
    importFolderId: null // 대량 등록 시 채널을 넣을 폴더 (드롭다운 선택값 유지용)
  };

  // ---------------------------------------------------------------------
  // Folder tree helpers (client-side)
  // ---------------------------------------------------------------------

  function folderById(id) {
    return state.folders.find((f) => f.id === id) || null;
  }

  function folderChildren(parentId) {
    return state.folders
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  }

  // 해당 폴더 + 모든 하위 폴더 id (클라이언트 사이드, 필터링용)
  function getSubtreeIdsClient(folderId) {
    const result = [folderId];
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop();
      for (const f of state.folders) {
        if (f.parent_id === cur) { result.push(f.id); stack.push(f.id); }
      }
    }
    return result;
  }

  function folderPath(folderId) {
    const parts = [];
    let cur = folderById(folderId);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? folderById(cur.parent_id) : null;
    }
    return parts.join(' > ');
  }

  function channelCountInFolder(folderId) {
    const ids = new Set(getSubtreeIdsClient(folderId));
    return state.channels.filter((c) => c.folder_id != null && ids.has(c.folder_id)).length;
  }

  // 채널 관리 탭에서 폴더 선택 <select> 옵션 (들여쓰기로 depth 표현)
  function buildFolderOptions(selectedId, opts) {
    opts = opts || {};
    const lines = [];
    if (!opts.noUnassigned) {
      lines.push(`<option value="" ${selectedId == null ? 'selected' : ''}>미분류</option>`);
    }
    function walk(parentId, depth) {
      for (const f of folderChildren(parentId)) {
        const prefix = '　'.repeat(depth) + (depth > 0 ? '└ ' : '');
        lines.push(`<option value="${f.id}" ${selectedId === f.id ? 'selected' : ''}>${prefix}${esc(f.name)}</option>`);
        walk(f.id, depth + 1);
      }
    }
    walk(null, 0);
    return lines.join('');
  }

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

  async function loadFolders() {
    const r = await api('/api/folders');
    state.folders = r.folders || [];
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

    const folderSelect = document.getElementById('bulk-import-folder-select');
    const folderId = folderSelect && folderSelect.value ? Number(folderSelect.value) : null;
    state.importFolderId = folderId;

    const CHUNK = 15;
    state.importBusy = true;
    state.importProgress = { total: lines.length, done: 0, added: 0, duplicated: 0, failed: 0, log: [] };
    render();

    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      try {
        const r = await api('/api/channels/resolve-batch', { method: 'POST', body: JSON.stringify({ lines: chunk, folderId }) });
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
    state.selectedChannelIds.delete(id);
    await loadChannels();
    render();
  }

  async function toggleChannelActive(id, active) {
    await api(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    await loadChannels();
    render();
  }

  async function moveChannelToFolder(id, folderId) {
    await api(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ folderId }) });
    await loadChannels();
    render();
  }

  async function moveSelectedChannelsToFolder(folderId) {
    const ids = Array.from(state.selectedChannelIds);
    if (ids.length === 0) { showToast('이동할 채널을 먼저 선택해주세요.', true); return; }
    await api('/api/channels/move', { method: 'POST', body: JSON.stringify({ ids, folderId }) });
    state.selectedChannelIds = new Set();
    await loadChannels();
    showToast(`${ids.length}개 채널을 ${folderId ? folderPath(folderId) : '미분류'}(으)로 이동했습니다.`);
    render();
  }

  async function bulkDeleteSelectedChannels() {
    const ids = Array.from(state.selectedChannelIds);
    if (ids.length === 0) { showToast('삭제할 채널을 먼저 선택해주세요.', true); return; }
    if (!confirm(`선택한 ${ids.length}개 채널을 삭제하시겠습니까?`)) return;
    for (const id of ids) {
      await api(`/api/channels/${id}`, { method: 'DELETE' });
    }
    state.selectedChannelIds = new Set();
    await loadChannels();
    showToast(`${ids.length}개 채널을 삭제했습니다.`);
    render();
  }

  function toggleChannelSelected(id) {
    if (state.selectedChannelIds.has(id)) state.selectedChannelIds.delete(id);
    else state.selectedChannelIds.add(id);
    render();
  }

  // 현재 폴더/검색 필터에 걸린 채널 전체를 선택/해제 (전체선택 체크박스)
  function toggleSelectAllFiltered() {
    const filtered = getFilteredChannels();
    const allSelected = filtered.length > 0 && filtered.every((c) => state.selectedChannelIds.has(c.id));
    if (allSelected) {
      filtered.forEach((c) => state.selectedChannelIds.delete(c.id));
    } else {
      filtered.forEach((c) => state.selectedChannelIds.add(c.id));
    }
    render();
  }

  // ---- 폴더(카테고리) 관리 ----

  async function createRootFolder() {
    const input = document.getElementById('new-folder-input');
    const name = (input && input.value || '').trim();
    if (!name) { showToast('폴더 이름을 입력해주세요.', true); return; }
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
    await loadFolders();
    if (input) input.value = '';
    render();
  }

  function showAddChildInput(parentId) {
    state.addingChildTo = parentId;
    state.expandedFolders.add(parentId);
    render();
    setTimeout(() => {
      const el = document.getElementById('new-child-folder-input');
      if (el) el.focus();
    }, 0);
  }

  async function createChildFolder(parentId) {
    const input = document.getElementById('new-child-folder-input');
    const name = (input && input.value || '').trim();
    if (!name) { showToast('폴더 이름을 입력해주세요.', true); return; }
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) });
    state.addingChildTo = null;
    await loadFolders();
    render();
  }

  async function renameFolderPrompt(id) {
    const f = folderById(id);
    const name = prompt('새 폴더 이름을 입력하세요.', f ? f.name : '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { showToast('폴더 이름을 입력해주세요.', true); return; }
    await api(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
    await loadFolders();
    render();
  }

  async function deleteFolderConfirm(id) {
    const f = folderById(id);
    const label = f ? folderPath(id) : '이 폴더';
    if (!confirm(`'${label}' 폴더(하위 폴더 포함)를 삭제하시겠습니까?\n안에 있던 채널은 삭제되지 않고 '미분류'로 이동됩니다.`)) return;
    await api(`/api/folders/${id}`, { method: 'DELETE' });
    if (state.channelFolderFilter === id || (typeof state.channelFolderFilter === 'number' && getSubtreeIdsClient(id).includes(state.channelFolderFilter))) {
      state.channelFolderFilter = 'all';
    }
    state.runFolderIds = state.runFolderIds.filter((fid) => fid !== id);
    await Promise.all([loadFolders(), loadChannels()]);
    render();
  }

  async function moveFolderToParent(id, newParentId) {
    try {
      await api(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ parentId: newParentId }) });
      await loadFolders();
      render();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function toggleFolderExpanded(id) {
    if (state.expandedFolders.has(id)) state.expandedFolders.delete(id);
    else state.expandedFolders.add(id);
    render();
  }

  function selectChannelFolderFilter(key) {
    state.channelFolderFilter = key;
    state.selectedChannelIds = new Set();
    render();
  }

  function toggleRunFolder(folderId) {
    const idx = state.runFolderIds.indexOf(folderId);
    if (idx >= 0) state.runFolderIds.splice(idx, 1);
    else state.runFolderIds.push(folderId);
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

    const folderIds = state.runFolderIds.slice();
    let activeCount;
    let scopeLabel = null;
    if (folderIds.length > 0) {
      const subtreeIds = new Set();
      folderIds.forEach((fid) => getSubtreeIdsClient(fid).forEach((id) => subtreeIds.add(id)));
      activeCount = state.channels.filter((c) => c.active && c.folder_id != null && subtreeIds.has(c.folder_id)).length;
      scopeLabel = folderIds.map((fid) => folderPath(fid)).join(', ');
    } else {
      activeCount = state.channels.filter((c) => c.active).length;
    }
    if (activeCount === 0) { showToast('선택한 범위에 활성화된 채널이 없습니다.', true); return; }

    try {
      const r = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ folderIds, scopeLabel })
      });
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

  // 대시보드에서 오늘 체크할 범위(폴더)를 고르는 버튼들
  function renderRunFolderScopeBar() {
    if (state.folders.length === 0) return '';
    const allActive = state.runFolderIds.length === 0;
    const chips = [`<button class="folder-chip all ${allActive ? 'active' : ''}" data-action="run-scope-all">전체</button>`];
    // 폴더 전체를 경로 문자열과 함께 평탄화 (선택 시 하위 채널까지 포함됨을 명확히 하기 위해 경로 표시)
    function walk(parentId) {
      for (const f of folderChildren(parentId)) {
        const active = state.runFolderIds.includes(f.id);
        const count = channelCountInFolder(f.id);
        chips.push(`<button class="folder-chip ${active ? 'active' : ''}" data-action="run-scope-toggle" data-id="${f.id}">${esc(folderPath(f.id))} <span class="muted" style="opacity:.8;">(${count})</span></button>`);
        walk(f.id);
      }
    }
    walk(null);
    return `
      <div class="row" style="margin:4px 0 4px; align-items:center;">
        <span class="muted" style="font-size:12.5px;">체크 범위:</span>
      </div>
      <div class="folder-scope-bar">${chips.join('')}</div>
    `;
  }

  function renderRunPanel() {
    const folderIds = state.runFolderIds;
    let activeCount;
    if (folderIds.length > 0) {
      const subtreeIds = new Set();
      folderIds.forEach((fid) => getSubtreeIdsClient(fid).forEach((id) => subtreeIds.add(id)));
      activeCount = state.channels.filter((c) => c.active && c.folder_id != null && subtreeIds.has(c.folder_id)).length;
    } else {
      activeCount = state.channels.filter((c) => c.active).length;
    }
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
    const scopeText = folderIds.length > 0 ? folderIds.map((fid) => folderPath(fid)).join(', ') : '전체 채널';

    return `
      <div class="panel">
        <h2>오늘의 체크</h2>
        <p class="muted">선택 범위: <b>${esc(scopeText)}</b> · 활성 채널 ${fmtNum(activeCount)}개 기준으로 최근 24시간 내 업로드된 영상을 확인합니다.</p>
        ${renderRunFolderScopeBar()}
        <div class="row" style="margin-top:10px;">
          <button class="btn-primary" data-action="start-run" ${disabled ? 'disabled' : ''}>
            ${state.runBusy ? '체크 진행 중...' : '오늘 체크 시작'}
          </button>
          ${!state.settings.hasApiKey ? '<span class="muted">※ API 키를 먼저 등록해주세요.</span>' : ''}
          ${state.settings.hasApiKey && activeCount === 0 ? '<span class="muted">※ 선택 범위에 활성화된 채널이 없습니다.</span>' : ''}
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
      const scopeBadge = r.scope_label ? `<span class="scope-badge">📁 ${esc(r.scope_label)}</span>` : '<span class="scope-badge" style="background:rgba(154,164,178,.15); color:var(--text-dim);">전체</span>';
      return `
        <div class="run-row" ${selected} data-action="select-run" data-id="${r.id}">
          <div class="date">${esc(r.run_date)} ${statusBadge}</div>
          <div class="stats">${scopeBadge} 채널 ${fmtNum(r.total_channels)} · 영상 ${fmtNum(r.videos_found)} · 실패 ${fmtNum(r.channels_failed)}</div>
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

    const scopeBadge = state.currentRun && state.currentRun.scope_label
      ? `<span class="scope-badge">📁 ${esc(state.currentRun.scope_label)}</span>`
      : '';

    return `
      <div class="panel">
        <h2>결과 <span class="muted" style="font-weight:400;">(${state.currentRun ? esc(state.currentRun.run_date) : ''})</span> ${scopeBadge}</h2>
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

  // 폴더 트리 재귀 렌더링 (좌측 사이드바)
  function renderFolderTree() {
    function renderNode(f, depth) {
      const isActive = state.channelFolderFilter === f.id;
      const count = channelCountInFolder(f.id);
      const children = folderChildren(f.id);
      const expanded = state.expandedFolders.has(f.id) || children.length === 0;
      const caret = children.length > 0 ? (expanded ? '▾' : '▸') : '　';
      let html = `
        <div class="folder-node ${isActive ? 'active' : ''}" style="padding-left:${8 + depth * 14}px;" data-action="select-folder" data-id="${f.id}" data-drop-folder="${f.id}">
          ${children.length > 0 ? `<span class="icon" data-action="toggle-folder-expand" data-id="${f.id}" style="cursor:pointer; width:14px; text-align:center;">${caret}</span>` : '<span class="icon" style="width:14px;"></span>'}
          <span class="icon">📁</span>
          <span class="fname">${esc(f.name)}</span>
          <span class="count">${count}</span>
          <button class="fbtn" data-action="add-child-folder" data-id="${f.id}" title="하위 폴더 추가">＋</button>
          <button class="fbtn" data-action="rename-folder" data-id="${f.id}" title="이름 변경">✎</button>
          <button class="fbtn" data-action="delete-folder" data-id="${f.id}" title="삭제">🗑</button>
        </div>
      `;
      if (state.addingChildTo === f.id) {
        html += `
          <div class="folder-add-child-row" style="padding-left:${8 + (depth + 1) * 14}px;">
            <input type="text" id="new-child-folder-input" placeholder="하위 폴더 이름 (예: 축구)" />
            <button class="btn-secondary" data-action="confirm-add-child-folder" data-id="${f.id}">추가</button>
            <button class="btn-ghost" data-action="cancel-add-child-folder">취소</button>
          </div>
        `;
      }
      if (expanded) {
        for (const child of children) {
          html += renderNode(child, depth + 1);
        }
      }
      return html;
    }

    const rootNodes = folderChildren(null).map((f) => renderNode(f, 0)).join('');
    const unassignedCount = state.channels.filter((c) => c.folder_id == null).length;

    return `
      <div class="folder-panel">
        <h2>📂 폴더</h2>
        <div class="folder-new-row">
          <input type="text" id="new-folder-input" placeholder="새 폴더 이름 (예: 스포츠)" />
          <button class="btn-primary" data-action="create-root-folder">추가</button>
        </div>
        <div class="folder-tree">
          <div class="folder-node ${state.channelFolderFilter === 'all' ? 'active' : ''}" data-action="select-folder" data-id="all">
            <span class="icon" style="width:14px;"></span>
            <span class="icon">📚</span>
            <span class="fname">전체 채널</span>
            <span class="count">${state.channels.length}</span>
          </div>
          <div class="folder-node ${state.channelFolderFilter === 'unassigned' ? 'active' : ''}" data-action="select-folder" data-id="unassigned" data-drop-folder="unassigned">
            <span class="icon" style="width:14px;"></span>
            <span class="icon">🗂️</span>
            <span class="fname">미분류</span>
            <span class="count">${unassignedCount}</span>
          </div>
          ${rootNodes}
          ${state.addingChildTo === null ? '' : ''}
        </div>
        <p class="muted" style="margin-top:10px; line-height:1.5;">
          폴더 안에 폴더를 만들어 축구/야구처럼 세부 카테고리로 나눌 수 있어요.<br/>
          채널 목록에서 이동할 폴더를 선택하면 바로 옮길 수 있습니다.
        </p>
      </div>
    `;
  }

  function channelRowHtml(c) {
    const selected = state.selectedChannelIds.has(c.id);
    return `
      <div class="channel-row ${selected ? 'selected' : ''}" draggable="true" title="드래그하여 폴더로 이동할 수 있습니다">
        <input type="checkbox" data-action="toggle-channel-select" data-id="${c.id}" ${selected ? 'checked' : ''} />
        <img src="${esc(c.thumbnail || '')}" alt="" />
        <div class="name">${esc(c.title || c.channel_id)} <span class="sub">${esc(c.handle || '')}</span></div>
        <select class="move-select" data-action="move-channel-folder" data-id="${c.id}">
          ${buildFolderOptions(c.folder_id)}
        </select>
        <label class="muted" style="display:flex; align-items:center; gap:4px; font-size:12px;">
          <input type="checkbox" data-action="toggle-active" data-id="${c.id}" ${c.active ? 'checked' : ''} />
          활성
        </label>
        <button class="btn-danger" data-action="delete-channel" data-id="${c.id}">삭제</button>
      </div>
    `;
  }

  function getFilteredChannels() {
    let list = state.channels;
    if (state.channelFolderFilter === 'unassigned') {
      list = list.filter((c) => c.folder_id == null);
    } else if (state.channelFolderFilter !== 'all') {
      const ids = new Set(getSubtreeIdsClient(state.channelFolderFilter));
      list = list.filter((c) => c.folder_id != null && ids.has(c.folder_id));
    }
    if (state.channelFilter) {
      const q = state.channelFilter.toLowerCase();
      list = list.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.handle || '').toLowerCase().includes(q));
    }
    return list;
  }

  function renderChannels() {
    const filtered = getFilteredChannels();
    const channelRows = filtered.map(channelRowHtml).join('');

    const currentFolderLabel = state.channelFolderFilter === 'all'
      ? '전체 채널'
      : state.channelFolderFilter === 'unassigned'
        ? '미분류'
        : folderPath(state.channelFolderFilter) || '전체 채널';

    const allFilteredSelected = filtered.length > 0 && filtered.every((c) => state.selectedChannelIds.has(c.id));
    const selectAllBar = filtered.length > 0 ? `
      <label class="muted" style="display:flex; align-items:center; gap:6px; font-size:12.5px; margin-bottom:8px;">
        <input type="checkbox" id="select-all-checkbox" data-action="select-all-channels" ${allFilteredSelected ? 'checked' : ''} />
        전체선택 (${filtered.length}개)
      </label>
    ` : '';

    const bulkMoveBar = state.selectedChannelIds.size > 0 ? `
      <div class="row" style="margin-bottom:10px; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:8px 12px;">
        <span class="muted">${state.selectedChannelIds.size}개 선택됨</span>
        <select class="move-select" id="bulk-move-select" style="max-width:180px;">
          ${buildFolderOptions(null)}
        </select>
        <button class="btn-secondary" data-action="bulk-move-channels">선택한 채널 이동</button>
        <button class="btn-danger" data-action="bulk-delete-channels">선택한 채널 삭제</button>
        <button class="btn-ghost" data-action="clear-channel-selection">선택 해제</button>
      </div>
    ` : '';

    return `
      ${renderApiKeyWarning()}
      <div class="panel">
        <h2>채널 대량 등록</h2>
        <p class="muted">유튜브 채널 URL, @핸들, 채널ID를 한 줄에 하나씩 붙여넣으세요. (최대 약 200개 권장)</p>
        <textarea id="bulk-import-textarea" placeholder="https://www.youtube.com/@somechannel&#10;https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx&#10;@another_handle" ${state.importBusy ? 'disabled' : ''}></textarea>
        <div class="row" style="margin-top:10px; align-items:center;">
          <button class="btn-primary" data-action="bulk-import" ${state.importBusy ? 'disabled' : ''}>
            ${state.importBusy ? '등록 중...' : '일괄 등록'}
          </button>
          <span class="muted">등록 대상 폴더:</span>
          <select class="move-select" id="bulk-import-folder-select" style="max-width:200px;" ${state.importBusy ? 'disabled' : ''}>
            ${buildFolderOptions(state.importFolderId)}
          </select>
        </div>
        ${renderImportProgress()}
      </div>

      <div class="channels-layout">
        ${renderFolderTree()}
        <div class="panel" style="margin-bottom:0;">
          <div class="row" style="justify-content:space-between;">
            <h2 style="margin:0;">${esc(currentFolderLabel)} (${filtered.length}개)</h2>
            <input type="text" id="channel-filter-input" placeholder="채널명 검색..." value="${esc(state.channelFilter)}" style="min-width:200px;" />
          </div>
          ${selectAllBar}
          ${bulkMoveBar}
          <div class="channel-list">
            ${channelRows || '<div class="empty-state"><div class="big">📭</div>이 폴더에 채널이 없습니다.</div>'}
          </div>
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

    // ---- 폴더(카테고리) ----
    if (action === 'select-folder') {
      const raw = el.getAttribute('data-id');
      selectChannelFolderFilter(raw === 'all' || raw === 'unassigned' ? raw : Number(raw));
      return;
    }
    if (action === 'toggle-folder-expand') {
      e.stopPropagation();
      toggleFolderExpanded(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'create-root-folder') { createRootFolder(); return; }
    if (action === 'add-child-folder') {
      e.stopPropagation();
      showAddChildInput(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'confirm-add-child-folder') {
      e.stopPropagation();
      createChildFolder(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'cancel-add-child-folder') {
      e.stopPropagation();
      state.addingChildTo = null;
      render();
      return;
    }
    if (action === 'rename-folder') {
      e.stopPropagation();
      renameFolderPrompt(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'delete-folder') {
      e.stopPropagation();
      deleteFolderConfirm(Number(el.getAttribute('data-id')));
      return;
    }

    // ---- 채널 선택/일괄 이동 ----
    if (action === 'bulk-move-channels') {
      const sel = document.getElementById('bulk-move-select');
      const val = sel ? sel.value : '';
      moveSelectedChannelsToFolder(val ? Number(val) : null);
      return;
    }
    if (action === 'bulk-delete-channels') {
      bulkDeleteSelectedChannels();
      return;
    }
    if (action === 'clear-channel-selection') {
      state.selectedChannelIds = new Set();
      render();
      return;
    }

    // ---- 대시보드 체크 범위(폴더) 선택 ----
    if (action === 'run-scope-all') {
      state.runFolderIds = [];
      render();
      return;
    }
    if (action === 'run-scope-toggle') {
      toggleRunFolder(Number(el.getAttribute('data-id')));
      return;
    }
  });

  $app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.id === 'new-folder-input') {
      e.preventDefault();
      createRootFolder();
    } else if (e.target && e.target.id === 'new-child-folder-input') {
      e.preventDefault();
      if (state.addingChildTo != null) createChildFolder(state.addingChildTo);
    }
  });

  $app.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (action === 'toggle-active') {
      toggleChannelActive(Number(el.getAttribute('data-id')), el.checked);
      return;
    }
    if (action === 'toggle-channel-select') {
      toggleChannelSelected(Number(el.getAttribute('data-id')));
      return;
    }
    if (action === 'move-channel-folder') {
      const id = Number(el.getAttribute('data-id'));
      const folderId = el.value ? Number(el.value) : null;
      moveChannelToFolder(id, folderId);
      return;
    }
    if (action === 'select-all-channels') {
      toggleSelectAllFiltered();
      return;
    }
  });

  $app.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'channel-filter-input') {
      state.channelFilter = e.target.value;
      // 채널 목록만 다시 그리되, 포커스 유지를 위해 목록 부분만 갱신
      const listEl = $app.querySelector('.channel-list');
      if (listEl) {
        const filtered = getFilteredChannels();
        listEl.innerHTML = filtered.map(channelRowHtml).join('') || '<div class="empty-state"><div class="big">📭</div>검색 결과가 없습니다.</div>';
        const selectAllCheckbox = $app.querySelector('#select-all-checkbox');
        if (selectAllCheckbox) {
          const allSelected = filtered.length > 0 && filtered.every((c) => state.selectedChannelIds.has(c.id));
          selectAllCheckbox.checked = allSelected;
        }
      }
    }
  });

  // ---------------------------------------------------------------------
  // 드래그 앤 드롭: 채널 카드를 폴더 노드 위로 끌어다 놓으면 그 폴더로 이동
  // ---------------------------------------------------------------------

  $app.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.channel-row');
    if (!row) return;
    const checkbox = row.querySelector('[data-action="toggle-channel-select"]');
    const id = checkbox ? Number(checkbox.getAttribute('data-id')) : null;
    if (id == null) return;
    e.dataTransfer.setData('text/plain', String(id));
    e.dataTransfer.effectAllowed = 'move';
  });

  $app.addEventListener('dragover', (e) => {
    const node = e.target.closest('[data-drop-folder]');
    if (!node) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-target');
  });

  $app.addEventListener('dragleave', (e) => {
    const node = e.target.closest('[data-drop-folder]');
    if (node) node.classList.remove('drop-target');
  });

  $app.addEventListener('drop', (e) => {
    const node = e.target.closest('[data-drop-folder]');
    if (!node) return;
    e.preventDefault();
    node.classList.remove('drop-target');
    const raw = node.getAttribute('data-drop-folder');
    const folderId = raw === 'unassigned' ? null : Number(raw);
    const channelId = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isInteger(channelId)) return;
    if (state.selectedChannelIds.has(channelId) && state.selectedChannelIds.size > 1) {
      moveSelectedChannelsToFolder(folderId);
    } else {
      moveChannelToFolder(channelId, folderId);
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  async function boot() {
    try {
      await Promise.all([loadSettings(), loadChannels(), loadRuns(), loadFolders()]);
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
