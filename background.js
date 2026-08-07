/* KMS — удаление ссылки на родительскую страницу.
   Фоновый service worker: держит очередь идентификаторов, открывает вкладки,
   раздаёт задание контент-скрипту и собирает результаты. */

const URL_TEMPLATE = 'https://kms.headoffice.psbank.local/content/space/2198/wiki/{id}';
const NOTICE_TEXT = 'Устранение ссылки на родительскую страницу';
const LINK_TEXT = 'Ссылка на родительскую страницу';

const STATE_KEY = 'runState';
const WATCHDOG = 'kms-watchdog';
const WATCHDOG_MINUTES = 3;

/* Коды нотификаций: [код, наименование] */
const CODES = {
  OK:         ['200', 'Опубликовано'],
  NO_LINK:    ['204', 'Ссылка не найдена, правка не требуется'],
  STOPPED:    ['299', 'Отменено оператором'],
  NO_EDIT:    ['403', 'Кнопка «Изменить» недоступна'],
  NOT_FOUND:  ['404', 'Страница не открылась'],
  TIMEOUT:    ['408', 'Превышено время ожидания'],
  NO_CANVAS:  ['409', 'Полотно редактора не найдено'],
  NO_DELETE:  ['422', 'Абзац не удалось удалить'],
  NO_PUBLISH: ['500', 'Кнопка «Опубликовать» не сработала'],
  WIZARD:     ['502', 'Мастер публикации не пройден'],
  TAB_LOST:   ['503', 'Вкладка закрыта до завершения'],
  UNKNOWN:    ['520', 'Непредвиденная ошибка']
};

const emptyState = () => ({
  running: false,
  stopRequested: false,
  ids: [],
  index: 0,
  parentUrl: '',
  activeTabs: true,
  pauseMs: 1200,
  currentTabId: null,
  currentId: null,
  results: [],
  startedAt: null,
  finishedAt: null
});

async function getState() {
  const box = await chrome.storage.session.get(STATE_KEY);
  return box[STATE_KEY] || emptyState();
}

async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  return state;
}

function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {/* панель закрыта */});
}

function formatLine(codeKey, id, detail) {
  const [code, name] = CODES[codeKey] || CODES.UNKNOWN;
  return { code, name, id, detail: detail || '', line: `${code} ${name}; ${id}` };
}

/* ---------- панель ---------- */

async function openPanel() {
  const url = chrome.runtime.getURL('ui.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openPanel);
chrome.runtime.onInstalled.addListener(openPanel);

/* ---------- очередь ---------- */

async function startRun(payload) {
  const ids = payload.ids.filter(Boolean);
  const state = emptyState();
  state.running = true;
  state.ids = ids;
  state.parentUrl = (payload.parentUrl || '').trim();
  state.activeTabs = payload.activeTabs !== false;
  state.pauseMs = Number(payload.pauseMs) || 1200;
  state.startedAt = Date.now();
  await setState(state);
  notify({ type: 'RUN_STARTED', total: ids.length });
  await processNext();
}

async function processNext() {
  const state = await getState();
  if (!state.running) return;

  if (state.stopRequested || state.index >= state.ids.length) {
    state.running = false;
    state.currentTabId = null;
    state.currentId = null;
    state.finishedAt = Date.now();
    await setState(state);
    await chrome.alarms.clear(WATCHDOG);
    notify({ type: 'RUN_FINISHED', results: state.results, stopped: state.stopRequested });
    return;
  }

  const id = state.ids[state.index];
  const url = URL_TEMPLATE.replace('{id}', encodeURIComponent(id));

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: state.activeTabs });
  } catch (e) {
    await finishItem('NOT_FOUND', String(e && e.message));
    return;
  }

  state.currentTabId = tab.id;
  state.currentId = id;
  await setState(state);

  notify({ type: 'ITEM_STARTED', id, index: state.index, total: state.ids.length });
  await chrome.alarms.create(WATCHDOG, { delayInMinutes: WATCHDOG_MINUTES });
}

async function finishItem(codeKey, detail) {
  const state = await getState();
  if (!state.running) return;

  const id = state.currentId ?? state.ids[state.index];
  const entry = formatLine(codeKey, id, detail);
  state.results.push(entry);

  const tabId = state.currentTabId;
  state.currentTabId = null;
  state.currentId = null;
  state.index += 1;
  await setState(state);
  await chrome.alarms.clear(WATCHDOG);

  notify({ type: 'ITEM_FINISHED', entry, done: state.index, total: state.ids.length });

  if (tabId != null) {
    try { await chrome.tabs.remove(tabId); } catch (e) {/* уже закрыта */}
  }

  await new Promise(r => setTimeout(r, state.pauseMs));
  await processNext();
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== WATCHDOG) return;
  const state = await getState();
  if (!state.running || state.currentTabId == null) return;
  await finishItem('TIMEOUT', `более ${WATCHDOG_MINUTES} мин на странице`);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await getState();
  if (state.running && state.currentTabId === tabId) {
    await finishItem('TAB_LOST');
  }
});

/* ---------- сообщения ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GET_JOB': {
        const state = await getState();
        const tabId = sender.tab && sender.tab.id;
        if (!state.running || tabId == null || tabId !== state.currentTabId) {
          sendResponse(null);
          return;
        }
        sendResponse({
          id: state.currentId,
          parentUrl: state.parentUrl,
          linkText: LINK_TEXT,
          noticeText: NOTICE_TEXT
        });
        return;
      }
      case 'STEP_LOG': {
        const state = await getState();
        if (sender.tab && sender.tab.id === state.currentTabId) {
          notify({ type: 'STEP_LOG', id: state.currentId, text: msg.text });
        }
        sendResponse(true);
        return;
      }
      case 'RESULT': {
        const state = await getState();
        if (!sender.tab || sender.tab.id !== state.currentTabId) {
          sendResponse(false);
          return;
        }
        sendResponse(true);
        await finishItem(msg.code, msg.detail);
        return;
      }
      case 'UI_START': {
        await startRun(msg.payload);
        sendResponse(true);
        return;
      }
      case 'UI_STOP': {
        const state = await getState();
        if (state.running) {
          state.stopRequested = true;
          await setState(state);
          notify({ type: 'STOP_REQUESTED' });
        }
        sendResponse(true);
        return;
      }
      case 'UI_STATE': {
        sendResponse(await getState());
        return;
      }
      case 'PING': {
        sendResponse(true);
        return;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // ответ асинхронный
});
