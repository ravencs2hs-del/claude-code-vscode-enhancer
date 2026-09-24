// Captures the README screenshots from the preview page (open test/preview.html?demo=1 and
// run captureAll() in the console). html-to-image renders through the browser itself, and
// test/serve.js stores each PNG in docs/.
/* global host, htmlToImage */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);

  function loadLib() {
    if (window.htmlToImage) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
  }

  async function save(name, height) {
    const el = document.documentElement;
    const png = await htmlToImage.toPng(el, {
      pixelRatio: 2,
      width: Math.ceil(document.body.getBoundingClientRect().width),
      height,
      backgroundColor: '#181818',
    });
    const r = await fetch(`/save?name=${name}`, { method: 'POST', body: png });
    return `${name}: ${await r.text()}`;
  }

  function contentHeight() {
    const page = document.documentElement.getBoundingClientRect().top;
    return Math.ceil($('#tree .vlist').getBoundingClientRect().bottom - page + 14);
  }

  async function startDrag(src, dst, where) {
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(60);
    const r = dst.getBoundingClientRect();
    const y = where === 'top' ? r.top + 3 : r.top + r.height / 2;
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 40, clientY: y }));
    return dt;
  }

  async function endDrag(dt) {
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await sleep(60);
  }

  window.captureAll = async function captureAll() {
    await loadLib();
    // Tall enough that nothing scrolls; each image is cropped to the content.
    document.documentElement.style.setProperty('--preview-height', '1200px');
    window.scrollTo(0, 0);
    await sleep(100);
    const out = [];
    const header = (id) => $(`.row.header[data-id="${id}"]`);

    // 1. Overview, with the hover actions of one group visible (a cloned page has no :hover).
    const hover = document.createElement('style');
    hover.textContent = '.row.header[data-id="g-back"] { background: var(--vscode-list-hoverBackground); } .row.header[data-id="g-back"] .actions { display: flex; }';
    document.head.append(hover);
    await sleep(100);
    out.push(await save('overview.png', contentHeight()));
    hover.remove();

    // 2. Dragging "Bugfixek" above "Webshop frontend".
    let dt = await startDrag(header('g-bugs'), header('g-front'), 'top');
    await sleep(60);
    out.push(await save('drag-group.png', contentHeight()));
    await endDrag(dt);

    // 3. Dragging a session: drop line inside a group and the "new group" drop zone.
    dt = await startDrag($('.row.session[data-id="d11"]'), $('.row.session[data-id="d5"]'), 'top');
    await sleep(60);
    out.push(await save('drag-session.png', contentHeight()));
    await endDrag(dt);
    const row = $('.row.session[data-id="d11"]');
    row.focus({ preventScroll: true });
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    row.blur();

    // 4. New session in a group (waiting for the first message).
    host.state.pendingGroupId = 'g-bugs';
    host.post();
    await sleep(250);
    out.push(await save('new-session.png', contentHeight()));
    host.state.pendingGroupId = null;
    host.post();
    document.documentElement.style.removeProperty('--preview-height');
    return out.join('\n');
  };
})();
