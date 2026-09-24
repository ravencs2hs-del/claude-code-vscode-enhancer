// Behaviour checks for the webview against the preview page's mock host. Open a fresh
// test/preview.html (no parameters) and run `await checks()` in the console; it returns one
// PASS/FAIL line per check. The checks change the mock data, so reload before running again.
/* global host */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const ids = (sel) => $$(sel).map((e) => e.dataset.id);
  const shown = () => ids('.row.session');
  const active = () => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined);
  const group = (id) => host.state.groups.find((g) => g.id === id);
  const last = (type) => host.log.filter((m) => m.type === type).pop();

  async function until(fn, what, timeout = 5000) {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what ? `${what}: ` : ''}expected ${b}, got ${a}`);
  }

  function key(k, extra) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra)));
  }

  function type(input, k) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }

  function search(q) {
    const input = $('#search');
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function scroll(top) {
    const tree = $('#tree');
    tree.scrollTop = top;
    tree.dispatchEvent(new Event('scroll'));
  }

  function point(el, where) {
    const r = el.getBoundingClientRect();
    const y = where === 'top' ? r.top + 3 : where === 'bottom' ? r.bottom - 3 : r.top + r.height / 2;
    return { clientX: r.left + 40, clientY: y };
  }

  async function startDrag(src) {
    const dataTransfer = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    await until(() => document.body.classList.contains('is-dragging'), 'drag visuals');
    return dataTransfer;
  }

  function over(el, where, dataTransfer) {
    el.dispatchEvent(new DragEvent('dragover', Object.assign({ bubbles: true, cancelable: true, dataTransfer }, point(el, where))));
  }

  async function dragTo(src, dst, where) {
    const dataTransfer = await startDrag(src);
    const el = dst();
    const at = Object.assign({ bubbles: true, cancelable: true, dataTransfer }, point(el, where));
    el.dispatchEvent(new DragEvent('dragover', at));
    el.dispatchEvent(new DragEvent('drop', at));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  }

  window.checks = async function checks() {
    const results = [];
    const check = async (name, fn) => {
      try {
        await fn();
        results.push(`PASS  ${name}`);
      } catch (e) {
        results.push(`FAIL  ${name}: ${(e && e.message) || e}`);
      }
    };
    await until(() => $('.row.header[data-id="g-docs"]'), 'first render');

    await check('initial rows', () => {
      eq(ids('.row.header[data-kind="group"]'), ['g-docs', 'g-test', 'g-idea']);
      eq(shown(), ['s1', 's2', 's3', 's5', 's6', 's7', 's8']);
      eq([last('rendered').groups, last('rendered').sessions], [3, 7], 'rendered counts');
      eq($('.row.header[data-id="g-idea"]').getAttribute('aria-expanded'), 'false');
      eq(!!$('.row.header.add') && !!$('.sep') && !!$('.row.header.ungrouped'), true, 'add row, separator, ungrouped');
    });

    await check('texts come from the host (English here)', () => {
      eq([$('#search').placeholder, $('#newSession .label').textContent, $('#tree').getAttribute('aria-label')], ['Search…', 'New session', 'Claude Code groups']);
      eq($('.row.header.ungrouped .name').textContent, 'Ungrouped');
      eq($('.row.session[data-id="s5"] .time').textContent, 'now', 'relative time');
      eq(document.documentElement.lang, 'en');
    });

    await check('account and usage limits on top', async () => {
      await until(() => !$('.account').hidden, 'header');
      eq([$('.account .uname').textContent, $('.account .plan').textContent], ['Alex Kim', 'Max']);
      eq($$('.limits .lname').map((e) => e.textContent), ['5-hour', 'Weekly']);
      eq($$('.limits .pct').map((e) => e.textContent), ['42%', '18%']);
      eq($('.limits .fill').style.width, '42%');
    });

    await check('the account and the limits can be hidden', async () => {
      Object.assign(host.state.settings, { account: false });
      host.post();
      await until(() => !$('.account .who') && $('.limits'), 'only the limits');
      Object.assign(host.state.settings, { limits: false });
      host.post();
      await until(() => $('.account').hidden, 'no header');
      Object.assign(host.state.settings, { account: true, limits: true });
      host.post();
      await until(() => !$('.account').hidden && $('.account .who'), 'back');
    });

    await check('active sessions: dots, and the filter keeps their groups', () => {
      eq($('.row.session[data-id="s1"] .meta').classList.contains('is-busy'), true, 'busy: pulsing dot');
      eq($('.row.session[data-id="s6"] .meta').classList.contains('is-open'), true, 'open: ring');
      eq($('.active-filter .n').textContent, '3', 'busy, open and just changed');
      $('.active-filter').click();
      eq($('.active-filter').getAttribute('aria-pressed'), 'true');
      eq(shown().sort(), ['s1', 's5', 's6']);
      eq(ids('.row.header[data-kind="group"]'), ['g-docs'], 'only groups with active sessions');
      $('.active-filter').click();
      eq(shown().length, 7, 'all again');
    });

    await check('rows are stacked without gaps or overlaps', () => {
      const rows = $$('.vlist > *');
      for (let i = 1; i < rows.length; i++) {
        eq(rows[i].offsetTop, rows[i - 1].offsetTop + rows[i - 1].offsetHeight + (rows[i].classList.contains('dropzone') ? 4 : 0), `row ${i}`);
      }
      eq($('.vlist').offsetHeight, rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight, 'list height');
    });

    await check('group colours and tree connectors', () => {
      const header = $('.row.header[data-id="g-test"]');
      eq(header.classList.contains('colored') && !!header.style.getPropertyValue('--group-color'), true, 'header');
      eq($('.row.session[data-id="s3"]').style.getPropertyValue('--line').includes('charts-green'), true, 'session line');
      eq(ids('.row.session.last'), ['s2', 's3', 's8']);
    });

    await check('collapse and expand by click', async () => {
      $('.row.header[data-id="g-docs"]').click();
      eq(shown().includes('s1'), false, 'optimistic');
      await until(() => group('g-docs').collapsed, 'host to collapse');
      await sleep(50);
      eq(shown().includes('s1'), false, 'after the answer');
      $('.row.header[data-id="g-docs"]').click();
      await until(() => shown().includes('s1') && !group('g-docs').collapsed, 'expand');
    });

    await check('keyboard navigation', async () => {
      $('.row.header[data-id="g-docs"]').focus();
      key('ArrowDown');
      eq(active(), 's:s1');
      key('ArrowDown');
      eq(active(), 's:s2');
      key('ArrowDown');
      eq(active(), 'g:g-test');
      key('ArrowLeft');
      eq($('.row.header[data-id="g-test"]').getAttribute('aria-expanded'), 'false', 'collapsed');
      eq(active(), 'g:g-test', 'focus kept');
      key('ArrowRight');
      eq($('.row.header[data-id="g-test"]').getAttribute('aria-expanded'), 'true', 'expanded');
      key('ArrowRight');
      eq(active(), 's:s3');
      key('ArrowLeft');
      eq(active(), 'g:g-test');
      key('End');
      eq(active(), 's:s8');
      key('Home');
      eq(active(), 'g:g-docs');
      eq($$('.row[tabindex="0"]').length, 1, 'one tab stop');
      await until(() => !group('g-test').collapsed, 'host');
    });

    await check('selection: click, shift+arrow, ctrl+a, escape', async () => {
      $('.row.session[data-id="s1"]').click();
      eq(last('open').id, 's1', 'single click opens');
      key('ArrowDown', { shiftKey: true });
      eq(ids('.row.session.selected'), ['s1', 's2']);
      key('a', { ctrlKey: true });
      eq(ids('.row.session.selected').length, 7);
      key('Escape');
      eq(ids('.row.session.selected'), []);
      eq(last('selection').ids, []);
    });

    await check('search filters, highlights and reports no match', () => {
      search('weather');
      eq(shown(), ['s4']);
      eq($('.row.session[data-id="s4"] mark').textContent, 'Weather');
      eq($('.note').hidden, true);
      search('idea');
      eq(ids('.row.header[data-kind="group"]'), ['g-idea'], 'group name match');
      search('zzzz');
      eq([$('.note').hidden, shown()], [false, []]);
      search('');
      eq(shown().length, 7);
    });

    await check('rename with F2', async () => {
      $('.row.header[data-id="g-test"]').focus();
      key('F2');
      const input = await until(() => $('.row.header[data-id="g-test"] .name-input'), 'rename input');
      await until(() => document.activeElement === input, 'input focus');
      input.value = 'Test suite';
      type(input, 'Enter');
      eq($('.row.header[data-id="g-test"] .name').textContent, 'Test suite');
      eq(active(), 'g:g-test', 'focus back on the group');
      await until(() => group('g-test').name === 'Test suite', 'host rename');
    });

    await check('new group: Escape cancels, Enter creates', async () => {
      $('.row.header.add').click();
      let input = await until(() => $('.creating .name-input'), 'create input');
      await until(() => document.activeElement === input, 'input focus');
      type(input, 'Escape');
      eq([!!$('.creating'), active()], [false, 'add']);
      $('.row.header.add').click();
      input = await until(() => $('.creating .name-input'), 'create input again');
      await until(() => document.activeElement === input, 'input focus again');
      input.value = 'Fourth';
      type(input, 'Enter');
      const id = (await until(() => host.state.groups.find((g) => g.name === 'Fourth'), 'host create')).id;
      await until(() => active() === `g:${id}`, 'focus on the new group');
    });

    await check('Delete takes a session out of its group', async () => {
      $('.row.session[data-id="s3"]').focus();
      key('Delete');
      eq($('.row.session[data-id="s3"]').dataset.group, '', 'optimistic');
      await until(() => !group('g-test').sessionIds.includes('s3'), 'host');
    });

    await check('Alt+arrows move a group', async () => {
      $('.row.header[data-id="g-docs"]').focus();
      key('ArrowDown', { altKey: true });
      eq(ids('.row.header[data-kind="group"]').slice(0, 2), ['g-test', 'g-docs']);
      eq(active(), 'g:g-docs', 'focus follows');
      await until(() => host.state.groups[1].id === 'g-docs', 'host move');
      key('ArrowUp', { altKey: true });
      await until(() => host.state.groups[0].id === 'g-docs' && ids('.row.header[data-kind="group"]')[0] === 'g-docs', 'move back');
    });

    await check('drag feedback: dragged rows, drop line, group frame', async () => {
      const src = $('.row.session[data-id="s8"]');
      const dataTransfer = await startDrag(src);
      eq(src.classList.contains('drag-source'), true, 'source dimmed');
      eq(!!$('.dropzone') && !$('.row.header.add'), true, 'drop zone replaces the add row');
      const header = $('.row.header[data-id="g-docs"]');
      over(header, 'middle', dataTransfer);
      eq([$('.drop-overlay').style.display, header.classList.contains('drop-into')], ['block', true], 'group frame');
      const s1 = $('.row.session[data-id="s1"]');
      over(s1, 'top', dataTransfer);
      eq($('.drop-indicator').style.display, 'block', 'drop line');
      eq(Math.round(parseFloat($('.drop-indicator').style.top)), $('.vlist').offsetTop + s1.offsetTop - 1, 'drop line position');
      eq($('.drop-overlay').style.display, 'none', 'frame hidden');
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      eq([document.body.classList.contains('is-dragging'), !!$('.dropzone'), !!$('.row.header.add')], [false, false, true], 'cleaned up');
    });

    await check('drag a session before another one', async () => {
      await dragTo($('.row.session[data-id="s5"]'), () => $('.row.session[data-id="s1"]'), 'top');
      eq(ids('.row.session[data-group="g-docs"]'), ['s5', 's1', 's2'], 'optimistic');
      await until(() => group('g-docs').sessionIds.join() === 's5,s1,s2', 'host');
    });

    await check('drag a session onto a group, then back to "Ungrouped"', async () => {
      await dragTo($('.row.session[data-id="s6"]'), () => $('.row.header[data-id="g-test"]'));
      await until(() => group('g-test').sessionIds.includes('s6'), 'into the group');
      await dragTo($('.row.session[data-id="s6"]'), () => $('.row.header.ungrouped'));
      await until(() => !host.state.groups.some((g) => g.sessionIds.includes('s6')), 'out of the group');
    });

    await check('drag a group above another one', async () => {
      await dragTo($('.row.header[data-id="g-idea"]'), () => $('.row.header[data-id="g-docs"]'), 'top');
      eq(ids('.row.header[data-kind="group"]')[0], 'g-idea', 'optimistic');
      await until(() => host.state.groups[0].id === 'g-idea', 'host');
    });

    await check('the drop zone starts a new group with the dragged sessions', async () => {
      await dragTo($('.row.session[data-id="s7"]'), () => $('.dropzone'));
      const input = await until(() => $('.creating .name-input'), 'create input');
      eq($('.creating .count').textContent, '1');
      await until(() => document.activeElement === input, 'input focus');
      type(input, 'Escape');
      eq(!!$('.creating'), false);
    });

    await check('pending new session row', async () => {
      host.state.pendingGroupId = 'g-test';
      host.post();
      const row = await until(() => $('.placeholder.pending'), 'pending row');
      row.click();
      await until(() => !$('.placeholder.pending'), 'cancel');
    });

    await check('session updates arrive as changes', async () => {
      const s1 = host.state.sessions.find((s) => s.id === 's1');
      $('.row.session[data-id="s2"]').click();
      window.postMessage({ type: 'sessions', upsert: [Object.assign({}, s1, { title: 'Renamed', mtime: Date.now() })], remove: ['s2'] }, '*');
      await until(() => $('.row.session[data-id="s1"] .title').textContent === 'Renamed', 'title update');
      eq(!!$('.row.session[data-id="s2"]'), false, 'removed');
      eq(last('selection').ids, [], 'selection pruned');
      window.postMessage({ type: 'sessions', upsert: [{ id: 'n1', title: 'Fresh session', mtime: Date.now() }] }, '*');
      await until(() => $('.row.session[data-id="n1"]'), 'new session');
      window.postMessage({ type: 'sessions', full: host.state.sessions }, '*');
      await until(() => $('.row.session[data-id="s2"]') && !$('.row.session[data-id="n1"]'), 'full list');
    });

    await check('settings: numbers, ungrouped on top, hidden', async () => {
      const settings = host.state.settings;
      Object.assign(settings, { prefix: 'number', ungrouped: 'top' });
      host.post();
      await until(() => $('.row.session[data-id="s1"] .prefix').textContent === '2.', 'numbered');
      eq($('.vlist').firstElementChild.dataset.key, 'u', 'ungrouped first');
      eq(!!$('.sep.after'), true, 'separator below');
      settings.ungrouped = 'hidden';
      host.post();
      await until(() => !$('.row.header.ungrouped') && !$('.sep'), 'hidden');
      Object.assign(settings, { prefix: 'tree', ungrouped: 'bottom' });
      host.post();
      await until(() => $('.row.header.ungrouped'), 'back');
    });

    // Subgroups. Webshop (blue) › Backend › Database (red), with sessions on every level.
    const nested = (id) => $(`.row.header[data-id="${id}"]`);
    const keys = () => $$('.vlist > .row').map((e) => e.dataset.key);
    const pad = (el) => getComputedStyle(el).paddingLeft;
    host.state.groups = [
      { id: 'n-a', name: 'Webshop', color: 'blue', collapsed: false, parentId: null, sessionIds: ['s1'] },
      { id: 'n-b', name: 'Backend', color: null, collapsed: false, parentId: 'n-a', sessionIds: ['s2', 's3'] },
      { id: 'n-c', name: 'Database', color: 'red', collapsed: false, parentId: 'n-b', sessionIds: ['s4'] },
    ];
    host.post();
    await until(() => nested('n-c'), 'nested state');
    $('#tree').scrollTop = 0;

    await check('subgroups: order, indentation, levels and counts', () => {
      eq(keys().slice(0, 7), ['g:n-a', 'g:n-b', 'g:n-c', 's:s4', 's:s2', 's:s3', 's:s1'], 'subgroups first, then sessions');
      eq([pad(nested('n-a')), pad(nested('n-b')), pad(nested('n-c'))], ['4px', '24px', '44px'], 'header indentation');
      eq([pad($('.row.session[data-id="s1"]')), pad($('.row.session[data-id="s2"]')), pad($('.row.session[data-id="s4"]'))], ['24px', '44px', '64px'], 'session indentation');
      eq(['n-a', 'n-b', 'n-c'].map((id) => nested(id).getAttribute('aria-level')), ['1', '2', '3']);
      eq($('.row.session[data-id="s4"]').getAttribute('aria-level'), '4');
      eq(['n-a', 'n-b', 'n-c'].map((id) => nested(id).querySelector('.count').textContent), ['4', '3', '1'], 'counts include subgroups');
    });

    await check('subgroups: guide lines and inherited colour', () => {
      eq(nested('n-b').style.getPropertyValue('--group-color').includes('charts-blue'), true, 'inherits the parent colour');
      eq(nested('n-c').style.getPropertyValue('--group-color').includes('charts-red'), true, 'own colour wins');
      eq([nested('n-b').classList.contains('last'), $('.row.session[data-id="s1"]').classList.contains('last')], [false, true], '├ and └');
      const s4 = $('.row.session[data-id="s4"]');
      eq($$('.row.session[data-id="s4"] .oguide').map((g) => g.className), ['oguide', 'oguide'], 'lines of both outer levels go on');
      eq(s4.style.getPropertyValue('--line').includes('charts-red'), true, 'own line in the group colour');
    });

    await check('subgroups: arrows, Alt+← and Alt+→', async () => {
      nested('n-c').click();
      eq(!!$('.row.session[data-id="s4"]'), false, 'collapsed');
      key('ArrowLeft');
      eq(active(), 'g:n-b', '← on a closed subgroup goes to its parent');
      nested('n-c').focus();
      key('ArrowLeft', { altKey: true });
      eq(keys().slice(0, 6), ['g:n-a', 'g:n-b', 's:s2', 's:s3', 'g:n-c', 's:s1'], 'out of Backend, right after it');
      eq(active(), 'g:n-c', 'focus follows');
      await until(() => group('n-c').parentId === 'n-a', 'host: out');
      key('ArrowRight', { altKey: true });
      eq(keys().slice(0, 5), ['g:n-a', 'g:n-b', 'g:n-c', 's:s2', 's:s3'], 'back into Backend, first because subgroups come first');
      await until(() => group('n-c').parentId === 'n-b', 'host: in');
      nested('n-c').click();
      await until(() => $('.row.session[data-id="s4"]') && !group('n-c').collapsed, 'open again');
    });

    await check('subgroups: drag a group into another one and back out', async () => {
      await dragTo(nested('n-c'), () => nested('n-a'), 'middle');
      await until(() => group('n-c').parentId === 'n-a', 'into Webshop');
      eq(keys().slice(0, 4), ['g:n-a', 'g:n-b', 's:s2', 's:s3'], 'Backend keeps its place');
      eq(keys().includes('g:n-c') && keys().indexOf('g:n-c') < keys().indexOf('s:s1'), true, 'last subgroup of Webshop');
      await dragTo(nested('n-c'), () => nested('n-a'), 'top');
      await until(() => group('n-c').parentId === null && host.state.groups.filter((g) => !g.parentId)[0].id === 'n-c', 'top level, first');
      await dragTo(nested('n-c'), () => nested('n-b'), 'middle');
      await until(() => group('n-c').parentId === 'n-b', 'back into Backend');
    });

    await check('subgroups: a group cannot go into its own subgroup', async () => {
      const src = nested('n-a');
      const dataTransfer = await startDrag(src);
      eq($$('.vlist > .drag-source').length >= 7, true, 'the whole subtree is dimmed');
      over(nested('n-c'), 'middle', dataTransfer);
      eq([$('.drop-overlay').style.display, $('.drop-indicator').style.display], ['none', 'none'], 'no target');
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    });

    await check('subgroups: new subgroup with the folder button', async () => {
      nested('n-b').querySelector('button[data-action="folder"]').click();
      const input = await until(() => $('.creating.nested .name-input'), 'create input');
      eq($('.creating').style.getPropertyValue('--lvl'), '1', 'at the level of Backend’s items');
      await until(() => document.activeElement === input, 'input focus');
      input.value = 'Cache';
      type(input, 'Enter');
      const sub = await until(() => host.state.groups.find((g) => g.name === 'Cache'), 'host create');
      eq(sub.parentId, 'n-b');
      await until(() => nested(sub.id) && keys().indexOf(`g:${sub.id}`) === keys().indexOf('g:n-c') + 2, 'after Database and its session');
    });

    await check('subgroups: search shows the path to a match', () => {
      search('weather');
      eq(keys(), ['g:n-a', 'g:n-b', 'g:n-c', 's:s4']);
      search('backend');
      eq(keys().includes('s:s4') && keys().includes('s:s2') && !keys().includes('s:s1'), true, 'a matching group shows all inside it');
      search('');
    });

    await check('subgroups: deleting a group deletes its subgroups', async () => {
      nested('n-b').querySelector('button[data-action="trash"]').click();
      await until(() => !nested('n-b') && !nested('n-c'), 'gone');
      eq(host.state.groups.map((g) => g.id), ['n-a']);
      eq(['s2', 's3', 's4'].every((id) => $(`.row.session[data-id="${id}"]`).dataset.group === ''), true, 'sessions ungrouped');
    });

    // Many rows: only the visible ones are in the DOM, the rest appear on scroll.
    const many = [];
    for (let i = 0; i < 2000; i++) many.push({ id: `m${i}`, title: `Session ${i}`, mtime: Date.now() - i * 60000 });
    host.state.groups.push({ id: 'g-many', name: 'Big group', color: 'blue', collapsed: false, sessionIds: many.slice(0, 1950).map((s) => s.id) });
    host.state.sessions = host.state.sessions.concat(many);
    host.post();
    await until(() => $('.row.header[data-id="g-many"]'), 'big state');

    await check('virtualized: few elements, rows appear on scroll', () => {
      eq($$('.vlist > *').length < 120, true, `${$$('.vlist > *').length} elements`);
      const tree = $('#tree');
      scroll(tree.scrollHeight);
      eq(!!$('.row.more'), true, 'more row at the bottom');
      eq($$('.vlist > *').length < 120, true, 'still few elements');
      $('.row.more').click();
      scroll(tree.scrollHeight);
      eq(!!$('.row.session[data-id="s8"]') || !!$('.row.session[data-id="m1999"]'), true, 'last rows after "more"');
      scroll(0);
      eq(!!$(`.row.header[data-id="${host.state.groups[0].id}"]`), true, 'top rows again');
    });

    await check('virtualized: the focused row survives scrolling', () => {
      const s1 = $('.row.session[data-id="s1"]');
      let next = s1.nextElementSibling;
      while (next && !next.classList.contains('row')) next = next.nextElementSibling;
      s1.focus();
      s1.click();
      scroll($('#tree').scrollHeight);
      eq([active(), !!$('.row.session[data-id="s1"]')], ['s:s1', true]);
      key('ArrowDown');
      eq(active(), next.dataset.key, 'navigation continues');
      key('End');
      const tree = $('#tree');
      const row = document.activeElement.getBoundingClientRect();
      const box = tree.getBoundingClientRect();
      eq(row.bottom <= box.bottom + 1 && row.top >= box.top - 1, true, 'End scrolls the last row into view');
    });

    await check('virtualized: arrow keys scroll the list', () => {
      key('Home');
      for (let i = 0; i < 60; i++) key('ArrowDown');
      const row = document.activeElement.getBoundingClientRect();
      const box = $('#tree').getBoundingClientRect();
      eq(row.bottom <= box.bottom + 1 && row.top >= box.top - 1, true, 'focused row visible');
    });

    await check('no webview errors', () => eq(host.log.filter((m) => m.type === 'error'), []));
    return results.join('\n');
  };
})();
