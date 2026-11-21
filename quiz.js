(function () {
  'use strict';

  const POLL_MS = 2000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ERROR_TEXT = {
    closed: '이미 마감되어 제출할 수 없습니다.',
    name_taken: '이미 다른 사람이 사용 중인 이름입니다. 다른 이름을 입력하세요.',
    bad_name: '이름을 1~12자로 입력하세요.',
    bad_value: '1부터 100까지의 정수를 입력하세요.',
    full: '참가 인원이 가득 찼습니다.',
    empty: '아직 제출된 응답이 없습니다.',
    teacher_only: '선생님 PC에서만 할 수 있는 작업입니다.',
    too_many: '요청이 너무 많습니다. 1분 뒤에 다시 시도하세요.'
  };
  const JOIN_ERROR_TEXT = {
    bad_code: '수업코드가 맞지 않습니다. 선생님 화면의 코드를 다시 확인하세요.',
    too_many: '코드를 여러 번 틀렸어요. 1분쯤 기다리면 자동으로 다시 시도합니다.'
  };
  const CODE_KEY = 'meanQuizClassCode';
  const SECTIONS = ['notice', 'join', 'teacher', 'entry', 'result'];

  // GitHub Pages처럼 퀴즈 서버 없이 열리면, 이 기기 하나로 여러 명의 응답을 입력해 보는 체험 모드로 동작합니다.
  // 체험 모드의 응답은 이 브라우저(localStorage)에만 저장되고 어디로도 전송되지 않습니다.
  const DEMO = location.hostname.endsWith('.github.io') || location.protocol === 'file:' ||
    new URLSearchParams(location.search).has('demo');
  const DEMO_KEY = 'meanQuizDemo';
  const SAMPLE = [
    ['김민준', 42], ['이서연', 55], ['박지호', 37], ['최수아', 50], ['정도윤', 50], ['강하은', 50], ['조시우', 50],
    ['윤지유', 33], ['장예준', 33], ['임서윤', 33], ['한주원', 1], ['오채원', 100], ['서건우', 67], ['신다은', 72],
    ['권현우', 45], ['황소율', 48], ['안지훈', 22], ['송예린', 60], ['류태윤', 60], ['전하린', 38], ['홍준서', 41],
    ['고나은', 29], ['문시현', 55], ['양유나', 70], ['손은우', 15], ['배서아', 88], ['백민재', 47], ['허지안', 52]
  ];
  const demo = DEMO ? loadDemo() : null;

  const el = (id) => document.getElementById(id);
  const clientId = getClientId();
  let classCode = loadClassCode();
  let savedClassCode = classCode;
  let pollTimer = null;
  let lastStateText = '';
  let requestSeq = 0;
  let appliedSeq = 0;
  let formPrefilled = false;
  let hadSubmission = false;

  // crypto.randomUUID() is unavailable on plain http://192.168.x.x pages, so build the id by hand.
  function getClientId() {
    const key = 'meanQuizClientId';
    try {
      const saved = localStorage.getItem(key);
      if (saved) return saved;
    } catch (e) { /* storage blocked: fall through to a one-off id */ }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, id); } catch (e) { /* ignore */ }
    return id;
  }

  // 한 번 입장한 기기는 새로고침해도 수업코드를 다시 묻지 않도록 기억해 둡니다.
  function loadClassCode() {
    try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; }
  }

  function storeClassCode(code) {
    if (code === savedClassCode) return;
    savedClassCode = code;
    try {
      if (code) localStorage.setItem(CODE_KEY, code); else localStorage.removeItem(CODE_KEY);
    } catch (e) { /* ignore */ }
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    node.append(...children);
    return node;
  }

  function s(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    node.textContent = '';
    return node;
  }

  const fmt = (x) => String(Math.round(x * 100) / 100);

  // ---------- 체험 모드: 서버(quiz-server.ps1)와 같은 규칙을 이 기기 안에서 처리합니다 ----------

  function loadDemo() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (saved && Array.isArray(saved.entries) && Number.isInteger(saved.nextId)) return saved;
    } catch (e) { /* 저장된 값이 없거나 깨졌으면 새로 시작합니다 */ }
    return { phase: 'open', nextId: 1, entries: [] };
  }

  function saveDemo() {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(demo)); } catch (e) { /* ignore */ }
  }

  function demoFail(code) {
    const error = new Error('request failed');
    error.code = code;
    throw error;
  }

  function demoApi(path, body) {
    if (path.startsWith('/api/state')) {
      const state = {
        phase: demo.phase,
        count: demo.entries.length,
        teacher: true,
        mine: null,
        code: '',
        addresses: [],
        names: demo.entries.map((e) => ({ id: e.id, name: e.name }))
      };
      if (demo.phase === 'revealed') state.entries = demo.entries.map((e) => ({ name: e.name, value: e.value }));
      return { data: state, text: JSON.stringify(state) };
    }

    if (path === '/api/submit') {
      if (demo.phase !== 'open') demoFail('closed');
      const name = String(body.name).replace(/\s+/g, ' ').trim();
      if (name.length < 1 || name.length > 12) demoFail('bad_name');
      if (!Number.isInteger(body.value) || body.value < 1 || body.value > 100) demoFail('bad_value');
      if (demo.entries.some((e) => e.name === name)) demoFail('name_taken');
      if (demo.entries.length >= 300) demoFail('full');
      demo.entries.push({ id: demo.nextId++, name, value: body.value });
    } else if (path === '/api/reveal') {
      if (!demo.entries.length) demoFail('empty');
      demo.phase = 'revealed';
    } else if (path === '/api/reset') {
      demo.entries = [];
      demo.phase = 'open';
    } else if (path === '/api/remove') {
      demo.entries = demo.entries.filter((e) => e.id !== body.id);
    }
    saveDemo();
    return { data: { ok: true }, text: '{"ok":true}' };
  }

  function setUpDemo() {
    el('teacher-title').textContent = '체험 모드';
    el('teacher-intro').textContent =
      '공개 체험판입니다. 이 기기 하나로 여러 사람이 차례로 이름과 숫자를 입력한 뒤 "결과 공개"를 눌러 보세요. ' +
      '입력한 내용은 이 기기의 브라우저에만 저장되고 어디로도 전송되지 않습니다. ' +
      '학생 각자 기기로 참여하는 실제 수업은 선생님 PC에서 퀴즈_서버_실행.bat을 실행해 진행합니다.';
    el('join-info').hidden = true;
    el('sample').hidden = false;
    el('sample').addEventListener('click', async () => {
      if (demo.entries.length && !confirm('지금 입력된 응답을 지우고 예시 28명으로 바꿀까요?')) return;
      demo.entries = SAMPLE.map(([name, value], i) => ({ id: demo.nextId + i, name, value }));
      demo.nextId += SAMPLE.length;
      demo.phase = 'open';
      saveDemo();
      await refresh();
    });
  }

  async function api(path, body) {
    if (DEMO) return demoApi(path, body);
    const options = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, options);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON: handled below */ }
    if (!response.ok || data === null) {
      const error = new Error('request failed');
      error.code = (data && data.error) || 'http_' + response.status;
      throw error;
    }
    return { data, text };
  }

  const errorText = (error) => ERROR_TEXT[error.code] || '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';

  // ---------- 대푯값 계산 ----------

  function analyze(entries) {
    const n = entries.length;
    const sorted = entries.map((e) => e.value).sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    const mid = Math.floor(n / 2);
    const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const byValue = new Map();
    for (const e of entries) {
      if (!byValue.has(e.value)) byValue.set(e.value, []);
      byValue.get(e.value).push(e.name);
    }
    const maxCount = Math.max(...Array.from(byValue.values(), (names) => names.length));
    // 서로 다른 값이 여럿인데 도수가 모두 같으면 최빈값은 없는 것으로 봅니다.
    const allSameCount = byValue.size > 1 && Array.from(byValue.values()).every((names) => names.length === maxCount);
    const modes = allSameCount
      ? []
      : Array.from(byValue).filter(([, names]) => names.length === maxCount).map(([v]) => v).sort((a, b) => a - b);

    // |값 - 평균| 대신 |값×n - 합|을 비교하면 정수끼리의 비교라 소수 오차로 순위가 뒤바뀌지 않습니다.
    const ranked = entries
      .map((e) => ({ name: e.name, value: e.value, scaled: Math.abs(e.value * n - sum) }))
      .sort((a, b) => a.scaled - b.scaled || a.value - b.value || a.name.localeCompare(b.name, 'ko'));
    ranked.forEach((row, i) => {
      row.rank = i > 0 && ranked[i - 1].scaled === row.scaled ? ranked[i - 1].rank : i + 1;
      row.diff = row.scaled / n;
    });

    return { n, sum, mean, median, modes, maxCount, byValue, ranked, winners: ranked.filter((row) => row.rank === 1) };
  }

  // ---------- 그래프 ----------

  function drawChart(a) {
    const W = 720, H = 352;
    const m = { left: 46, right: 16, top: 62, bottom: 46 };
    const plotW = W - m.left - m.right;
    const plotH = H - m.top - m.bottom;
    const x = (v) => m.left + (v / 101) * plotW;
    const step = Math.ceil(a.maxCount / 5);
    const yTop = step * Math.ceil(a.maxCount / step);
    const y = (count) => m.top + plotH - (count / yTop) * plotH;

    const modeText = a.modes.length ? a.modes.join(', ') : '없음';
    const svg = s('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'chart',
      role: 'img',
      'aria-label': `제출한 수의 분포 그래프. 평균 ${fmt(a.mean)}, 중앙값 ${fmt(a.median)}, 최빈값 ${modeText}.`
    });

    for (let count = 0; count <= yTop; count += step) {
      svg.append(s('line', { x1: m.left, x2: W - m.right, y1: y(count), y2: y(count), class: count === 0 ? 'axis' : 'grid' }));
      svg.append(s('text', { x: m.left - 8, y: y(count) + 5, 'text-anchor': 'end' }, String(count)));
    }
    for (let v = 0; v <= 100; v += 10) {
      svg.append(s('line', { x1: x(v), x2: x(v), y1: y(0), y2: y(0) + 5, class: 'axis' }));
      svg.append(s('text', { x: x(v), y: y(0) + 20, 'text-anchor': 'middle' }, String(v)));
    }
    svg.append(s('text', { x: m.left + plotW / 2, y: H - 6, 'text-anchor': 'middle' }, '제출한 수'));
    svg.append(s('text', { x: 4, y: 14, 'text-anchor': 'start' }, '인원(명)'));

    const barWidth = (plotW / 101) * 0.8;
    for (const [value, names] of a.byValue) {
      const bar = s('rect', {
        x: x(value) - barWidth / 2,
        y: y(names.length),
        width: barWidth,
        height: y(0) - y(names.length),
        class: a.modes.includes(value) ? 'bar mode' : 'bar'
      });
      bar.append(s('title', null, `${value}: ${names.length}명 (${names.join(', ')})`));
      svg.append(bar);
    }

    // 평균과 중앙값이 가까워도 겹치지 않도록, 이름표를 줄을 달리해 서로 바깥쪽에 둡니다.
    const labelWidth = (label) => Array.from(label).reduce((w, ch) => w + (ch > '\u2E7F' ? 14 : 8), 0);
    const marker = (value, cls, label, labelY, preferLeft) => {
      const lineX = x(value);
      const width = labelWidth(label);
      let left = preferLeft;
      if (left && lineX - 6 - width < 0) left = false;
      if (!left && lineX + 6 + width > W) left = true;
      svg.append(s('line', { x1: lineX, x2: lineX, y1: labelY - 12, y2: y(0), class: 'marker ' + cls }));
      return s('text', {
        x: left ? lineX - 6 : lineX + 6,
        y: labelY,
        'text-anchor': left ? 'end' : 'start',
        class: 'marker-label ' + cls
      }, label);
    };
    const meanIsLeft = a.mean <= a.median;
    const labels = [
      marker(a.mean, 'mean', `평균 ${fmt(a.mean)}`, m.top - 28, meanIsLeft),
      marker(a.median, 'median', `중앙값 ${fmt(a.median)}`, m.top - 8, !meanIsLeft)
    ];
    svg.append(...labels); // 글자는 선보다 나중에 그려 항상 위에 보이게 합니다.

    return svg;
  }

  // ---------- 화면 그리기 ----------

  // 마스코트: mean = 평균이, median = 중앙이, mode = 최빈이 (꾸밈 그림이라 alt는 비워 둡니다)
  function mascot(kind, size) {
    return h('img', { src: `img/${kind}.svg`, alt: '', className: 'mascot', width: size, height: size });
  }

  function mascotTrio(size) {
    return h('div', { className: 'mascots' }, mascot('mean', size), mascot('median', size), mascot('mode', size));
  }

  function statCard(kind, title, value, hint) {
    return h('div', { className: 'stat ' + kind },
      h('div', { className: 'stat-face' }, kind === 'count' ? mascotTrio(30) : mascot(kind, 50)),
      h('div', { className: 'stat-title' }, title),
      h('div', { className: 'stat-value' }, value),
      h('div', { className: 'hint' }, hint));
  }

  function renderResult(state) {
    const box = clear(el('result'));
    box.hidden = false;
    box.append(h('h2', null, '결과'));

    if (state.phase !== 'revealed') {
      box.append(h('div', { className: 'waiting' },
        mascotTrio(48),
        h('p', null, `선생님이 결과를 공개하면 여기에 표시됩니다. (현재 ${state.count}명 제출)`)));
      return;
    }
    if (!state.entries.length) {
      box.append(h('p', null, '제출된 응답이 없습니다.'));
      return;
    }

    const a = analyze(state.entries);
    const mine = state.mine ? a.ranked.find((row) => row.name === state.mine.name) : null;

    const winnerNames = a.winners.map((row) => `${row.name} (${row.value})`).join(', ');
    box.append(h('div', { className: 'winner-banner' },
      h('div', { className: 'winner-text' },
        h('div', { className: 'winner-title' }, `🏆 ${a.winners.length > 1 ? '공동 우승' : '우승'}: ${winnerNames}`),
        h('div', null, `평균 ${fmt(a.mean)}에 가장 가까운 수입니다. (평균과의 차이 ${fmt(a.winners[0].diff)})`)),
      mascotTrio(44)));

    if (mine) {
      box.append(h('p', { className: 'status' },
        `내 결과: ${mine.value} · 평균과의 차이 ${fmt(mine.diff)} · ${a.n}명 중 ${mine.rank}위`));
    }

    let modeValue = '없음';
    let modeHint = '모든 값이 같은 횟수만큼 나왔습니다';
    if (a.modes.length) {
      modeValue = a.modes.join(', ');
      modeHint = `${a.modes.length > 1 ? '각각 ' : ''}${a.maxCount}명이 고른 값`;
    }
    box.append(h('div', { className: 'stats' },
      statCard('count', '응답 수', `${a.n}명`, `합계 ${a.sum}`),
      statCard('mean', '평균', fmt(a.mean), `${a.sum} ÷ ${a.n}`),
      statCard('median', '중앙값', fmt(a.median), '크기순으로 가운데 값'),
      statCard('mode', '최빈값', modeValue, modeHint)));

    box.append(h('div', { className: 'chart-wrap' }, drawChart(a)));
    box.append(h('ul', { className: 'legend' },
      h('li', null, h('span', { className: 'swatch bar' }), '제출 인원'),
      h('li', null, h('span', { className: 'swatch mode' }), '최빈값'),
      h('li', null, h('span', { className: 'swatch line mean' }), '평균'),
      h('li', null, h('span', { className: 'swatch line median' }), '중앙값')));

    const tbody = h('tbody');
    for (const row of a.ranked) {
      const isMine = mine && row.name === mine.name;
      const tr = h('tr', { className: row.rank === 1 ? 'winner' : '' },
        h('td', null, row.rank === 1 ? `🏆 ${row.rank}` : String(row.rank)),
        h('td', null, isMine ? `${row.name} (나)` : row.name),
        h('td', null, String(row.value)),
        h('td', null, fmt(row.diff)));
      tbody.append(tr);
    }
    box.append(h('div', { className: 'table-wrap' },
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, '순위'),
          h('th', { scope: 'col' }, '이름'),
          h('th', { scope: 'col' }, '제출한 수'),
          h('th', { scope: 'col' }, '평균과의 차이'))),
        tbody)));
  }

  function renderTeacher(state) {
    const addresses = clear(el('addresses'));
    if (state.addresses.length) {
      for (const address of state.addresses) addresses.append(h('li', null, address));
    } else {
      addresses.append(h('li', { className: 'hint' }, '네트워크 주소를 찾지 못했습니다. 이 PC의 Wi-Fi 연결을 확인하세요.'));
    }
    el('class-code').textContent = state.code;

    el('teacher-count').textContent = String(state.count);

    const names = clear(el('names'));
    for (const entry of state.names) {
      const remove = h('button', { type: 'button', className: 'chip-remove', title: '이 응답 삭제' }, '×');
      remove.setAttribute('aria-label', `${entry.name} 응답 삭제`);
      remove.addEventListener('click', () => {
        if (confirm(`"${entry.name}"의 응답을 삭제할까요?`)) teacherAction('/api/remove', { id: entry.id });
      });
      names.append(h('li', null, entry.name, remove));
    }

    el('reveal').hidden = state.phase === 'revealed';
    el('reveal').disabled = state.count === 0;
  }

  function renderEntry(state) {
    el('entry').hidden = state.phase === 'revealed';
    if (state.mine && !formPrefilled) {
      el('name').value = state.mine.name;
      el('value').value = state.mine.value;
    }
    formPrefilled = true;
    // 새 퀴즈가 시작되어 내 응답이 지워졌다면, 지난 숫자를 무심코 다시 내지 않도록 숫자 칸을 비웁니다.
    if (hadSubmission && !state.mine) el('value').value = '';
    hadSubmission = Boolean(state.mine);
    el('submit').textContent = state.mine ? '수정하기' : '제출';
    el('status').textContent = state.mine
      ? `제출 완료! ${state.mine.name} 님이 제출한 수: ${state.mine.value} (결과 공개 전까지 수정할 수 있어요)`
      : '';
  }

  function render(state) {
    el('notice').hidden = true;
    el('join').hidden = true;
    el('teacher').hidden = !state.teacher;
    if (state.teacher) renderTeacher(state);
    renderEntry(state);
    renderResult(state);
  }

  function showOnly(id) {
    for (const section of SECTIONS) el(section).hidden = section !== id;
  }

  function showJoin(errorCode) {
    // 틀린 코드는 버립니다. 서버를 다시 켜면 코드가 바뀌므로, 예전에 저장한 코드도 여기서 지워집니다.
    if (errorCode !== 'too_many') {
      classCode = '';
      storeClassCode('');
    }
    el('join-error').textContent = JOIN_ERROR_TEXT[errorCode] || '';
    showOnly('join');
  }

  // ---------- 서버와 통신 ----------

  // 결과: 'ok' | 'join'(수업코드를 입력해야 함) | 'retry'(서버에 연결할 수 없거나 잠시 막힘)
  async function refresh() {
    const seq = ++requestSeq;
    let url = '/api/state?client=' + encodeURIComponent(clientId);
    if (classCode) url += '&code=' + encodeURIComponent(classCode);
    try {
      const { data, text } = await api(url);
      if (seq < appliedSeq) return 'ok'; // 늦게 도착한 예전 응답은 버립니다.
      appliedSeq = seq;
      storeClassCode(classCode);
      if (text !== lastStateText) {
        lastStateText = text;
        render(data);
      }
      return 'ok';
    } catch (e) {
      if (seq < appliedSeq) return 'ok';
      lastStateText = '';
      if (e.code === 'need_code' || e.code === 'bad_code') {
        showJoin(e.code);
        return 'join';
      }
      if (e.code === 'too_many') showJoin(e.code); else showOnly('notice');
      return 'retry';
    }
  }

  async function poll() {
    clearTimeout(pollTimer);
    const result = await refresh();
    clearTimeout(pollTimer);
    // 수업코드를 기다리는 동안에는 서버에 묻지 않고, 입장하면 다시 시작합니다.
    if (result !== 'join') pollTimer = setTimeout(poll, POLL_MS);
  }

  async function teacherAction(path, body) {
    el('teacher-error').textContent = '';
    try {
      await api(path, body || {});
    } catch (e) {
      el('teacher-error').textContent = errorText(e);
    }
    await refresh();
  }

  el('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = el('error');
    error.textContent = '';

    const name = el('name').value.replace(/\s+/g, ' ').trim();
    const raw = el('value').value.trim();
    if (!name) {
      error.textContent = '이름을 입력하세요.';
      el('name').focus();
      return;
    }
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
      error.textContent = ERROR_TEXT.bad_value;
      el('value').focus();
      return;
    }

    el('submit').disabled = true;
    let submitted = false;
    try {
      await api('/api/submit', { client: clientId, code: classCode, name, value: Number(raw) });
      submitted = true;
    } catch (e) {
      error.textContent = errorText(e);
    }
    el('submit').disabled = false;
    await refresh();

    // 체험 모드에서는 다음 사람이 바로 입력할 수 있도록 칸을 비웁니다.
    if (submitted && DEMO) {
      el('name').value = '';
      el('value').value = '';
      el('status').textContent = `${name} 님의 숫자를 받았어요. 다음 사람이 입력하세요!`;
      el('name').focus();
    }
  });

  el('join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = el('code').value.trim();
    if (!/^\d{4}$/.test(raw)) {
      el('join-error').textContent = '수업코드 숫자 4자리를 입력하세요.';
      el('code').focus();
      return;
    }
    el('join-error').textContent = '';
    classCode = raw;
    el('join-submit').disabled = true;
    await poll();
    el('join-submit').disabled = false;
  });

  el('reveal').addEventListener('click', () => {
    if (confirm('결과를 공개할까요? 공개한 뒤에는 더 이상 제출할 수 없습니다.')) teacherAction('/api/reveal');
  });

  el('reset').addEventListener('click', () => {
    if (confirm('모든 응답을 지우고 새 퀴즈를 시작할까요?')) teacherAction('/api/reset');
  });

  if (DEMO) setUpDemo();
  poll();
})();
