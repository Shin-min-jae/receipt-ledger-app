/* 영수증장부 PWA v1 — 로그인(GIS) / 업로드(Drive) / 내역·집계(Sheets) */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  tokenExp: 0,
  tokenClient: null,
  rows: [],          // 경비장부 파싱 결과
  months: [],        // 데이터에 존재하는 월 목록 (내림차순)
  monthIdx: 0,
  deferredInstall: null,
};

/* ---------- 공용 ---------- */
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._tm); t._tm = setTimeout(() => { t.hidden = true; }, ms);
}
const fmtWon = (n) => (isFinite(n) ? Number(n).toLocaleString('ko-KR') + '원' : '-');

/* ---------- 인증 (Google Identity Services) ---------- */
function initAuth() {
  if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 300); return; }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (resp) => {
      if (resp.error) { toast('로그인 실패: ' + resp.error); showLogin(true); return; }
      state.token = resp.access_token;
      state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
      showLogin(false);
      toast('로그인 완료');
      refreshLedger();
    },
    error_callback: (err) => {
      showLogin(true);
      if (err?.type === 'popup_failed_to_open') {
        toast('팝업이 차단됐습니다. 주소창 오른쪽 끝의 팝업 차단 아이콘을 눌러 "항상 허용"으로 바꿔주세요', 6000);
      } else if (err?.type === 'popup_closed') {
        toast('로그인 창이 닫혔습니다. 다시 시도해주세요');
      } else {
        toast('로그인 오류: ' + (err?.type || '알 수 없음'));
      }
    },
  });
  showLogin(true);
  // 이전 방문에서 동의한 적 있으면 무음 시도
  state.tokenClient.requestAccessToken({ prompt: '' });
}
function showLogin(need) {
  $('btn-login').hidden = !need;
  $('login-state').classList.toggle('on', !need);
}
function isLoggedIn() {
  return !!(state.token && Date.now() < state.tokenExp);
}
async function waitForTokenClient(ms = 8000) {
  const t0 = Date.now();
  while (!state.tokenClient && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return state.tokenClient;
}
async function ensureToken(interactive = true) {
  if (isLoggedIn()) return state.token;
  const tc = await waitForTokenClient();
  if (!tc) throw new Error('구글 로그인 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const tm = setTimeout(() => { showLogin(true); finish(null); }, 90000);
    const orig = state.tokenClient.callback;
    state.tokenClient.callback = (resp) => {
      state.tokenClient.callback = orig;
      clearTimeout(tm);
      if (resp.error) { showLogin(true); finish(null); return; }
      state.token = resp.access_token;
      state.tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
      showLogin(false);
      finish(state.token);
    };
    state.tokenClient.requestAccessToken({ prompt: interactive ? undefined : '' });
  });
}
async function gfetch(url, opts = {}, retry = true) {
  const token = await ensureToken();
  if (!token) throw new Error('로그인이 필요합니다');
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401 && retry) { state.token = null; return gfetch(url, opts, false); }
  if (!r.ok) throw new Error('API 오류 ' + r.status);
  return r;
}

