/* Панель расширения: сбор входных данных, запуск очереди, отображение отчёта. */

const $ = id => document.getElementById(id);

const els = {
  ids: $('ids'),
  parentUrl: $('parentUrl'),
  activeTabs: $('activeTabs'),
  pauseMs: $('pauseMs'),
  start: $('start'),
  stop: $('stop'),
  copy: $('copy'),
  save: $('save'),
  results: $('results'),
  status: $('status'),
  done: $('done'),
  total: $('total'),
  bar: $('progressBar'),
  error: $('formError')
};

const SETTINGS_KEY = 'uiSettings';
let lines = [];

/* ---------- сохранение полей между запусками ---------- */

async function restoreSettings() {
  const box = await chrome.storage.local.get(SETTINGS_KEY);
  const s = box[SETTINGS_KEY];
  if (!s) return;
  els.ids.value = s.ids || '';
  els.parentUrl.value = s.parentUrl || '';
  els.activeTabs.checked = s.activeTabs !== false;
  els.pauseMs.value = s.pauseMs ?? 1200;
}

function saveSettings() {
  chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ids: els.ids.value,
      parentUrl: els.parentUrl.value,
      activeTabs: els.activeTabs.checked,
      pauseMs: Number(els.pauseMs.value) || 0
    }
  });
}

['input', 'change'].forEach(evt => {
  [els.ids, els.parentUrl, els.activeTabs, els.pauseMs].forEach(el =>
    el.addEventListener(evt, saveSettings)
  );
});

/* ---------- отображение ---------- */

function parseIds(raw) {
  const seen = new Set();
  return raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(id => (seen.has(id) ? false : seen.add(id)));
}

function classFor(code) {
  if (code === '200') return 'is-ok';
  if (code === '204' || code === '299') return 'is-skip';
  return 'is-bad';
}

function renderEntry(entry) {
  const li = document.createElement('li');
  li.className = classFor(entry.code);
  const text = document.createElement('span');
  text.textContent = entry.line;
  li.append(text);
  if (entry.detail) {
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = entry.detail;
    li.append(detail);
  }
  els.results.append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function setProgress(done, total) {
  els.done.textContent = done;
  els.total.textContent = total;
  els.bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  const has = lines.length > 0;
  els.copy.disabled = !has;
  els.save.disabled = !has;
}

function setRunning(running) {
  els.start.disabled = running;
  els.stop.disabled = !running;
  els.ids.disabled = running;
  els.parentUrl.disabled = running;
  els.status.classList.toggle('status--work', running);
}

function say(text) {
  els.status.textContent = text;
}

/* ---------- запуск ---------- */

els.start.addEventListener('click', async () => {
  els.error.hidden = true;
  const ids = parseIds(els.ids.value);
  if (!ids.length) {
    els.error.textContent = 'Введите хотя бы один идентификатор — по одному в строке.';
    els.error.hidden = false;
    els.ids.focus();
    return;
  }

  lines = [];
  els.results.replaceChildren();
  setProgress(0, ids.length);
  setRunning(true);
  say('Открываю первую страницу…');

  await chrome.runtime.sendMessage({
    type: 'UI_START',
    payload: {
      ids,
      parentUrl: els.parentUrl.value.trim(),
      activeTabs: els.activeTabs.checked,
      pauseMs: Number(els.pauseMs.value) || 0
    }
  });
});

els.stop.addEventListener('click', async () => {
  els.stop.disabled = true;
  say('Останавливаю после текущей страницы…');
  await chrome.runtime.sendMessage({ type: 'UI_STOP' });
});

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(lines.join('\n'));
  els.copy.textContent = 'Скопировано';
  setTimeout(() => (els.copy.textContent = 'Скопировать список'), 1600);
});

els.save.addEventListener('click', () => {
  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `kms-обработка-${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* ---------- события фонового процесса ---------- */

chrome.runtime.onMessage.addListener(msg => {
  switch (msg && msg.type) {
    case 'RUN_STARTED':
      setRunning(true);
      setProgress(0, msg.total);
      break;
    case 'ITEM_STARTED':
      say(`Страница ${msg.index + 1} из ${msg.total}: ${msg.id}`);
      break;
    case 'STEP_LOG':
      say(`${msg.id}: ${msg.text}`);
      break;
    case 'ITEM_FINISHED':
      lines.push(msg.entry.line);
      renderEntry(msg.entry);
      setProgress(msg.done, msg.total);
      break;
    case 'STOP_REQUESTED':
      say('Остановка запрошена — дорабатываю текущую страницу.');
      break;
    case 'RUN_FINISHED':
      setRunning(false);
      say(msg.stopped ? 'Обработка остановлена оператором.' : 'Обработка завершена.');
      break;
  }
});

/* ---------- восстановление после перезагрузки панели ---------- */

async function restoreRun() {
  const state = await chrome.runtime.sendMessage({ type: 'UI_STATE' });
  if (!state) return;
  lines = state.results.map(r => r.line);
  els.results.replaceChildren();
  state.results.forEach(renderEntry);
  setProgress(state.results.length, state.ids.length);
  setRunning(state.running);
  if (state.running) say(`Обработка идёт: ${state.currentId ?? ''}`);
  else if (state.results.length) say('Обработка завершена.');
}

restoreSettings().then(restoreRun);
