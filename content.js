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

  async function deleteParagraph(editable, p) {
    const selection = window.getSelection();
    const prev = p.previousElementSibling;
    const next = p.nextElementSibling;

    editable.focus();
    const range = document.createRange();

    if (prev) {
      // от конца предыдущего блока до конца удаляемого — уходит и сам разрыв абзаца
      range.selectNodeContents(prev);
      range.collapse(false);
      const tail = document.createRange();
      tail.selectNodeContents(p);
      tail.collapse(false);
      range.setEnd(tail.endContainer, tail.endOffset);
    } else if (next) {
      range.selectNodeContents(p);
      range.collapse(true);
      const head = document.createRange();
      head.selectNodeContents(next);
      head.collapse(true);
      range.setEnd(head.startContainer, head.startOffset);
    } else {
      range.selectNodeContents(p);
    }

    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(150); // даём ProseMirror синхронизировать выделение

    try { document.execCommand('delete'); } catch (e) {}
    await sleep(350);

    if (findLinkParagraph(editable, currentJob)) {
      // запасной путь: событие удаления, затем прямое удаление узла
      try {
        editable.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
        }));
      } catch (e) {}
      await sleep(200);
      const still = findLinkParagraph(editable, currentJob);
      if (still) {
        still.remove();
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        await sleep(400);
      }
    }

    return !findLinkParagraph(editable, currentJob);
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
    editable.focus();

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
