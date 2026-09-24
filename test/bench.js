// Performance probe for the preview page. Open test/preview.html?stress=80x40+400 and run
// `await bench()` in the console. Every step is timed synchronously, including the style
// and layout work it causes (paint is not included).
/* global host */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $tree = () => document.getElementById('tree');

  function settle() {
    return $tree().scrollHeight + document.body.offsetHeight;
  }

  function time(fn) {
    const t0 = performance.now();
    fn();
    settle();
    return performance.now() - t0;
  }

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null;
  }

  function stateMessage() {
    return JSON.parse(JSON.stringify(Object.assign({ type: 'state', ack: 1e9 }, host.state)));
  }

  function deliver(msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }

  function key(el, k, extra) {
    el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra)));
  }

  window.bench = async function bench(rounds = 7) {
    const out = {};
    const tree = $tree();
    tree.scrollTop = 0;
    deliver(stateMessage());
    await sleep(50);

    // A full state from the extension (every group/session operation ends with one).
    const full = [];
    for (let i = 0; i < rounds; i++) {
      const msg = stateMessage();
      full.push(time(() => deliver(msg)));
      await sleep(10);
    }
    out.fullState = median(full);

    // One session's transcript changed (happens every few hundred ms while Claude works).
    const tick = [];
    for (let i = 0; i < rounds; i++) {
      host.state.sessions[i].mtime = Date.now() - i * 1000;
      const msg = stateMessage();
      tick.push(time(() => deliver(msg)));
      await sleep(10);
    }
    out.sessionChanged = median(tick);

    // Collapse and expand a group by clicking its header (the optimistic render only). An even
    // number of clicks leaves it open; the mock host's answers are awaited (timers of a hidden
    // page are throttled, so they can come late).
    const toggles = [];
    const opsBefore = host.log.filter((m) => Number.isInteger(m.seq)).length;
    for (let i = 0; i < rounds + (rounds % 2); i++) {
      const header = tree.querySelector('.row.header[data-kind="group"]');
      toggles.push(time(() => header.click()));
      await sleep(40);
    }
    out.toggleGroup = median(toggles);
    const opsSent = host.log.filter((m) => Number.isInteger(m.seq)).length - opsBefore;
    for (let waited = 0; host.ack < opsSent + opsBefore && waited < 5000; waited += 50) await sleep(50);
    await sleep(50);

    // Typing into the search box, one keystroke at a time.
    const search = document.getElementById('search');
    const typing = [];
    for (const q of ['k', 'ko', 'kos', 'kosá', 'kosár', 'kosá', 'kos', 'ko', 'k', '']) {
      search.value = q;
      typing.push(time(() => search.dispatchEvent(new Event('input', { bubbles: true }))));
      await sleep(10);
    }
    out.searchKeystroke = median(typing);

    // Clicking sessions (selects and opens them).
    const clicks = [];
    for (let i = 0; i < rounds; i++) {
      const rows = tree.querySelectorAll('.row.session');
      const row = rows[Math.min(rows.length - 1, 3 + i * 2)];
      clicks.push(time(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))));
      await sleep(10);
    }
    out.clickSession = median(clicks);

    // Arrow keys through the list.
    const first = tree.querySelector('.row.session');
    first.focus();
    const arrows = [];
    for (let i = 0; i < 30; i++) {
      const focused = document.activeElement;
      arrows.push(time(() => key(focused, 'ArrowDown')));
    }
    out.arrowDown = median(arrows);

    // Dragging a session over other rows.
    const source = tree.querySelector('.row.session');
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(20);
    const over = [];
    const box = tree.getBoundingClientRect();
    for (let i = 0; i < 40; i++) {
      const y = box.top + 30 + ((i * 37) % Math.max(40, box.height - 60));
      const target = document.elementFromPoint(box.left + 60, y) || tree;
      over.push(time(() => target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 60, clientY: y }))));
    }
    out.dragOver = median(over);
    out.dragEnd = Math.round(time(() => document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))) * 10) / 10;
    await sleep(40);

    out.sessions = host.state.sessions.length;
    out.groups = host.state.groups.length;
    out.domNodes = document.getElementsByTagName('*').length;
    return out;
  };
})();
