(function () {
  'use strict';

  const MARKS = ['①', '②', '③', '④'];
  const ERROR_TEXT = {
    bad_subject: '교과를 선택하세요.',
    bad_unit: '단원을 1~60자로 입력하세요.',
    bad_difficulty: '난이도를 선택하세요.',
    teacher_only: '선생님 PC에서만 문항을 만들 수 있습니다.',
    not_found: '실행 중인 퀴즈 서버가 이전 버전입니다. 서버 창을 닫고 퀴즈_서버_실행.bat을 다시 실행해 주세요.',
    no_config: 'AI 연결 설정이 없습니다. 퀴즈_서버_실행.bat이 있는 폴더에 .env.local 파일을 만들고 AI_ENDPOINT, AI_API_KEY, AI_DEPLOYMENT 값을 넣어 주세요. (env_local_예시.txt 참고)',
    bad_config: '.env.local의 AI_ENDPOINT 또는 AI_API_KEY 값이 올바르지 않습니다. AI_ENDPOINT는 https:// 로 시작해야 합니다.',
    no_prompt: '프롬프트 파일(시스템 프롬프트.txt, quizgen-prompt.txt)을 찾을 수 없습니다.',
    busy: '이미 문항을 만들고 있습니다. 잠시 후 다시 시도하세요.',
    ai_auth: 'AI 서비스가 키를 받아들이지 않았습니다. .env.local의 AI_API_KEY를 확인하세요.',
    ai_not_found: 'AI 서비스 주소나 배포 이름을 찾을 수 없습니다. .env.local의 AI_ENDPOINT와 AI_DEPLOYMENT를 확인하세요.',
    ai_rate: 'AI 서비스 사용량이 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
    ai_timeout: 'AI 서비스의 응답이 너무 늦습니다. 잠시 후 다시 시도하세요.',
    ai_unreachable: 'AI 서비스에 연결하지 못했습니다. 인터넷 연결과 .env.local의 AI_ENDPOINT를 확인하세요.',
    ai_bad_output: 'AI가 문항을 정해진 형식으로 만들지 못했습니다. 다시 시도해 주세요.',
    ai_error: 'AI 서비스가 요청을 처리하지 못했습니다. 단원 이름을 바꾸거나 잠시 후 다시 시도하세요.'
  };

  const el = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    node.append(...children);
    return node;
  }

  async function api(path, body) {
    const options = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, options);
    let data = null;
    try { data = JSON.parse(await response.text()); } catch (e) { /* not JSON: handled below */ }
    if (!response.ok || data === null) {
      const error = new Error('request failed');
      error.code = (data && data.error) || 'http_' + response.status;
      throw error;
    }
    return data;
  }

  function showNotice(title, text) {
    el('notice-title').textContent = title;
    el('notice-text').textContent = text;
    el('notice').hidden = false;
  }

  function mascots() {
    return h('div', { className: 'mascots' }, ...['mean', 'median', 'mode'].map((kind) =>
      h('img', { src: `img/${kind}.svg`, alt: '', className: 'mascot', width: 48, height: 48 })));
  }

  function showResult(...children) {
    const box = el('result');
    box.replaceChildren(...children);
    box.hidden = false;
  }

  function card(item, index) {
    const choices = h('ol', { className: 'choices' }, ...item.choices.map((text, i) => {
      const mark = h('span', { className: 'mark' }, MARKS[i]);
      mark.setAttribute('aria-hidden', 'true');
      return h('li', { className: i + 1 === item.answer ? 'correct' : '' }, mark, h('span', null, text));
    }));
    const answer = h('details', { className: 'answer' },
      h('summary', null, '정답과 해설'),
      h('p', { className: 'answer-line' }, `정답 ${MARKS[item.answer - 1]} ${item.choices[item.answer - 1]}`),
      h('p', null, item.explanation));
    return h('article', { className: 'card' },
      h('h3', null, h('span', { className: 'number' }, `${index + 1}번`), h('span', { className: 'question' }, item.question)),
      choices,
      answer);
  }

  function renderCards(request, questions) {
    const cards = h('div', { className: 'cards' }, ...questions.map(card));
    const answers = Array.from(cards.querySelectorAll('details'));
    const toggle = h('button', { type: 'button', className: 'secondary' });

    // 정답은 접어 두었다가 펼칠 때만 보기에 표시합니다. 화면에 띄워 놓고 함께 풀 수 있게 하기 위해서입니다.
    const sync = () => {
      for (const answer of answers) answer.parentNode.classList.toggle('revealed', answer.open);
      toggle.textContent = answers.every((answer) => answer.open) ? '정답 모두 숨기기' : '정답 모두 보기';
    };
    for (const answer of answers) answer.addEventListener('toggle', sync);
    toggle.addEventListener('click', () => {
      const open = !answers.every((answer) => answer.open);
      for (const answer of answers) answer.open = open;
    });
    sync();

    showResult(
      h('div', { className: 'result-head' }, h('h2', null, '만든 문항'), toggle),
      h('ul', { className: 'chips' }, ...['초등 3학년', request.subject, request.unit, request.difficulty].map((text) => h('li', null, text))),
      h('p', { className: 'hint' }, 'AI가 만든 문항입니다. 수업에 쓰기 전에 문제와 정답이 맞는지 꼭 확인하세요.'),
      cards);
  }

  el('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = el('error');
    error.textContent = '';

    const request = {
      subject: el('subject').value,
      unit: el('unit').value.replace(/\s+/g, ' ').trim(),
      difficulty: el('difficulty').value
    };
    if (!request.unit) {
      error.textContent = '단원을 입력하세요.';
      el('unit').focus();
      return;
    }

    el('submit').disabled = true;
    const status = h('p', null, `${request.subject} "${request.unit}" 문항을 만들고 있어요. 보통 10~30초쯤 걸립니다.`);
    status.setAttribute('role', 'status');
    showResult(h('h2', null, '문항을 만드는 중'), h('div', { className: 'waiting' }, mascots(), status));
    try {
      const data = await api('/api/quizgen', request);
      renderCards(request, data.questions);
    } catch (e) {
      el('result').hidden = true;
      error.textContent = ERROR_TEXT[e.code] || '요청을 처리하지 못했습니다. 퀴즈 서버가 실행 중인지 확인한 뒤 다시 시도하세요.';
    }
    el('submit').disabled = false;
  });

  // 문항 만들기는 서버를 실행한 PC에서만 됩니다. 학생 기기는 수업코드 없이는 상태도 볼 수 없으므로(need_code)
  // 그 경우도 같은 안내를 보여 줍니다.
  (async function init() {
    // 공개 사이트(GitHub Pages)에는 AI 키를 둘 수 없으므로 문항 만들기를 열지 않습니다.
    if (location.hostname.endsWith('.github.io') || location.protocol === 'file:') {
      showNotice('공개 사이트에서는 사용할 수 없어요', 'AI 문항 만들기는 AI 서비스 키를 안전하게 지키기 위해 선생님 PC의 퀴즈 서버(퀴즈_서버_실행.bat)에서만 동작합니다.');
      return;
    }
    let teacher = false;
    try {
      teacher = (await api('/api/state')).teacher === true;
    } catch (e) {
      if (e.code !== 'need_code' && e.code !== 'bad_code') {
        showNotice('퀴즈 서버에 연결할 수 없습니다', '선생님 PC에서 퀴즈_서버_실행.bat을 실행한 뒤, 서버 창에 안내된 Quiz maker 주소로 접속해 주세요.');
        return;
      }
    }
    if (teacher) {
      el('maker').hidden = false;
      el('unit').focus();
    } else {
      showNotice('선생님 PC에서만 사용할 수 있습니다', '퀴즈 생성기는 퀴즈 서버를 실행한 컴퓨터의 브라우저에서 열어 주세요.');
    }
  })();
})();