/* ---------- 업로드 ---------- */
async function uploadFile(file) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${file.name}</span><span class="uq-state">업로드 중…</span>`;
  $('upload-queue').prepend(li);
  const stateEl = li.querySelector('.uq-state');
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    const meta = { name: `영수증_${stamp}${ext}`, parents: [CONFIG.INBOX_FOLDER_ID] };
    const boundary = 'rcpt' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.type || 'image/jpeg'}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ]);
    await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    stateEl.textContent = '업로드 완료 ✓ (자동 분석 대기)';
    stateEl.className = 'uq-state ok';
  } catch (e) {
    stateEl.textContent = '실패: ' + e.message;
    stateEl.className = 'uq-state err';
  }
}
function bindUpload() {
  for (const id of ['file-camera', 'file-gallery']) {
    $(id).addEventListener('change', (ev) => {
      const files = [...ev.target.files];
      if (!files.length) return;
      if (!isLoggedIn()) {
        ev.target.value = '';
        toast('구글 로그인을 먼저 해주세요');
        state.tokenClient?.requestAccessToken();
        return;
      }
      files.forEach(uploadFile);
      ev.target.value = '';
      toast(files.length + '장 업로드 시작');
    });
  }
}

/* ---------- 내역 (Sheets 읽기) ---------- */
async function refreshLedger() {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(CONFIG.SHEET_RANGE)}`;
    const r = await gfetch(url);
    const data = await r.json();
    const C = CONFIG.COL;
    state.rows = (data.values || [])
      .map((v, i) => ({ v, rowNum: i + 2 }))
      .filter(({ v }) => (v[C.DATE] || v[C.VENDOR] || v[C.AMOUNT]))
      .map(({ v, rowNum }, i) => ({
        i, rowNum, date: v[C.DATE] || '', vendor: v[C.VENDOR] || '(미상)',
        amount: Number(String(v[C.AMOUNT] || '').replace(/[^\d.-]/g, '')) || 0,
        vat: v[C.VAT] || '', category: v[C.CATEGORY] || '-', reason: v[C.REASON] || '',
        link: v[C.LINK] || '', rtype: v[C.RTYPE] || '', status: v[C.STATUS] || '', memo: v[C.MEMO] || '',
        cardIssuer: v[C.CARD_ISSUER] || '', cardNo: v[C.CARD_NO] || '', approval: v[C.APPROVAL] || '',
        month: (v[C.DATE] || '').slice(0, 7),
      }));
    state.months = [...new Set(state.rows.map((r2) => r2.month).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();
    if (state.monthIdx >= state.months.length) state.monthIdx = 0;
    renderList();
    renderStats();
  } catch (e) {
    toast('내역을 불러오지 못했습니다: ' + e.message);
  }
}
function renderList() {
  const ul = $('ledger-list');
  ul.innerHTML = '';
  const rows = [...state.rows].reverse();
  $('list-empty').hidden = rows.length > 0;
  const needCheck = rows.filter((r) => r.status === '확인필요').length;
  const dupCheck = rows.filter((r) => r.status === '중복의심').length;
  const banner = $('need-check-banner');
  banner.hidden = needCheck + dupCheck === 0;
  if (needCheck + dupCheck) banner.textContent = `⚠ 검수 대기: 확인필요 ${needCheck}건 · 중복의심 ${dupCheck}건 (중복의심은 결재 전까지 집계 제외)`;
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'ledger-item';
    const badge = (r.status === '확인필요' || r.status === '중복의심') ? `<span class="badge check">${r.status}</span>` : `<span class="badge">${r.category}</span>`;
    li.innerHTML = `
      <div class="li-row1"><span class="li-vendor">${r.vendor}</span><span class="li-amount">${fmtWon(r.amount)}</span></div>
      <div class="li-row2"><span>${r.date || '날짜없음'}</span>${badge}<span>${r.rtype}</span></div>
      <div class="li-detail">
        ${r.reason ? '분류근거: ' + r.reason + '<br>' : ''}
        ${r.vat ? '부가세: ' + r.vat + '원<br>' : ''}
        ${r.cardIssuer || r.cardNo ? '결제: ' + [r.cardIssuer, r.cardNo].filter(Boolean).join(' ') + '<br>' : ''}
        ${r.approval ? '승인번호: ' + r.approval + '<br>' : ''}
        ${r.link ? `<a href="${r.link}" target="_blank" rel="noopener">증빙 사진 보기 ↗</a>` : ''}
        <div class="status-actions">
          현재 상태: <b>${r.status || '-'}</b><br>
          <button class="btn-status ok" data-status="확인완료">✓ 확인완료</button>
          <button class="btn-status no" data-status="제외">✕ 제외</button>
          <button class="btn-status" data-status="자동입력">↩ 복원</button>
        </div>
      </div>`;
    li.addEventListener('click', () => li.classList.toggle('open'));
    li.querySelectorAll('.btn-status').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setStatus(r, btn.dataset.status);
      });
    });
    ul.appendChild(li);
  }
}

