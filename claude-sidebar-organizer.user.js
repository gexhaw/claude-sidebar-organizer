// ==UserScript==
// @name         Claude Sidebar Organizer
// @namespace    https://github.com/gexhaw/claude-sidebar-organizer
// @version      1.6.2
// @description  Color labels, sorting, groups and notes for Claude.ai chat history
// @author       gexhaw
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/gexhaw/claude-sidebar-organizer
// @supportURL   https://github.com/gexhaw/claude-sidebar-organizer/issues
// @updateURL    https://raw.githubusercontent.com/gexhaw/claude-sidebar-organizer/main/claude-sidebar-organizer.user.js
// @downloadURL  https://raw.githubusercontent.com/gexhaw/claude-sidebar-organizer/main/claude-sidebar-organizer.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Design rule: never move, insert or remove nodes that React owns.
  // Sidebar changes are made only through data-* attributes and style.order,
  // which keeps React intact and cannot retrigger the childList observer.

  const STORAGE_KEY = 'cso_data';
  // Chat links: claude.ai chats (/chat/<uuid>) and sessions (/session_<id>)
  const CHAT_LINK = 'a[href*="/chat/"], a[href*="/session_"]';
  // Spectrum order — also the order used by "By color" sorting
  const COLORS = [
    { id: 'red',    name: 'Red',    hex: '#e57373' },
    { id: 'orange', name: 'Orange', hex: '#ffa726' },
    { id: 'yellow', name: 'Yellow', hex: '#fdd835' },
    { id: 'green',  name: 'Green',  hex: '#66bb6a' },
    { id: 'teal',   name: 'Teal',   hex: '#26a69a' },
    { id: 'blue',   name: 'Blue',   hex: '#42a5f5' },
    { id: 'purple', name: 'Purple', hex: '#ab47bc' },
    { id: 'pink',   name: 'Pink',   hex: '#ec407a' },
    { id: 'brown',  name: 'Brown',  hex: '#a1887f' },
    { id: 'gray',   name: 'Gray',   hex: '#90a4ae' },
  ];
  const COLOR_IDS = COLORS.map(c => c.id);
  // Presets removed in earlier versions → the preset that replaces them
  const LEGACY = { lime: 'green', cyan: 'teal', indigo: 'blue' };
  const HEX_RE = /^#[0-9a-f]{6}$/;

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Closest preset to a "#rrggbb" — migrates custom colors from 1.5.0–1.6.1
  function nearestPreset(hex) {
    const [r, g, b] = rgb(hex);
    let best = null;
    let bestD = Infinity;
    COLORS.forEach(c => {
      const [r2, g2, b2] = rgb(c.hex);
      const dist = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (dist < bestD) { bestD = dist; best = c.id; }
    });
    return best;
  }

  // Always returns a preset id or null
  function normColor(c) {
    if (typeof c !== 'string') return null;
    if (COLOR_IDS.includes(c)) return c;
    if (LEGACY[c]) return LEGACY[c];
    const h = c.toLowerCase();
    return HEX_RE.test(h) ? nearestPreset(h) : null;
  }

  const NOTE_MAX = 1000;
  const SORTS = ['default', 'name_asc', 'name_desc', 'color'];
  const SORT_LABELS = { default: 'Default', name_asc: 'A → Z', name_desc: 'Z → A', color: 'By color' };

  // ─── Storage ──────────────────────────────────────────────────────────────
  function getData() {
    let d;
    try { d = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { d = {}; }
    d.meta = Object.assign({ sort: 'default', groups: [] }, d.meta);
    if (!SORTS.includes(d.meta.sort)) d.meta.sort = 'default';
    if (!Array.isArray(d.meta.groups)) d.meta.groups = [];
    d.chats = d.chats && typeof d.chats === 'object' ? d.chats : {};
    return d;
  }

  function setData(d) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch (e) { /* storage full or blocked */ }
    scheduleApply(0);
  }

  function setChat(id, patch) {
    const d = getData();
    d.chats[id] = Object.assign({}, d.chats[id], patch);
    setData(d);
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    (children || []).forEach(c => c && n.appendChild(c));
    return n;
  }

  function setAttr(node, name, value) {
    if (value == null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) {
      node.setAttribute(name, value);
    }
  }

  function setOrder(node, value) {
    if (node.style.order !== value) node.style.order = value;
  }

  function chatIdOf(a) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/chat\/([a-f0-9-]{8,})/i) || href.match(/\/(session_[A-Za-z0-9]{8,})/);
    return m ? m[1] : null;
  }

  function isOwn(node) {
    return !!(node.closest && node.closest('#cso-menu, #cso-toolbar, #cso-tip'));
  }

  // Sidebar chats, plus the main area when it is a chat list (the Recents page).
  // Inside an open conversation the main area has few or no chat links, so it is skipped.
  const LIST_MIN = 3;
  function getLinks() {
    const all = Array.from(document.querySelectorAll(CHAT_LINK)).filter(a => !isOwn(a));
    const inMain = all.filter(a => a.closest('main'));
    const outside = all.filter(a => !a.closest('main'));
    const inNav = outside.filter(a => a.closest('nav'));
    const side = inNav.length ? inNav : outside;
    return inMain.length >= LIST_MIN ? side.concat(inMain) : side;
  }

  // First visible text inside the link — the chat title without timestamps or badges
  function titleOf(a) {
    const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim();
      if (t) return t;
    }
    return (a.textContent || '').trim();
  }

  function hasChatLink(node) {
    return node.nodeType === 1 && (node.matches(CHAT_LINK) || !!node.querySelector(CHAT_LINK));
  }

  // The element that is a direct child of the chat list container
  function itemOf(a) {
    const li = a.closest('li');
    if (li) return li;
    let node = a;
    while (
      node.parentElement &&
      node.parentElement !== document.body &&
      node.parentElement.querySelectorAll(CHAT_LINK).length < 2
    ) node = node.parentElement;
    return node;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('cso-styles')) return;
    const colorRules = COLORS.map(c => `a[data-cso-color="${c.id}"]{--cso-c:${c.hex}}`).join('\n');
    const style = el('style', { id: 'cso-styles' });
    style.textContent = `
      [data-cso-list]{display:flex!important;flex-direction:column!important}
      a[data-cso-color]{
        background-color:color-mix(in srgb,var(--cso-c) 28%,transparent)!important;
        box-shadow:inset 3px 0 0 var(--cso-c)!important
      }
      a[data-cso-color]:hover{background-color:color-mix(in srgb,var(--cso-c) 40%,transparent)!important}
      ${colorRules}
      [data-cso-header]{flex-wrap:wrap!important}
      [data-cso-header]::before{
        content:attr(data-cso-header);display:block;flex:0 0 100%;width:100%;box-sizing:border-box;
        padding:10px 8px 4px;font-size:10px;font-weight:600;letter-spacing:.08em;
        text-transform:uppercase;opacity:.55;pointer-events:none
      }

      #cso-toolbar{
        position:fixed;left:12px;bottom:76px;z-index:2147483000;display:flex;align-items:center;gap:6px;
        padding:5px;border-radius:12px;background:#2b2a27;border:1px solid rgba(255,255,255,.12);
        box-shadow:0 4px 16px rgba(0,0,0,.3);font:14px/1.2 system-ui,sans-serif;color:#eee
      }
      #cso-toolbar .cso-btn{padding:7px 12px;border-radius:8px}
      .cso-handle{
        padding:6px 4px;cursor:grab;opacity:.5;font-size:16px;line-height:1;
        touch-action:none;user-select:none;-webkit-user-select:none
      }
      .cso-handle:hover{opacity:.9}
      .cso-handle:active{cursor:grabbing}
      nav a[href*="/chat/"]{-webkit-touch-callout:none}
      @media (pointer:coarse){
        #cso-toolbar .cso-btn{padding:9px 14px}
        .cso-handle{padding:8px 6px;font-size:18px}
        .cso-swatch{width:30px;height:30px}
        .cso-swatches{gap:9px}
        .cso-item{padding:10px}
        .cso-mini{padding:5px 10px}
      }
      #cso-menu{
        position:fixed;z-index:2147483001;min-width:226px;max-width:240px;padding:8px;border-radius:10px;
        background:#2b2a27;border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 32px rgba(0,0,0,.45);
        font:12px/1.3 system-ui,sans-serif;color:#eee
      }
      .cso-btn{
        font:inherit;padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);
        background:rgba(255,255,255,.06);color:inherit;cursor:pointer;white-space:nowrap
      }
      .cso-btn:hover{background:rgba(255,255,255,.14)}
      .cso-primary{background:rgba(99,102,241,.35);border-color:rgba(99,102,241,.6)}
      .cso-primary:hover{background:rgba(99,102,241,.55)}
      .cso-title{font-size:11px;opacity:.55;padding:0 4px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cso-label{font-size:10px;opacity:.45;padding:6px 4px 3px;text-transform:uppercase;letter-spacing:.06em}
      .cso-swatches{display:flex;flex-wrap:wrap;gap:6px;padding:2px 4px 6px}
      .cso-swatch{width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid transparent;box-sizing:border-box;transition:transform .1s}
      .cso-swatch:hover{transform:scale(1.15)}
      .cso-swatch.active{border-color:#fff}
      .cso-swatch-none{background:transparent;border:2px dashed rgba(255,255,255,.35)}
      .cso-swatch-none.active{border-style:solid;border-color:#fff}
      .cso-list{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow-y:auto}
      .cso-item{padding:5px 8px;border-radius:6px;cursor:pointer}
      .cso-item:hover{background:rgba(255,255,255,.08)}
      .cso-item.active{background:rgba(255,255,255,.14)}
      .cso-row{display:flex;align-items:center;gap:4px;padding:3px 4px 3px 8px;border-radius:6px}
      .cso-row:hover{background:rgba(255,255,255,.06)}
      .cso-row-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cso-mini{font:inherit;padding:1px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.15);background:transparent;color:inherit;cursor:pointer}
      .cso-mini:hover{background:rgba(255,255,255,.12)}
      .cso-hint{opacity:.45;padding:4px 8px;font-size:11px}
      .cso-input{
        width:100%;box-sizing:border-box;margin-top:6px;padding:5px 8px;border-radius:6px;
        border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:inherit;font:inherit;outline:none
      }
      .cso-input:focus{border-color:rgba(255,255,255,.35)}
      .cso-btnrow{display:flex;gap:4px;margin-top:6px}
      .cso-note-input{
        display:block;width:100%;box-sizing:border-box;min-height:56px;max-height:160px;resize:vertical;
        margin:2px 0 0;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);
        background:rgba(255,255,255,.06);color:inherit;font:inherit;line-height:1.4;outline:none
      }
      .cso-note-input:focus{border-color:rgba(255,255,255,.35)}
      a[data-cso-note]{position:relative}
      a[data-cso-note]::after{
        content:'';position:absolute;top:0;right:0;width:0;height:0;pointer-events:none;
        border-style:solid;border-width:0 11px 11px 0;border-color:transparent #f5c542 transparent transparent;
        border-top-right-radius:4px
      }
      #cso-tip{
        position:fixed;z-index:2147483002;display:none;max-width:280px;padding:8px 10px;border-radius:8px;
        background:#2b2a27;border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 20px rgba(0,0,0,.35);
        font:12.5px/1.45 system-ui,sans-serif;color:#eee;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none
      }
      .cso-btnrow .cso-btn{flex:1}
    `;
    document.head.appendChild(style);
  }

  // ─── Apply to sidebar ─────────────────────────────────────────────────────
  function apply() {
    const d = getData();
    const links = getLinks();
    const groups = d.meta.groups;
    const groupRank = g => {
      const i = groups.indexOf(g);
      return i === -1 ? groups.length : i;
    };
    const colorRank = c => {
      const i = COLOR_IDS.indexOf(c);
      return i === -1 ? COLOR_IDS.length : i; // uncolored last
    };

    // Collect chats per list container (Starred, Recents, etc. stay separate)
    const lists = new Map();
    links.forEach(a => {
      const id = chatIdOf(a);
      if (!id) return;
      const item = itemOf(a);
      const parent = item.parentElement;
      if (!parent) return;
      if (!lists.has(parent)) lists.set(parent, []);
      const entries = lists.get(parent);
      const meta = d.chats[id] || {};
      entries.push({
        a, item, id,
        idx: entries.length,
        title: titleOf(a).toLowerCase(),
        color: normColor(meta.color),
        group: groups.includes(meta.group) ? meta.group : '',
        note: typeof meta.note === 'string' && meta.note.trim() !== '',
      });
    });

    lists.forEach((entries, parent) => {
      entries.forEach(e => {
        setAttr(e.a, 'data-cso-color', e.color);
        setAttr(e.a, 'data-cso-note', e.note ? '' : null);
      });

      const hasGroups = entries.some(e => e.group);
      const active = d.meta.sort !== 'default' || hasGroups;

      if (!active) {
        setAttr(parent, 'data-cso-list', null);
        entries.forEach(e => {
          setOrder(e.item, '');
          setAttr(e.item, 'data-cso-header', null);
        });
        return;
      }

      const sorted = entries.slice().sort((x, y) => {
        const g = groupRank(x.group) - groupRank(y.group);
        if (g) return g;
        switch (d.meta.sort) {
          case 'name_asc':  return x.title.localeCompare(y.title) || x.idx - y.idx;
          case 'name_desc': return y.title.localeCompare(x.title) || x.idx - y.idx;
          case 'color':     return colorRank(x.color) - colorRank(y.color) || x.idx - y.idx;
          default:          return x.idx - y.idx;
        }
      });

      setAttr(parent, 'data-cso-list', '');
      let prev = null;
      sorted.forEach((e, i) => {
        setOrder(e.item, String(i));
        let header = null;
        if (hasGroups && e.group !== prev) header = e.group || 'Other';
        prev = e.group;
        setAttr(e.item, 'data-cso-header', header);
      });
    });

    updateToolbar(d, links.length > 0);
  }

  let scheduled = null;
  function scheduleApply(delay) {
    if (delay === undefined) delay = 300;
    if (scheduled) {
      if (delay !== 0) return;
      clearTimeout(scheduled);
    }
    scheduled = setTimeout(() => {
      scheduled = null;
      try { apply(); } catch (e) { console.warn('[Claude Sidebar Organizer]', e); }
    }, delay);
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────────
  function buildToolbar() {
    if (document.getElementById('cso-toolbar')) return;
    const sortBtn = el('button', {
      id: 'cso-sort', class: 'cso-btn', type: 'button', title: 'Sort chats',
      onclick: () => {
        const d = getData();
        d.meta.sort = SORTS[(SORTS.indexOf(d.meta.sort) + 1) % SORTS.length];
        setData(d);
      },
    });
    const groupBtn = el('button', {
      class: 'cso-btn', type: 'button', text: '⊞ Groups', title: 'Manage groups',
      onclick: e => openGroupManager(e.currentTarget),
    });
    const handle = el('div', { class: 'cso-handle', title: 'Drag to move', text: '⠿' });
    const bar = el('div', { id: 'cso-toolbar', style: 'display:none' }, [handle, sortBtn, groupBtn]);
    document.body.appendChild(bar);
    makeDraggable(bar, handle);
  }

  // ─── Toolbar position (draggable, remembered) ─────────────────────────────
  const POS_KEY = 'cso_toolbar_pos';
  let posRestored = false;

  function setBarPos(bar, x, y) {
    const r = bar.getBoundingClientRect();
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    bar.style.left = nx + 'px';
    bar.style.top = ny + 'px';
    bar.style.bottom = 'auto';
  }

  function restoreBarPos(bar) {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) { /* ignore */ }
    if (p && typeof p.x === 'number' && typeof p.y === 'number') setBarPos(bar, p.x, p.y);
  }

  function makeDraggable(bar, handle) {
    let start = null;
    handle.addEventListener('pointerdown', e => {
      const r = bar.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (start) setBarPos(bar, e.clientX - start.dx, e.clientY - start.dy);
    });
    const end = () => {
      if (!start) return;
      start = null;
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: parseFloat(bar.style.left), y: parseFloat(bar.style.top) }));
      } catch (e) { /* ignore */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => {
      if (bar.style.top) setBarPos(bar, parseFloat(bar.style.left), parseFloat(bar.style.top));
    });
  }

  function updateToolbar(d, visible) {
    const bar = document.getElementById('cso-toolbar');
    if (!bar) { buildToolbar(); return; }
    const display = visible ? 'flex' : 'none';
    if (bar.style.display !== display) bar.style.display = display;
    if (visible && !posRestored) { posRestored = true; restoreBarPos(bar); }
    const btn = document.getElementById('cso-sort');
    const label = '↕ ' + SORT_LABELS[d.meta.sort];
    if (btn && btn.textContent !== label) btn.textContent = label;
  }

  // ─── Menus ────────────────────────────────────────────────────────────────
  let activeMenu = null;

  function closeMenu() {
    hideTip();
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  function placeMenu(menu, x, y, above) {
    hideTip();
    document.body.appendChild(menu);
    activeMenu = menu;
    const r = menu.getBoundingClientRect();
    if (above) y = y - r.height - 6;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  function openChatMenu(x, y, id, title) {
    closeMenu();
    const d = getData();
    const meta = d.chats[id] || {};
    const pick = patch => { setChat(id, patch); closeMenu(); };
    const current = normColor(meta.color);

    const swatches = [
      el('div', { class: 'cso-swatch cso-swatch-none' + (!current ? ' active' : ''), title: 'No color', onclick: () => pick({ color: null }) }),
    ].concat(COLORS.map(c => el('div', {
      class: 'cso-swatch' + (current === c.id ? ' active' : ''),
      title: c.name, style: 'background:' + c.hex,
      onclick: () => pick({ color: c.id }),
    })));

    const groupItems = [
      el('div', { class: 'cso-item' + (!meta.group ? ' active' : ''), text: '— None', onclick: () => pick({ group: '' }) }),
    ].concat(d.meta.groups.map(g => el('div', {
      class: 'cso-item' + (meta.group === g ? ' active' : ''), text: g,
      onclick: () => pick({ group: g }),
    })));
    if (!d.meta.groups.length) groupItems.push(el('div', { class: 'cso-hint', text: 'Create groups with ⊞ Groups' }));

    const note = el('textarea', {
      class: 'cso-note-input', placeholder: 'Add a note…', maxlength: String(NOTE_MAX), rows: '3',
    });
    note.value = meta.note || '';
    note.addEventListener('input', () => setChat(id, { note: note.value.trim() ? note.value : '' }));
    note.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) closeMenu();
    });

    const menu = el('div', { id: 'cso-menu' }, [
      el('div', { class: 'cso-title', text: title || 'Chat' }),
      el('div', { class: 'cso-label', text: 'Color' }),
      el('div', { class: 'cso-swatches' }, swatches),
      el('div', { class: 'cso-label', text: 'Group' }),
      el('div', { class: 'cso-list' }, groupItems),
      el('div', { class: 'cso-label', text: 'Note' }),
      note,
    ]);
    placeMenu(menu, x, y, false);
  }

  // ─── Note tooltip ─────────────────────────────────────────────────────────
  let tip = null;
  let tipTimer = null;
  let tipFor = null;

  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    tipFor = null;
    if (tip && tip.style.display !== 'none') tip.style.display = 'none';
  }

  function showTip(a, text) {
    if (!tip) {
      tip = el('div', { id: 'cso-tip', role: 'tooltip' });
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.display = 'block';
    const r = a.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let x = r.right + 8;
    let y = r.top;
    if (x + t.width > window.innerWidth - 8) { x = r.left; y = r.bottom + 6; }
    tip.style.left = Math.max(8, Math.min(x, window.innerWidth - t.width - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(y, window.innerHeight - t.height - 8)) + 'px';
  }

  document.addEventListener('mouseover', e => {
    const a = e.target.closest && e.target.closest(CHAT_LINK);
    if (a && a === tipFor) return;
    hideTip();
    if (!a || activeMenu || !a.hasAttribute('data-cso-note')) return;
    const text = (getData().chats[chatIdOf(a)] || {}).note;
    if (!text) return;
    tipFor = a;
    tipTimer = setTimeout(() => showTip(a, text), 250);
  }, true);

  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);

  function openGroupManager(anchor) {
    closeMenu();
    const list = el('div', { class: 'cso-list' });
    const input = el('input', { class: 'cso-input', placeholder: 'New group name…', maxlength: '40' });

    function render() {
      list.textContent = '';
      const d = getData();
      if (!d.meta.groups.length) list.appendChild(el('div', { class: 'cso-hint', text: 'No groups yet' }));
      d.meta.groups.forEach((g, i) => {
        list.appendChild(el('div', { class: 'cso-row' }, [
          el('span', { class: 'cso-row-name', text: g, title: g }),
          el('button', {
            class: 'cso-mini', type: 'button', text: '↑', title: 'Move up',
            onclick: () => {
              if (i === 0) return;
              const d2 = getData();
              const gs = d2.meta.groups;
              [gs[i - 1], gs[i]] = [gs[i], gs[i - 1]];
              setData(d2);
              render();
            },
          }),
          el('button', {
            class: 'cso-mini', type: 'button', text: '✕', title: 'Delete group',
            onclick: () => {
              const d2 = getData();
              d2.meta.groups = d2.meta.groups.filter(x => x !== g);
              Object.values(d2.chats).forEach(c => { if (c.group === g) c.group = ''; });
              setData(d2);
              render();
            },
          }),
        ]));
      });
    }

    function add() {
      const name = input.value.trim();
      if (!name) return;
      const d = getData();
      if (!d.meta.groups.includes(name)) {
        d.meta.groups.push(name);
        setData(d);
      }
      input.value = '';
      render();
      input.focus();
    }

    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') add();
      if (e.key === 'Escape') closeMenu();
    });

    const menu = el('div', { id: 'cso-menu' }, [
      el('div', { class: 'cso-title', text: 'Groups' }),
      list,
      input,
      el('div', { class: 'cso-btnrow' }, [
        el('button', { class: 'cso-btn cso-primary', type: 'button', text: 'Add', onclick: add }),
        el('button', { class: 'cso-btn', type: 'button', text: 'Done', onclick: closeMenu }),
      ]),
    ]);
    render();
    const r = anchor.getBoundingClientRect();
    placeMenu(menu, r.left, r.top, true);
    input.focus();
  }

  // ─── Events ───────────────────────────────────────────────────────────────
  function chatLinkFrom(target) {
    const a = target && target.closest && target.closest(CHAT_LINK);
    if (!a || isOwn(a) || !chatIdOf(a) || !getLinks().includes(a)) return null;
    return a;
  }

  document.addEventListener('contextmenu', e => {
    if (e.shiftKey) return; // Shift + right-click keeps the native browser menu
    const a = chatLinkFrom(e.target);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    openChatMenu(e.clientX, e.clientY, chatIdOf(a), titleOf(a));
  }, true);

  // Long press on touch screens opens the same menu
  let press = null;
  let suppressClickUntil = 0;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

  document.addEventListener('touchstart', e => {
    cancelPress();
    if (e.touches.length !== 1) return;
    const a = chatLinkFrom(e.target);
    if (!a) return;
    const t = e.touches[0];
    const p = { x: t.clientX, y: t.clientY, fired: false };
    p.timer = setTimeout(() => {
      p.fired = true;
      suppressClickUntil = Date.now() + 800;
      openChatMenu(p.x, p.y, chatIdOf(a), titleOf(a));
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
    press = p;
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', e => {
    if (!press) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) cancelPress();
  }, { capture: true, passive: true });

  document.addEventListener('touchend', e => {
    if (press && press.fired) e.preventDefault(); // stop the tap from opening the chat
    cancelPress();
  }, { capture: true, passive: false });

  document.addEventListener('touchcancel', cancelPress, true);

  document.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil && chatLinkFrom(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  document.addEventListener('mousedown', e => {
    if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  }, true);

  window.addEventListener('resize', closeMenu);
  window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) scheduleApply(0); });

  // ─── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildToolbar();
    scheduleApply(0);
    new MutationObserver(mutations => {
      // Ignore changes inside the chat itself (streaming replies) and our own UI
      // Inside <main> (streaming replies, Recents rows) only react when chat links are added
      const relevant = mutations.some(m => {
        const t = m.target;
        if (t.nodeType !== 1 || isOwn(t)) return false;
        if (!t.closest('main')) return true;
        return Array.prototype.some.call(m.addedNodes, hasChatLink);
      });
      if (relevant) scheduleApply();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
