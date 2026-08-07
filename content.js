/* KMS — удаление ссылки на родительскую страницу.
   Контент-скрипт работает на страницах kms.headoffice.psbank.local.
   Он самостоятельно определяет фазу (просмотр / редактирование), поэтому
   переживает полную перезагрузку страницы при переходе в режим правки. */

(() => {
  if (window.__kmsParentLinkCleaner) return;
  window.__kmsParentLinkCleaner = true;

  const SEL = {
    editButton: 'button[data-tip="Изменить"], button[title="Изменить"], button[aria-label="Изменить"]',
    canvasWrapper: '.remirror-editor-wrapper',
    editable: '.remirror-editor-wrapper .ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]',
    fullWidthIcon: '[class*="FullWidthButton_icon"]',
    editorContainer: '.article-editor__editor',
    publishButton: 'button[title="Опубликовать"], button.ArticlePublishButton_button__gfCV9',
    modal: '.wizard-wrapper, .versioning-wrapper, [class*="wizard-wrapper"]',
    navTab: 'li[data-tip="навигация"], li.tabs__list-item',
    submit: 'button[type="submit"]',
    noticeArea:
      '.versioning-wrapper__notification textarea, textarea[placeholder="Введите текст сообщения"]'
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  class StepError extends Error {
    constructor(code, detail) {
      super(detail || code);
      this.code = code;
      this.detail = detail || '';
    }
  }

  function log(text) {
    chrome.runtime.sendMessage({ type: 'STEP_LOG', text }).catch(() => {});
  }

  function visible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const rects = el.getClientRects();
    return rects.length > 0;
  }

  async function waitFor(fn, { timeout = 30000, interval = 200, code = 'TIMEOUT', detail = '' } = {}) {
    const started = Date.now();
    for (;;) {
      let value = null;
      try { value = fn(); } catch (e) { value = null; }
      if (value) return value;
      if (Date.now() - started > timeout) throw new StepError(code, detail || 'элемент не появился');
      await sleep(interval);
    }
  }

  function findButtonByText(selector, text) {
    const target = norm(text);
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .find(el => norm(el.textContent) === target) || null;
  }

  function click(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    const base = { bubbles: true, cancelable: true, composed: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, buttons: 1 })); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
    return true;
  }

  /* ---------- раскрытие полотна на всю ширину ---------- */

  /* Подсказка «на всю ширину» висит на обёртке кнопки, а не на самой кнопке.
     Класс иконки — хеш CSS-модуля и меняется при пересборке фронта, поэтому
     он идёт только запасным путём и сравнивается по префиксу. */
  function findFullWidthButton() {
    const wrapper = Array.from(document.querySelectorAll('[data-tip]'))
      .find(el => norm(el.getAttribute('data-tip')) === 'на всю ширину');
    if (wrapper) {
      const byTip = wrapper.tagName === 'BUTTON' ? wrapper : wrapper.querySelector('button');
      if (visible(byTip)) return byTip;
    }
    const icon = document.querySelector(SEL.fullWidthIcon);
    const byIcon = icon && icon.closest('button');
    return visible(byIcon) ? byIcon : null;
  }

  /* Ширина отображения страницы в режиме правки случайна: одни страницы
     открываются уже раскрытыми, другие — узкими. Состояние читается двумя
     независимыми способами.

     1. Класс кнопки. Раскрытая: ToolbarButton_toolbar__button--active__g+p2p,
        узкая — этого класса нет. Хвост после «--active» это хеш CSS-модуля,
        он меняется при пересборке, поэтому сравниваем по префиксу. Префикс
        взят с «--active», а не с «--»: класс «--disabled» носят выключенные
        кнопки тулбара и спутать их нельзя.
     2. Ограничение ширины на контейнере редактора: «max-width: unset» у
        раскрытой против «max-width: 800px» у узкой.

     Подсказка на обёртке для этого не годится: она остаётся «на всю ширину»
     в обоих состояниях.

     Возвращает true — раскрыта, false — узкая, null — определить не удалось. */
  const FULL_WIDTH_ACTIVE_CLASS = 'ToolbarButton_toolbar__button--active';

  function isFullWidth() {
    const button = findFullWidthButton();
    if (button) {
      return Array.from(button.classList).some(cls => cls.startsWith(FULL_WIDTH_ACTIVE_CLASS));
    }

    const editor = document.querySelector(SEL.editorContainer);
    if (!editor) return null;

    const limit = norm(editor.style.maxWidth) || norm(getComputedStyle(editor).maxWidth);
    // снятое ограничение — полотно раскрыто, числовое — узкое
    return !limit || limit === 'unset' || limit === 'none' || limit === 'initial';
  }

  /* Запасной путь для случая, когда состояние прочитать не удалось: тогда
     единственный доступный признак сработавшего клика — любое изменение
     наблюдаемых свойств. */
  function fullWidthState(editable) {
    const button = findFullWidthButton();
    const wrapper = button && button.closest('[data-tip]');
    return {
      width: Math.round(editable.getBoundingClientRect().width),
      tip: wrapper ? norm(wrapper.getAttribute('data-tip')) : '',
      cls: button ? button.className : '',
      present: !!button
    };
  }

  function sameState(a, b) {
    return a.width === b.width && a.tip === b.tip && a.cls === b.cls && a.present === b.present;
  }

  /* Пока идёт первичная отрисовка, ширина полотна прыгает. Дожидаемся
     нескольких одинаковых замеров подряд — это признак того, что вёрстка
     устоялась и обработчики уже на месте. */
  async function waitLayoutSettled(editable, { timeout = 12000, hits = 3, interval = 150 } = {}) {
    const started = Date.now();
    let last = -1;
    let streak = 0;
    for (;;) {
      const width = Math.round(editable.getBoundingClientRect().width);
      streak = width > 0 && width === last ? streak + 1 : 0;
      last = width;
      if (streak >= hits) return width;
      if (Date.now() - started > timeout) {
        log('вёрстка полотна не устоялась — жмём как есть');
        return width;
      }
      await sleep(interval);
    }
  }

  /* Клик может потеряться, если обработчик ещё не навешен, — тогда повторяем.
     Состояние перечитывается перед каждой попыткой, поэтому лишнего клика по
     уже раскрытому полотну не будет. */
  const FULL_WIDTH_ATTEMPTS = 3;

  async function expandCanvas(editable) {
    try {
      await waitFor(findFullWidthButton, { timeout: 15000, code: 'NO_FULL_WIDTH' });
    } catch (e) {
      // ширина полотна на содержимое не влияет — не срываем из-за неё работу
      log('кнопка «на всю ширину» не найдена — продолжаем без неё');
      return false;
    }

    await waitLayoutSettled(editable);

    if (isFullWidth() === null) return expandCanvasBlind(editable);

    for (let attempt = 1; attempt <= FULL_WIDTH_ATTEMPTS; attempt += 1) {
      if (isFullWidth()) {
        log(attempt === 1
          ? 'страница уже раскрыта на всю ширину — кнопка не нужна'
          : 'полотно раскрыто на всю ширину');
        return true;
      }

      const button = findFullWidthButton();
      if (!button) {
        log('кнопка «на всю ширину» пропала из разметки — продолжаем без неё');
        return false;
      }

      log(attempt === 1
        ? 'страница узкая — жмём «на всю ширину»'
        : `кнопка «на всю ширину» — попытка ${attempt}`);
      click(button);

      const expanded = await waitFor(isFullWidth, {
        timeout: 2500, interval: 100, code: 'NO_FULL_WIDTH'
      }).catch(() => false);

      if (expanded) {
        await sleep(400); // даём полотну дорисоваться
        return true;
      }

      // клик не дошёл до обработчика; ждём и повторяем
      await sleep(500 * attempt);
    }

    log('кнопка «на всю ширину» не отреагировала — продолжаем без неё');
    return false;
  }

  /* Разметка изменилась и состояние прочитать нечем: жмём один раз и считаем
     успехом любое изменение. Повторов здесь нет намеренно — не зная состояния,
     повторный клик рискует свернуть уже раскрытое полотно. */
  async function expandCanvasBlind(editable) {
    const button = findFullWidthButton();
    if (!button) return false;

    log('состояние ширины определить не удалось — жмём «на всю ширину» вслепую');
    const before = fullWidthState(editable);
    click(button);

    const reacted = await waitFor(() => !sameState(fullWidthState(editable), before), {
      timeout: 2500, interval: 100, code: 'NO_FULL_WIDTH'
    }).catch(() => false);

    if (!reacted) log('кнопка «на всю ширину» не отреагировала — продолжаем без неё');
    await sleep(400);
    return !!reacted;
  }

  /* ---------- поиск нужного абзаца ---------- */

  function sameUrl(a, b) {
    if (!a || !b) return false;
    const clean = u => String(u).trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
    const x = clean(a), y = clean(b);
    if (x === y) return true;
    try {
      return new URL(x, location.origin).pathname === new URL(y, location.origin).pathname;
    } catch (e) {
      return false;
    }
  }

  function findLinkParagraph(root, job) {
    const anchors = Array.from(root.querySelectorAll('a'));
    for (const a of anchors) {
      if (norm(a.textContent) !== norm(job.linkText)) continue;
      if (job.parentUrl && !sameUrl(a.getAttribute('href'), job.parentUrl)) continue;
      const p = a.closest('p');
      if (!p || !root.contains(p)) continue;
      // абзац должен состоять только из этой ссылки
      if (norm(p.textContent) !== norm(a.textContent)) continue;
      return p;
    }
    return null;
  }

  /* ---------- удаление абзаца без остатка пустой строки ---------- */

  /* Служебные узлы ProseMirror (виджет позиционера, кнопки таблиц) лежат
     прямо в полотне рядом с абзацами, но контентом не являются. */
  function isWidget(el) {
    if (!el) return true;
    return el.classList.contains('ProseMirror-widget') ||
      el.getAttribute('contenteditable') === 'false' ||
      el.getAttribute('data-id') === 'remirror-positioner-widget';
  }

  function nextBlock(el) {
    let n = el.nextElementSibling;
    while (n && isWidget(n)) n = n.nextElementSibling;
    return n;
  }

  /* Пустой абзац-разделитель. Внутри может быть один или несколько <br>:
     последний <br class="ProseMirror-trailingBreak"> дорисовывает сам
     редактор, остальные — настоящие переводы строки. Любой такой абзац
     считаем пустой строкой целиком. */
  function isEmptyBlock(el) {
    if (!el || el.tagName !== 'P') return false;
    if (el.querySelector('img, table, iframe, video, audio, hr, a')) return false;
    return norm(el.textContent) === '';
  }

  /* Абзац со ссылкой и все идущие следом пустые абзацы: их количество на
     разных страницах отличается, поэтому считаем его по факту, а не жёстко. */
  function removalRange(p) {
    const blanks = [];
    let n = nextBlock(p);
    while (n && isEmptyBlock(n)) {
      blanks.push(n);
      n = nextBlock(n);
    }
    return { blanks, next: n };
  }

  async function deleteParagraph(editable, p) {
    const selection = window.getSelection();
    const { blanks, next } = removalRange(p);

    if (blanks.length) log(`после ссылки удаляется пустых абзацев: ${blanks.length}`);

    editable.focus();
    const range = document.createRange();

    if (next) {
      // от начала абзаца со ссылкой до начала первого содержательного блока —
      // уходят и сам абзац, и все пустые строки между ними, а текст
      // следующего блока поднимается в самое начало страницы
      range.selectNodeContents(p);
      range.collapse(true);
      const head = document.createRange();
      head.selectNodeContents(next);
      head.collapse(true);
      range.setEnd(head.startContainer, head.startOffset);
    } else {
      // содержательных блоков дальше нет — забираем всё до конца последнего пустого
      range.selectNodeContents(p);
      range.collapse(true);
      const tail = document.createRange();
      tail.selectNodeContents(blanks.length ? blanks[blanks.length - 1] : p);
      tail.collapse(false);
      range.setEnd(tail.endContainer, tail.endOffset);
    }

    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(150); // даём ProseMirror синхронизировать выделение

    try { document.execCommand('delete'); } catch (e) {}
    await sleep(350);

    if (findLinkParagraph(editable, currentJob)) {
      // запасной путь: событие удаления, затем прямое удаление узлов
      try {
        editable.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
        }));
      } catch (e) {}
      await sleep(200);
      const still = findLinkParagraph(editable, currentJob);
      if (still) {
        removalRange(still).blanks.forEach(el => el.remove());
        still.remove();
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        await sleep(400);
      }
    }

    if (findLinkParagraph(editable, currentJob)) return false;

    // ссылка ушла, но перед первым текстом мог остаться пустой абзац —
    // подчищаем начало полотна, чтобы текст стоял в самой первой строке
    await trimLeadingBlanks(editable);
    return true;
  }

  async function trimLeadingBlanks(editable) {
    let first = editable.firstElementChild;
    while (first && isWidget(first)) first = nextBlock(first);
    if (!isEmptyBlock(first)) return;

    const { next } = removalRange(first);
    if (!next) return; // кроме пустых абзацев ничего нет — не трогаем

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(first);
    range.collapse(true);
    const head = document.createRange();
    head.selectNodeContents(next);
    head.collapse(true);
    range.setEnd(head.startContainer, head.startOffset);

    editable.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(150);

    try { document.execCommand('delete'); } catch (e) {}
    await sleep(300);

    let head2 = editable.firstElementChild;
    while (head2 && isWidget(head2)) head2 = nextBlock(head2);
    if (isEmptyBlock(head2)) {
      // запасной путь: убираем оставшиеся пустые абзацы напрямую
      while (head2 && isEmptyBlock(head2) && nextBlock(head2)) {
        const victim = head2;
        head2 = nextBlock(head2);
        victim.remove();
      }
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await sleep(300);
    }
  }

  /* ---------- ввод значения в поле React ---------- */

  function setFieldValue(field, value) {
    const proto = Object.getPrototypeOf(field);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    field.focus();
    if (desc && desc.set) desc.set.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- мастер публикации ---------- */

  async function passWizard(job) {
    log('ожидание модального окна');
    await waitFor(
      () => document.querySelector(SEL.modal) || findButtonByText(SEL.submit, 'Продолжить'),
      { timeout: 30000, code: 'WIZARD', detail: 'модальное окно не появилось' }
    );

    log('вкладка «навигация»');
    const navTab = await waitFor(
      () =>
        Array.from(document.querySelectorAll(SEL.navTab))
          .filter(visible)
          .find(li => norm(li.getAttribute('data-tip')) === 'навигация' || norm(li.textContent) === 'навигация'),
      { timeout: 20000, code: 'WIZARD', detail: 'вкладка «навигация» не найдена' }
    );
    click(navTab);
    await sleep(600);

    for (let step = 1; step <= 3; step += 1) {
      if (document.querySelector(SEL.noticeArea)) break;
      log(`«Продолжить» — шаг ${step}`);
      const next = await waitFor(() => findButtonByText(SEL.submit, 'Продолжить'), {
        timeout: 20000, code: 'WIZARD', detail: `кнопка «Продолжить» не найдена (шаг ${step})`
      });
      click(next);
      await sleep(800);
    }

    log('поле «Уведомление»');
    const area = await waitFor(() => {
      const el = document.querySelector(SEL.noticeArea);
      return visible(el) ? el : null;
    }, { timeout: 25000, code: 'WIZARD', detail: 'поле «Уведомление» не появилось' });

    setFieldValue(area, job.noticeText);
    await sleep(400);

    log('«Завершить»');
    const finish = await waitFor(() => findButtonByText(SEL.submit, 'Завершить'), {
      timeout: 20000, code: 'WIZARD', detail: 'кнопка «Завершить» не найдена'
    });
    click(finish);

    // публикация считается успешной, когда мастер закрылся
    await waitFor(
      () => !findButtonByText(SEL.submit, 'Завершить') && !document.querySelector(SEL.noticeArea),
      { timeout: 60000, code: 'WIZARD', detail: 'мастер не закрылся после «Завершить»' }
    );
    await sleep(800);
  }

  /* ---------- фазы ---------- */

  let currentJob = null;

  function getEditable() {
    const el = document.querySelector(SEL.editable);
    return visible(el) ? el : null;
  }

  async function editPhase(job) {
    const editable = await waitFor(getEditable, {
      timeout: 45000, code: 'NO_CANVAS', detail: 'полотно редактора не найдено'
    });
    await sleep(800); // дождаться подгрузки содержимого

    // Абзац ищем до раскрытия полотна: найденная ссылка означает, что редактор
    // отрисовал документ, а не только каркас, — по «пустому» редактору жать
    // тулбар рано, обработчик кнопки ещё не навешен.
    let paragraph = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      paragraph = findLinkParagraph(editable, job);
      if (paragraph) break;
      await sleep(400);
    }

    if (!paragraph) {
      log('ссылка на родительскую страницу не найдена — страница не публикуется');
      return { code: 'NO_LINK' };
    }

    // раскрываем полотно до правки: клик по тулбару уводит фокус,
    // поэтому фокусируем редактор уже после него
    await expandCanvas(editable);

    // смена ширины могла перерисовать документ — берём абзац заново
    paragraph = findLinkParagraph(editable, job) || paragraph;

    editable.focus();

    log('удаление абзаца со ссылкой');
    const removed = await deleteParagraph(editable, paragraph);
    if (!removed) return { code: 'NO_DELETE' };

    log('«Опубликовать»');
    const publish = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll(SEL.publishButton)).filter(visible)[0];
      return btn || null;
    }, { timeout: 20000, code: 'NO_PUBLISH', detail: 'кнопка «Опубликовать» не найдена' });

    // жмём именно текст кнопки, чтобы не открыть выбор процесса согласования
    click(publish.querySelector('.m-button-basic__text') || publish);

    await passWizard(job);
    return { code: 'OK' };
  }

  async function viewPhase(job) {
    log('открытие режима правки');
    const editButton = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll(SEL.editButton)).filter(visible)[0];
      return btn || null;
    }, { timeout: 30000, code: 'NO_EDIT', detail: 'кнопка «Изменить» не найдена' });

    click(editButton);

    // если правка открывается без перезагрузки — продолжаем здесь,
    // если с перезагрузкой — работу подхватит новый экземпляр скрипта
    await waitFor(getEditable, { timeout: 45000, code: 'NO_CANVAS', detail: 'редактор не открылся' });
    return editPhase(job);
  }

  async function main() {
    let job = null;
    try {
      job = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    } catch (e) {
      return; // расширение не ждёт эту вкладку
    }
    if (!job) return;
    currentJob = job;

    let outcome;
    try {
      outcome = getEditable() ? await editPhase(job) : await viewPhase(job);
    } catch (error) {
      outcome = {
        code: error instanceof StepError ? error.code : 'UNKNOWN',
        detail: error && (error.detail || error.message)
      };
    }

    try {
      await chrome.runtime.sendMessage({
        type: 'RESULT',
        code: outcome.code,
        detail: outcome.detail || ''
      });
    } catch (e) {/* вкладка уже закрывается */}
  }

  main();
})();