/* ---------- 결재: 확인상태 변경 (Sheets 쓰기) ---------- */
async function setStatus(row, newStatus) {
  try {
    // 안전장치: 시트의 해당 행이 아직 같은 데이터인지 확인 (행 밀림 방지)
    const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(`경비장부!A${row.rowNum}:C${row.rowNum}`)}`;
    const chk = await (await gfetch(checkUrl)).json();
    const cur = (chk.values && chk.values[0]) || [];
    const sameAmount = String(Number(String(cur[2] || '').replace(/[^\d.-]/g, '')) || 0) === String(row.amount);
    if (String(cur[1] || '(미상)') !== row.vendor || !sameAmount) {
      toast('목록이 변경되어 새로고침합니다. 다시 시도해주세요');
      refreshLedger();
      return;
    }
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(`경비장부!I${row.rowNum}`)}?valueInputOption=USER_ENTERED`;
    await gfetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[newStatus]] }),
    });
    toast(`${row.vendor} → ${newStatus} 처리됨`);
    refreshLedger();
  } catch (e) {
    toast('상태 변경 실패: ' + e.message);
  }
}

/* ---------- 집계 ---------- */
function renderStats() {
  const label = $('month-label');
  if (!state.months.length) { label.textContent = '데이터 없음'; $('month-total').textContent = '0원'; $('stats-list').innerHTML = ''; $('month-count').textContent = ''; return; }
  const month = state.months[state.monthIdx];
  label.textContent = month.replace('-', '년 ') + '월';
  const rows = state.rows.filter((r) => r.month === month && r.status !== '제외' && r.status !== '중복의심');
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const needCheck = rows.filter((r) => r.status === '확인필요').length;
  $('month-total').textContent = fmtWon(total);
  $('month-count').textContent = `${rows.length}건 기록` + (needCheck ? ` · 확인필요 ${needCheck}건 제외 여부 검토` : '');
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  const max = Math.max(...Object.values(byCat), 1);
  const ul = $('stats-list');
  ul.innerHTML = '';
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="stat-cell"><div class="cat">${cat}</div><div class="bar"><i style="width:${Math.round((amt / max) * 100)}%"></i></div></div><span class="stat-amt">${fmtWon(amt)}</span>`;
    ul.appendChild(li);
  });
}

/* ---------- 탭 / 설치 ---------- */
function bindNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
      for (const t of ['upload', 'list', 'stats']) $('tab-' + t).hidden = t !== btn.dataset.tab;
      if (btn.dataset.tab === 'list' || btn.dataset.tab === 'stats') refreshLedger();
    });
  });
  $('btn-refresh').addEventListener('click', refreshLedger);
  $('btn-xlsx').href = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/export?format=xlsx`;
  $('month-prev').addEventListener('click', () => { if (state.monthIdx < state.months.length - 1) { state.monthIdx++; renderStats(); } });
  $('month-next').addEventListener('click', () => { if (state.monthIdx > 0) { state.monthIdx--; renderStats(); } });
  $('btn-login').addEventListener('click', () => state.tokenClient?.requestAccessToken());
}
function bindInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('btn-install').hidden = false;
  });
  $('btn-install').addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('btn-install').hidden = true;
  });
  $('ios-close').addEventListener('click', () => {
    $('ios-guide').hidden = true;
    try { localStorage.setItem('iosGuideSeen', '1'); } catch (e) {}
  });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let seen = false;
  try { seen = !!localStorage.getItem('iosGuideSeen'); } catch (e) {}
  if (isIos && !standalone && !seen) $('ios-guide').hidden = false;
}

/* ---------- 시작 ---------- */
window.addEventListener('load', () => {
  bindNav(); bindUpload(); bindInstall(); initAuth();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
