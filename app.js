'use strict';

const APP_VERSION = '1.0.0';
const STATE_KEY = 'state';
const MIN_SESSIONS_FOR_DATE = 10;
const STREAK_GAP_DAYS = 4;
const BACKUP_EVERY = 10;

/* =========================================================
   Storage: IndexedDB with localStorage fallback
   ========================================================= */
const Store = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open('violin', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function get(key) {
    try {
      const db = await open();
      return await new Promise((res, rej) => {
        const r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) {
      try { const v = localStorage.getItem('violin:' + key); return v ? JSON.parse(v) : undefined; } catch (_) { return undefined; }
    }
  }
  async function set(key, value) {
    try {
      const db = await open();
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) {
      try { localStorage.setItem('violin:' + key, JSON.stringify(value)); } catch (_) { toast('Не удалось сохранить данные'); }
    }
  }
  return { get, set };
})();

/* =========================================================
   State
   ========================================================= */
let P = null;          // program
let S = null;          // user state
const KB = {};         // loaded knowledge base docs
const KB_TITLES = { '01': 'Инструмент', '02': 'Постановка и звук', '03': 'Нотная грамота и интонация', '04': 'Репертуар и журнал' };

function defaultState() {
  return {
    app: 'violin', schema: 1,
    createdAt: Date.now(),
    seq: 0,
    sessions: [],
    lessons: {},
    materials: {},
    userMaterials: [],
    ui: { collapsed: {}, libKind: 'all', libStatus: 'all' },
    meta: { lastExportCount: 0, lastExportAt: null, programVersion: null },
  };
}

function normalizeState(s) {
  const d = defaultState();
  const out = Object.assign(d, s || {});
  out.ui = Object.assign(defaultState().ui, out.ui || {});
  out.meta = Object.assign(defaultState().meta, out.meta || {});
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  out.userMaterials = Array.isArray(out.userMaterials) ? out.userMaterials : [];
  return out;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Store.set(STATE_KEY, S), 60);
}

function L(id) { return P.lessons.find(l => l.id === id); }
function T(id) { return P.themes.find(t => t.id === id); }
function themeLessons(themeId) { return P.lessons.filter(l => l.themeId === themeId); }
function ls(id) { return S.lessons[id] || (S.lessons[id] = {}); }
function lsPeek(id) { return S.lessons[id] || {}; }
function isDone(id) { return !!lsPeek(id).done; }
function planned(l) { const v = lsPeek(l.id).planned; return typeof v === 'number' ? v : l.plannedSessions; }

/* ---------- Derived data, recomputed per render ---------- */
let D = null;
function derive() {
  const actual = {};
  const sessionsByLesson = {};
  const sorted = [...S.sessions].sort((a, b) => a.ts - b.ts);
  sorted.forEach((s, i) => {
    s._no = i + 1;
    const w = s.short ? 0.5 : 1;
    (s.lessonIds || []).forEach(id => {
      actual[id] = (actual[id] || 0) + w;
      (sessionsByLesson[id] = sessionsByLesson[id] || []).push(s);
    });
  });
  const status = {};
  const themeOpen = {};
  P.themes.forEach(t => { themeOpen[t.id] = !t.opensAfter || isDone(t.opensAfter); });
  P.themes.forEach(t => {
    const list = themeLessons(t.id);
    list.forEach((l, i) => {
      let st;
      if (isDone(l.id)) st = 'done';
      else if (!themeOpen[t.id]) st = 'locked';
      else if (i === 0) st = 'open';
      else {
        const prev = list[i - 1];
        if (isDone(prev.id)) st = 'open';
        else if (l.openWithPrevious && status[prev.id] !== 'locked') st = 'open';
        else st = 'locked';
      }
      if (st === 'open') {
        const tp = taskProgress(l);
        st = ((actual[l.id] || 0) > 0 || tp.done > 0) ? 'progress' : 'available';
      }
      status[l.id] = st;
    });
  });
  const total = sorted.reduce((a, s) => a + (s.short ? 0.5 : 1), 0);
  D = { actual, status, themeOpen, sorted, sessionsByLesson, total, count: sorted.length };
  return D;
}

function actual(id) { return D.actual[id] || 0; }
function status(id) { return D.status[id]; }
function isOpen(id) { const s = status(id); return s === 'available' || s === 'progress'; }

function taskProgress(l) {
  const st = lsPeek(l.id).tasks || {};
  const req = l.tasks.filter(t => !t.optional);
  return { done: req.filter(t => st[t.id]).length, total: req.length };
}

function mainThemes() { return P.themes.filter(t => !t.parallel).sort((a, b) => a.order - b.order); }
function parallelThemes() { return P.themes.filter(t => t.parallel).sort((a, b) => a.order - b.order); }

function openPractice(themes) {
  const out = [];
  themes.forEach(t => themeLessons(t.id).forEach(l => { if (l.type !== 'theory' && isOpen(l.id)) out.push(l); }));
  return out;
}
function heroLesson() { return openPractice(mainThemes())[0] || openPractice(parallelThemes())[0] || null; }

/* ---------- Streaks ---------- */
function dayIndex(ts) { const d = new Date(ts); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000); }
function streaks() {
  const days = [...new Set(D.sorted.map(s => dayIndex(s.ts)))].sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  days.forEach(d => { run = (prev !== null && d - prev <= STREAK_GAP_DAYS) ? run + 1 : 1; best = Math.max(best, run); prev = d; });
  const today = dayIndex(Date.now());
  const current = (prev !== null && today - prev <= STREAK_GAP_DAYS) ? run : 0;
  return { current, best };
}

/* ---------- Forecast ---------- */
function lessonRemaining(l) {
  if (isDone(l.id) || l.type === 'theory') return 0;
  return Math.max(planned(l) - actual(l.id), 1);
}
function chainTo(lessonId) {
  // sessions left until lessonId is closed, following its theme and the lesson that opens the theme
  const l = L(lessonId); if (!l) return 0;
  const t = T(l.themeId);
  let sum = 0;
  for (const x of themeLessons(t.id)) {
    if (!x.openWithPrevious) sum += lessonRemaining(x);
    if (x.id === lessonId) break;
  }
  if (!D.themeOpen[t.id] && t.opensAfter) sum += chainTo(t.opensAfter);
  return sum;
}
function mainLineTo(lessonId) {
  // main line without theme A, which runs alongside theme B
  let sum = 0;
  for (const t of mainThemes()) {
    if (t.id === 'A') continue;
    for (const x of themeLessons(t.id)) {
      if (!x.openWithPrevious) sum += lessonRemaining(x);
      if (x.id === lessonId) return sum;
    }
  }
  return sum;
}
function goalRemaining(g) {
  if (isDone(g.lessonId)) return 0;
  const a = chainTo(g.lessonId);
  const b = g.requires ? mainLineTo(g.requires) : 0;
  return Math.ceil(Math.max(a, b));
}
function pace() {
  const last = D.sorted.slice(-20);
  if (D.count < MIN_SESSIONS_FOR_DATE || last.length < 2) return null;
  const w = last.reduce((a, s) => a + (s.short ? 0.5 : 1), 0);
  const days = Math.max((last[last.length - 1].ts - last[0].ts) / 86400000, 7);
  return w / days;
}
function forecastDate(remaining) {
  const p = pace();
  if (!p || remaining <= 0) return null;
  return new Date(Date.now() + (remaining / p) * 86400000);
}

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
function num(v) { return (Math.round(v * 10) / 10).toLocaleString('ru-RU'); }
function plural(n, one, few, many) {
  const a = Math.abs(Math.floor(n)); const m10 = a % 10, m100 = a % 100;
  if (!Number.isInteger(n)) return few;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function zan(n) { return `${num(n)} ${plural(n, 'занятие', 'занятия', 'занятий')}`; }
const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
function dateLabel(ts) {
  const d = new Date(ts); const today = dayIndex(Date.now()); const di = dayIndex(ts);
  const day = di === today ? 'Сегодня' : di === today - 1 ? 'Вчера' : fmtDay.format(d);
  return `${day}, ${fmtTime.format(d)}`;
}
function monthLabel(d) { return fmtMonth.format(d).replace(' г.', ''); }
function lessonLabel(l) { return /^\d+$/.test(l.id) ? `Урок ${l.id}` : l.id; }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* =========================================================
   Icons
   ========================================================= */
const I = {
  star: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 2.8l2.75 5.72 6.3.84-4.6 4.37 1.15 6.24L12 16.95 6.4 19.97l1.15-6.24-4.6-4.37 6.3-.84z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z" fill="currentColor" fill-opacity=".25"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" stroke-linecap="round"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z" fill="currentColor" fill-opacity=".22"/><path d="M4 20.5A2.5 2.5 0 006.5 23H20v-5" stroke-linecap="round"/></svg>',
  log: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="currentColor" fill-opacity=".22"/><path d="M8 12.2l2.8 2.8L16.5 9" stroke-linecap="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5" fill="currentColor" fill-opacity=".25"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#5a5b62" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2.5" fill="#5a5b62" fill-opacity=".25"/><path d="M8 11V8a4 4 0 018 0v3" stroke-linecap="round"/></svg>',
  checkMini: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1-1"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6" stroke-linecap="round"/></svg>',
};
function kindIcon(kind) {
  const c = { sheet: '#8fb8ff', video: '#ef8a8a', audio: '#c49bf0', article: '#9d9ea5', backing: '#86d3dc' }[kind] || '#9d9ea5';
  const g = {
    sheet: '<path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="16" r="2.5" fill="currentColor"/>',
    video: '<rect x="3" y="6" width="18" height="12" rx="3" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 9.5l4 2.5-4 2.5z" fill="currentColor"/>',
    audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    article: '<path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 12h6M9 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    backing: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
  }[kind] || '';
  return `<svg viewBox="0 0 24 24" width="21" height="21" style="color:${c}">${g}</svg>`;
}
function pie(frac, color = 'var(--blue)', size = 20) {
  const r = size / 2 - 1.5, cx = size / 2;
  const f = Math.max(0, Math.min(1, frac));
  let sector = '';
  if (f >= 0.999) sector = `<circle cx="${cx}" cy="${cx}" r="${r - 2.4}" fill="${color}"/>`;
  else if (f > 0) {
    const rr = r - 2.4; const a = f * 2 * Math.PI - Math.PI / 2;
    const x = cx + rr * Math.cos(a), y = cx + rr * Math.sin(a);
    sector = `<path d="M${cx} ${cx}L${cx} ${cx - rr}A${rr} ${rr} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z" fill="${color}"/>`;
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="1.6"/>${sector}</svg>`;
}
function statusIcon(l) {
  const st = status(l.id);
  if (st === 'done') return `<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="9" fill="var(--blue)"/><path d="M5.6 10.4l3 3 5.8-6.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (st === 'locked') return I.lock;
  if (l.type === 'theory') {
    const c = st === 'progress' ? 'var(--blue)' : '#6d6e75';
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 20.5A2.5 2.5 0 006.5 23H20v-5" stroke-linecap="round"/></svg>`;
  }
  if (st === 'available') return pie(0, '#6d6e75');
  const tp = taskProgress(l);
  const f = Math.max(tp.total ? tp.done / tp.total : 0, Math.min(actual(l.id) / Math.max(planned(l), 1), 1) * 0.5, 0.12);
  return pie(f);
}

/* =========================================================
   Markdown (small subset)
   ========================================================= */
function md(src) {
  const lines = String(src || '').split('\n');
  let html = '', para = [], list = null;
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const n = Math.min(m[1].length, 3); html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^\|/.test(line)) {
      flushPara(); flushList();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      i--;
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter(r => !/^\|[\s:|-]+\|$/.test(r));
      const [head, ...rest] = body;
      html += `<table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*[*-]\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if (/^```/.test(line)) { flushPara(); flushList(); let code = ''; i++; while (i < lines.length && !/^```/.test(lines[i])) { code += esc(lines[i]) + '\n'; i++; } html += `<pre>${code}</pre>`; continue; }
    flushList(); para.push(line.trim());
  }
  flushPara(); flushList();
  return html;
}

/* ---------- Knowledge base ---------- */
async function loadKB() {
  await Promise.all(Object.keys(KB_TITLES).map(async id => {
    try { const r = await fetch(`kb/${id}.md`); if (r.ok) KB[id] = await r.text(); } catch (_) {}
  }));
}
function kbHeadings(doc) {
  const src = KB[doc]; if (!src) return [];
  return src.split('\n').map((line, idx) => {
    const m = line.match(/^(#{2,3})\s+(\d+(?:\.\d+)?)\.?\s+(.*)$/);
    return m ? { idx, level: m[1].length, num: m[2], title: m[3] } : null;
  }).filter(Boolean);
}
function kbSection(doc, num) {
  const src = KB[doc]; if (!src) return null;
  const lines = src.split('\n');
  if (!num) return { title: KB_TITLES[doc], text: src };
  const hs = kbHeadings(doc);
  const h = hs.find(x => x.num === num); if (!h) return null;
  const next = hs.find(x => x.idx > h.idx && x.level <= h.level);
  return { title: `${h.num}. ${h.title}`, text: lines.slice(h.idx + 1, next ? next.idx : lines.length).join('\n') };
}
function kbRefTitle(ref) {
  const [doc, num] = ref.split('#');
  if (!num) return { doc, num: null, title: `Весь раздел`, docTitle: KB_TITLES[doc] };
  const s = kbSection(doc, num);
  return { doc, num, title: s ? s.title : `Пункт ${num}`, docTitle: KB_TITLES[doc] };
}

/* =========================================================
   Router
   ========================================================= */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').map(decodeURIComponent);
  return { name: parts[0] || 'today', args: parts.slice(1) };
}
function go(path) { location.hash = '#/' + path; }

let lastRouteKey = null;
function render() {
  if (!P || !S) return;
  derive();
  const r = route();
  const key = r.name + '/' + r.args.join('/');
  const keep = key === lastRouteKey;
  const y = window.scrollY;
  const view = $('#view');
  const views = { today: vToday, program: vProgram, lesson: vLesson, library: vLibrary, kb: vKB, journal: vJournal, progress: vProgress, settings: vSettings };
  view.innerHTML = (views[r.name] || vToday)(...r.args);
  renderTabbar(r.name);
  $('#fab').hidden = !['today', 'program', 'journal', 'lesson'].includes(r.name) || (r.name === 'lesson' && !(L(r.args[0]) && isOpen(r.args[0]) && L(r.args[0]).type !== 'theory'));
  if (keep) window.scrollTo(0, y); else window.scrollTo(0, 0);
  lastRouteKey = key;
}

function renderTabbar(active) {
  const map = { lesson: 'program', kb: 'library', settings: 'progress' };
  const a = map[active] || active;
  const tabs = [
    ['today', 'Сегодня', I.star, 'ic-today'],
    ['program', 'Программа', I.layers, 'ic-program'],
    ['library', 'Библиотека', I.book, 'ic-library'],
    ['journal', 'Журнал', I.log, 'ic-journal'],
    ['progress', 'Прогресс', I.flag, 'ic-progress'],
  ];
  $('#tabbar').innerHTML = tabs.map(([id, label, icon, cls]) =>
    `<a href="#/${id === 'today' ? '' : id}" class="${a === id ? 'on' : ''}"><span class="${cls}">${icon}</span>${label}</a>`).join('');
}

/* =========================================================
   Shared pieces
   ========================================================= */
function lessonRow(l, opts = {}) {
  const st = status(l.id);
  const tp = taskProgress(l);
  const meta = [];
  if (opts.showTheme) meta.push(`<span>${esc(T(l.themeId).title)}</span>`);
  if (st === 'locked') meta.push(`<span>${esc(lockReason(l))}</span>`);
  else if (l.type === 'theory') meta.push(`<span>Теория, вне 45 минут</span>`);
  else if (st !== 'done') {
    meta.push(`<span>${num(actual(l.id))} из ~${num(planned(l))} ${plural(planned(l), 'занятия', 'занятий', 'занятий')}</span>`);
    if (tp.total && tp.done) meta.push(`<span>задачи ${tp.done}/${tp.total}</span>`);
  } else {
    const c = lsPeek(l.id).closedAtSession;
    meta.push(`<span>пройден${c ? ` на занятии №${c}` : ''}</span>`);
  }
  const tags = [];
  if (l.milestoneId) { const m = P.milestones.find(x => x.id === l.milestoneId); tags.push(`<span class="tag ${isDone(l.id) ? 'yellow' : ''}">${esc(m.id)}</span>`); }
  if (st !== 'done' && l.type !== 'theory' && actual(l.id) >= 2 * planned(l)) tags.push(`<span class="tag orange">план ×2</span>`);
  return `<a class="row ${st === 'locked' ? 'locked' : ''} ${st === 'done' ? 'done' : ''}" href="#/lesson/${encodeURIComponent(l.id)}">
    <span class="row-icon">${statusIcon(l)}</span>
    <span class="row-body"><div class="row-title"><span class="code">${esc(l.id)}</span> ${esc(l.title)}</div><div class="row-meta">${meta.join('')}</div></span>
    <span class="row-end">${tags.join('')}</span></a>`;
}
function lockReason(l) {
  const t = T(l.themeId);
  if (!D.themeOpen[t.id] && t.opensAfter) return `откроется после урока ${t.opensAfter}`;
  const list = themeLessons(t.id); const i = list.indexOf(l);
  if (i > 0) return `после урока ${list[i - 1].id}`;
  return 'закрыт';
}
function gridPlan(l) {
  const g = P.grids[l.grid];
  if (!g || !g.blocks.length) return '';
  const total = g.blocks.reduce((a, b) => a + b[1], 0);
  const cls = n => /Техника/.test(n) ? 'k-tech' : /Репертуар/.test(n) ? 'k-rep' : '';
  return `<div class="grid-plan"><div class="gbar">${g.blocks.map(([n, m]) => `<div class="${cls(n)}" style="flex:${m}">${m}</div>`).join('')}</div>
    <div class="legend">${g.blocks.map(([n, m]) => `<span>${esc(n)} ${m}</span>`).join('')}<span class="faint">${total} мин · 2 паузы по минуте</span></div></div>`;
}
function milestoneState() {
  return P.milestones.map(m => { const g = P.goals.find(x => x.lessonId === m.lessonId); return { m, done: isDone(m.lessonId), at: lsPeek(m.lessonId).closedAtSession, left: g ? goalRemaining(g) : Math.ceil(chainTo(m.lessonId)) }; });
}
function topbar(backHref, backLabel, actions = '') {
  return `<div class="topbar"><a class="back" href="${backHref}">${I.back}${esc(backLabel)}</a><div class="actions">${actions}</div></div>`;
}

/* =========================================================
   Views
   ========================================================= */
function vToday() {
  const hero = heroLesson();
  const st = streaks();
  const closed = P.lessons.filter(l => isDone(l.id)).length;
  const nextNo = D.count + 1;
  let h = `<div class="page-title"><span class="glyph" style="color:var(--yellow)">${I.star}</span><h1>Сегодня</h1></div>
    <div class="page-sub">Занятие №${nextNo} · 45 минут</div>`;

  if (D.count === 0) {
    h += `<div class="info blue">Первое занятие: пройди осмотр инструмента в уроке 1, натри смычок канифолью, затем открой урок 4 и поставь корпус и скрипку перед зеркалом. В конце нажми синюю кнопку и запиши одну строку: что сделано и что не получилось.</div>`;
  }
  if (D.count - S.meta.lastExportCount >= BACKUP_EVERY) {
    h += `<a class="info" style="display:block" href="#/settings">С последней резервной копии прошло ${zan(D.count - S.meta.lastExportCount)}. Сохрани файл данных в настройках.</a>`;
  }

  if (hero) {
    const tp = taskProgress(hero);
    const t = T(hero.themeId);
    h += `<div class="hero">
      <div class="eyebrow">${I.star.replace('width="26" height="26"', 'width="13" height="13"')} Текущий урок · тема ${esc(t.id)}</div>
      <h3>${esc(lessonLabel(hero))}. ${esc(hero.title)}</h3>
      <p class="goal">${esc(hero.goal)}</p>
      <div class="stats">
        <div class="stat"><div class="v">${num(actual(hero.id))} <span class="faint" style="font-size:15px">из ~${num(planned(hero))}</span></div><div class="l">занятий по уроку</div></div>
        <div class="stat"><div class="v">${tp.done}<span class="faint" style="font-size:15px">/${tp.total}</span></div><div class="l">микрозадач</div></div>
      </div>
      <div class="bar" style="margin-bottom:16px"><i style="width:${tp.total ? Math.round(tp.done / tp.total * 100) : 0}%"></i></div>
      <div class="actions"><a class="btn secondary" style="flex:1" href="#/lesson/${encodeURIComponent(hero.id)}">Открыть урок</a><button class="btn primary" style="flex:1.3" data-action="session" data-lesson="${esc(hero.id)}">Занятие проведено</button></div>
      ${gridPlan(hero)}
    </div>`;
  } else {
    h += `<div class="hero"><h3>Все открытые уроки пройдены</h3><p class="goal">Следующие темы появятся после обновления программы.</p></div>`;
  }

  const ms = milestoneState().find(x => !x.done);
  if (ms) h += `<a class="ms-next" href="#/progress"><span class="ms-badge">${esc(ms.m.id)}</span><span style="flex:1;min-width:0"><div class="t">${esc(ms.m.displayTitle)}</div><div class="s">Ближайшая веха · примерно ${zan(ms.left)} · ${esc(lessonLabel(L(ms.m.lessonId)))}</div></span><span class="faint">${I.chev}</span></a>`;

  h += `<div class="counters"><div><div class="v">${num(D.total)}</div><div class="l">всего занятий</div></div><div><div class="v">${st.current}</div><div class="l">цепочка</div></div><div><div class="v">${closed}</div><div class="l">уроков пройдено</div></div></div>`;

  const others = openPractice(mainThemes()).filter(l => l !== hero);
  if (others.length) h += `<div class="section"><div class="section-head"><h2>Также в работе</h2></div>${others.map(l => lessonRow(l, { showTheme: true })).join('')}</div>`;
  const par = openPractice(parallelThemes()).filter(l => l !== hero);
  if (par.length) h += `<div class="section"><div class="section-head"><h2>Параллельные линии</h2><span class="meta">10 минут в занятии или вне его</span></div>${par.map(l => lessonRow(l, { showTheme: true })).join('')}</div>`;
  const theory = P.lessons.filter(l => l.type === 'theory' && isOpen(l.id));
  if (theory.length) h += `<div class="section"><div class="section-head"><h2>Почитать</h2><span class="meta">вне 45 минут</span></div>${theory.map(l => lessonRow(l)).join('')}</div>`;
  return h;
}

function vProgram() {
  const totalPlanned = P.lessons.filter(l => l.type !== 'theory').reduce((a, l) => a + planned(l), 0);
  let h = `<div class="page-title"><span class="glyph" style="color:var(--blue)">${I.layers}</span><h1>Программа</h1></div>
    <div class="page-sub">${P.lessons.length} ${plural(P.lessons.length, 'урок', 'урока', 'уроков')} · около ${zan(totalPlanned)} по плану</div>`;
  [...P.themes].sort((a, b) => a.order - b.order).forEach(t => {
    const list = themeLessons(t.id);
    const done = list.filter(l => isDone(l.id)).length;
    const act = list.reduce((a, l) => a + actual(l.id), 0);
    const frac = list.length ? done / list.length : 0;
    const collapsed = S.ui.collapsed[t.id] ?? ((list.length > 0 && done === list.length) || !D.themeOpen[t.id]);
    const open = D.themeOpen[t.id];
    const meta = t.draft ? 'будет расписана на следующем этапе'
      : `${done} из ${list.length} ${plural(list.length, 'урока', 'уроков', 'уроков')} · ${num(act)} из ~${num(t.plannedSessions)} занятий`;
    h += `<div class="theme-block"><button class="theme-head" data-action="toggle-theme" data-theme="${t.id}">
      <span class="row-icon">${open && !t.draft ? pie(frac) : pie(0, '#55565c')}</span>
      <span style="flex:1;min-width:0"><div class="tt">${esc(t.id)}. ${esc(t.title)}</div><div class="tm">${esc(meta)}</div></span>
      ${t.parallel ? '<span class="tag blue">параллельно</span>' : ''}
      ${!open && t.opensAfter ? `<span class="tag">после ${esc(t.opensAfter)}</span>` : ''}
      <span class="faint">${collapsed ? I.chev : I.chevDown}</span></button>`;
    if (!collapsed) {
      if (t.description && !t.draft) h += `<div class="small muted" style="padding:8px 0 2px">${esc(t.description)}</div>`;
      h += `<div class="lessons">${list.map(l => lessonRow(l)).join('') || '<div class="row"><span class="row-body muted small">Уроки появятся после проработки темы.</span></div>'}</div>`;
    }
    h += `</div>`;
  });
  return h;
}

function vLesson(id, tab = 'lesson') {
  const l = L(id);
  if (!l) return topbar('#/program', 'Программа') + `<div class="empty">Урок не найден</div>`;
  const t = T(l.themeId);
  const st = status(l.id);
  const stTag = { done: '<span class="tag green">пройден</span>', locked: '<span class="tag">закрыт</span>', progress: '<span class="tag blue">в работе</span>', available: '<span class="tag">доступен</span>' }[st];
  const wl = 'wakeLock' in navigator ? `<button class="icon-btn ${wakeLock ? 'on' : ''}" data-action="wakelock" aria-label="Не гасить экран">${I.sun}</button>` : '';
  let h = topbar('#/program', 'Программа', wl);
  h += `<div class="lesson-head"><div class="kicker"><span>${esc(lessonLabel(l))} · тема ${esc(t.id)}. ${esc(t.title)}</span>${stTag}</div>
    <h1>${esc(l.title)}</h1><p class="goal">${esc(l.goal)}</p></div>`;
  const tabs = [['lesson', 'Урок'], ['materials', 'Материалы'], ['theory', 'Теория'], ['stats', 'Статистика']];
  h += `<div class="seg">${tabs.map(([k, n]) => `<button class="${tab === k ? 'on' : ''}" data-action="lesson-tab" data-tab="${k}" data-lesson="${esc(l.id)}">${n}</button>`).join('')}</div>`;
  if (tab === 'materials') h += lessonMaterials(l);
  else if (tab === 'theory') h += lessonTheory(l);
  else if (tab === 'stats') h += lessonStats(l);
  else h += lessonMain(l);
  return h;
}

function lessonMain(l) {
  const st = status(l.id);
  const tasks = lsPeek(l.id).tasks || {};
  let h = '';
  if (st === 'locked') h += `<div class="info">Урок пока закрыт: ${esc(lockReason(l))}. Содержание можно прочитать заранее.</div>`;
  if (l.type === 'theory' && l.body) h += `<div class="prose" style="margin-top:14px">${md(l.body)}</div>`;
  const tp = taskProgress(l);
  h += `<div class="section"><div class="section-head"><h2>Микрозадачи</h2><span class="meta">${tp.done} из ${tp.total}</span></div>
    ${l.tasks.map(task => {
      const on = !!tasks[task.id];
      return `<button class="task ${on ? 'on' : ''}" data-action="task" data-lesson="${esc(l.id)}" data-task="${esc(task.id)}" ${st === 'locked' ? 'disabled' : ''}>
        <span class="check ${on ? 'on' : ''}">${I.checkMini}</span><span class="t">${inline(task.text)}${task.optional ? '<span class="opt">по желанию</span>' : ''}</span></button>`;
    }).join('')}</div>`;
  h += `<div class="section"><div class="note-box"><div class="h">Условие завершения</div>${inline(l.completionCriteria)}</div></div>`;
  if (l.type !== 'theory' && l.body) h += `<div class="section prose">${md(l.body)}</div>`;
  if (l.type !== 'theory') h += `<div class="section"><div class="section-head"><h2>Сетка занятия</h2></div>${gridPlan(l)}</div>`;
  if (st === 'done') {
    const c = lsPeek(l.id).closedAtSession;
    h += `<div class="section"><div class="info blue">Урок пройден${c ? ` на занятии №${c}` : ''}.</div><button class="btn ghost" style="margin-top:8px" data-action="reopen" data-lesson="${esc(l.id)}">Вернуть в работу</button></div>`;
  } else if (st !== 'locked') {
    h += `<div class="section" style="display:flex;gap:10px">`;
    if (l.type !== 'theory') h += `<button class="btn secondary" style="flex:1" data-action="session" data-lesson="${esc(l.id)}">Занятие проведено</button>`;
    h += `<button class="btn primary" style="flex:1" data-action="close-lesson" data-lesson="${esc(l.id)}">Урок пройден</button></div>`;
  }
  return h;
}

function materialsFor(lessonId) {
  const prog = P.materials.filter(m => (m.lessonIds || []).includes(lessonId)).map(mergedMaterial);
  const own = S.userMaterials.filter(m => (m.lessonIds || []).includes(lessonId));
  return [...prog, ...own];
}
function mergedMaterial(m) { return Object.assign({}, m, S.materials[m.id] || {}); }
function allMaterials() { return [...P.materials.map(mergedMaterial), ...S.userMaterials]; }
const KIND = { sheet: 'Ноты', video: 'Видео', audio: 'Аудио', article: 'Статья', backing: 'Минус, дрон' };
const MSTATUS = { wish: 'Хочу', in_progress: 'Учу', learned: 'Выучено' };
function materialRow(m) {
  const meta = [m.composer, m.source].filter(Boolean).map(esc);
  const st = m.status && m.status !== 'wish' ? `<span class="tag ${m.status === 'learned' ? 'green' : 'blue'}">${MSTATUS[m.status]}</span>` : '';
  const noUrl = !m.url ? '<span class="tag orange">нет ссылки</span>' : '';
  return `<button class="row" data-action="material" data-id="${esc(m.id)}"><span class="row-icon">${kindIcon(m.kind)}</span>
    <span class="row-body"><div class="row-title">${esc(m.title)}</div><div class="row-meta"><span>${KIND[m.kind] || ''}</span>${meta.map(x => `<span>${x}</span>`).join('')}</div></span>
    <span class="row-end">${noUrl}${st}</span></button>`;
}
function lessonMaterials(l) {
  const list = materialsFor(l.id);
  return `<div class="section"><div class="section-head"><h2>Материалы урока</h2><span class="meta">${list.length}</span></div>
    ${list.length ? list.map(materialRow).join('') : '<div class="empty" style="padding:24px 0">К уроку пока ничего не привязано</div>'}
    <button class="btn secondary block" style="margin-top:14px" data-action="add-material" data-lesson="${esc(l.id)}">${I.plus} Добавить материал</button></div>`;
}
function lessonTheory(l) {
  let h = '';
  if (l.type === 'theory') h += `<div class="prose" style="margin-top:14px">${md(l.body)}</div>`;
  const refs = l.kbLinks || [];
  h += `<div class="section"><div class="section-head"><h2>База знаний</h2><span class="meta">${refs.length}</span></div>`;
  h += refs.map(ref => {
    const r = kbRefTitle(ref);
    return `<a class="row" href="#/kb/${r.doc}${r.num ? '/' + r.num : ''}"><span class="row-icon faint">${I.doc}</span><span class="row-body"><div class="row-title">${esc(r.title)}</div><div class="row-meta"><span>${esc(r.docTitle)}</span></div></span><span class="row-end">${I.chev}</span></a>`;
  }).join('') || '<div class="empty" style="padding:24px 0">Ссылок нет</div>';
  h += `</div>`;
  if (l.type !== 'theory') {
    const read = !!lsPeek(l.id).theoryRead;
    h += `<div class="section"><div class="switch-row"><span>Материал прочитан</span><button class="switch ${read ? 'on' : ''}" data-action="theory-read" data-lesson="${esc(l.id)}" aria-label="Прочитано"></button></div></div>`;
  }
  return h;
}
function lessonStats(l) {
  const a = actual(l.id), p = planned(l);
  const sess = (D.sessionsByLesson[l.id] || []).slice().reverse();
  let h = `<div class="section">`;
  if (l.type !== 'theory') {
    h += `<div class="kv"><span class="k">План</span><span class="stepper"><button data-action="plan" data-lesson="${esc(l.id)}" data-d="-1">−</button><span>${num(p)}</span><button data-action="plan" data-lesson="${esc(l.id)}" data-d="1">+</button></span></div>
      <div class="kv"><span class="k">Факт</span><span class="v">${zan(a)}</span></div>
      <div class="kv"><span class="k">Время</span><span class="v">${num(a * 45 / 60)} ч</span></div>`;
  }
  const c = lsPeek(l.id).closedAtSession;
  h += `<div class="kv"><span class="k">Статус</span><span class="v">${{ done: 'пройден', locked: 'закрыт', progress: 'в работе', available: 'доступен' }[status(l.id)]}</span></div>`;
  if (c) h += `<div class="kv"><span class="k">Пройден</span><span class="v">на занятии №${c}</span></div>`;
  h += `</div>`;
  if (l.type !== 'theory' && a >= 2 * p && !isDone(l.id)) h += `<div class="info">Факт вдвое больше плана. Возможно, план занижен: его можно увеличить кнопками выше.</div>`;
  h += `<div class="section"><div class="section-head"><h2>Занятия по уроку</h2><span class="meta">${sess.length}</span></div>${sess.length ? sess.map(sessionRow).join('') : '<div class="empty" style="padding:24px 0">Пока нет отметок</div>'}</div>`;
  return h;
}

function sessionRow(s) {
  const lessons = (s.lessonIds || []).map(id => L(id)).filter(Boolean);
  return `<button class="row" data-action="edit-session" data-id="${s.id}"><span class="row-icon"><span class="code" style="font-size:12px">№${s._no}</span></span>
    <span class="row-body"><div class="row-title" style="font-size:16px">${s.note ? esc(s.note) : '<span class="faint">без заметки</span>'}</div>
    <div class="row-meta"><span>${esc(dateLabel(s.ts))}</span>${lessons.map(l => `<span class="tag">${esc(l.id)}</span>`).join('')}${s.short ? '<span class="tag orange">короткое</span>' : ''}</div></span></button>`;
}

function vJournal() {
  const list = D.sorted.slice().reverse();
  let h = `<div class="page-title"><span class="glyph" style="color:var(--green)">${I.log}</span><h1>Журнал</h1></div>
    <div class="page-sub">${list.length ? `${list.length} ${plural(list.length, 'запись', 'записи', 'записей')} · ${num(D.total * 45 / 60)} ч занятий` : 'Здесь появятся отмеченные занятия'}</div>`;
  if (list.length >= 20 && list.length % 20 < 3) h += `<div class="info blue">Прошло ${list.length} занятий. Просмотри заметки и найди повторы: формулировка, которая встречается три раза и больше, указывает на дефект техники.</div>`;
  if (!list.length) return h + `<div class="empty">${I.log.replace('width="26" height="26"', 'width="44" height="44"')}<div>Нажми синюю кнопку после занятия</div></div>`;
  let lastDay = null;
  h += `<div class="section">`;
  list.forEach(s => {
    const month = monthLabel(new Date(s.ts));
    if (month !== lastDay) { h += `<div class="section-head" style="margin-top:14px"><h2 style="text-transform:capitalize">${esc(month)}</h2></div>`; lastDay = month; }
    h += sessionRow(s);
  });
  return h + `</div>`;
}

function vLibrary(sub) {
  let h = `<div class="topbar"><span></span><div class="actions">${sub === 'kb' ? '' : `<button class="icon-btn" data-action="add-material" aria-label="Добавить материал" style="color:var(--blue)">${I.plus}</button>`}</div></div>
    <div class="page-title" style="margin-top:0"><span class="glyph" style="color:var(--teal)">${I.book}</span><h1>Библиотека</h1></div>`;
  h += `<div class="seg"><button class="${sub !== 'kb' ? 'on' : ''}" data-action="go" data-to="library">Материалы</button><button class="${sub === 'kb' ? 'on' : ''}" data-action="go" data-to="library/kb">База знаний</button></div>`;
  if (sub === 'kb') {
    Object.keys(KB_TITLES).forEach(doc => {
      h += `<div class="section"><div class="section-head"><h2>${esc(KB_TITLES[doc])}</h2><a class="meta" href="#/kb/${doc}">весь текст</a></div>`;
      h += kbHeadings(doc).filter(x => x.level === 2).map(x => `<a class="row" href="#/kb/${doc}/${x.num}"><span class="row-body"><div class="row-title" style="font-size:16px"><span class="code">${esc(x.num)}</span> ${esc(x.title)}</div></span><span class="row-end">${I.chev}</span></a>`).join('') || '<div class="muted small">Загружается</div>';
      h += `</div>`;
    });
    return h;
  }
  const kinds = [['all', 'Все'], ['sheet', 'Ноты'], ['video', 'Видео'], ['audio', 'Аудио'], ['article', 'Статьи'], ['backing', 'Минус, дрон']];
  const sts = [['all', 'Любой статус'], ['wish', 'Хочу'], ['in_progress', 'Учу'], ['learned', 'Выучено']];
  h += `<div class="chips">${kinds.map(([k, n]) => `<button class="chip ${S.ui.libKind === k ? 'on' : ''}" data-action="lib-kind" data-v="${k}">${n}</button>`).join('')}</div>`;
  h += `<div class="chips" style="margin-top:6px">${sts.map(([k, n]) => `<button class="chip ${S.ui.libStatus === k ? 'on' : ''}" data-action="lib-status" data-v="${k}">${n}</button>`).join('')}</div>`;
  const list = allMaterials().filter(m => (S.ui.libKind === 'all' || m.kind === S.ui.libKind) && (S.ui.libStatus === 'all' || (m.status || 'wish') === S.ui.libStatus));
  h += `<div class="section">${list.length ? list.map(materialRow).join('') : '<div class="empty">Ничего не найдено</div>'}</div>`;
  return h;
}

function vKB(doc, sec) {
  let h = topbar('#/library/kb', 'База знаний');
  if (!KB[doc]) return h + `<div class="empty">Раздел загружается или недоступен без сети</div>`;
  const s = kbSection(doc, sec);
  if (!s) return h + `<div class="empty">Пункт не найден</div>`;
  h += `<div class="lesson-head"><div class="kicker">${esc(KB_TITLES[doc])}</div><h1>${esc(s.title)}</h1></div>`;
  if (!sec) {
    h += `<div class="section">${kbHeadings(doc).filter(x => x.level === 2).map(x => `<a class="row" href="#/kb/${doc}/${x.num}"><span class="row-body"><div class="row-title" style="font-size:16px"><span class="code">${esc(x.num)}</span> ${esc(x.title)}</div></span><span class="row-end">${I.chev}</span></a>`).join('')}</div>`;
    const body = KB[doc].split('\n').slice(1).join('\n');
    return h + `<div class="section prose">${md(body)}</div>`;
  }
  return h + `<div class="prose" style="margin-top:14px">${md(s.text)}</div>`;
}

function vProgress() {
  const st = streaks();
  const closed = P.lessons.filter(l => isDone(l.id)).length;
  const themesClosed = P.themes.filter(t => { const l = themeLessons(t.id); return l.length && l.every(x => isDone(x.id)); }).length;
  let h = `<div class="topbar"><span></span><div class="actions"><a class="icon-btn" href="#/settings" aria-label="Настройки">${I.gear}</a></div></div>
    <div class="page-title" style="margin-top:0"><span class="glyph" style="color:var(--orange)">${I.flag}</span><h1>Прогресс</h1></div>`;
  h += `<div class="counters"><div><div class="v">${num(D.total)}</div><div class="l">занятий</div></div><div><div class="v">${num(D.total * 45 / 60)}</div><div class="l">часов</div></div><div><div class="v">${closed}</div><div class="l">уроков пройдено</div></div>
    <div><div class="v">${st.current}</div><div class="l">цепочка сейчас</div></div><div><div class="v">${st.best}</div><div class="l">лучшая цепочка</div></div><div><div class="v">${themesClosed}</div><div class="l">тем закрыто</div></div></div>
    <div class="tiny faint" style="margin-top:6px">Цепочка считает дни с занятиями, между которыми прошло не больше ${STREAK_GAP_DAYS} дней.</div>`;

  const ms = milestoneState();
  h += `<div class="section"><div class="section-head"><h2>Вехи</h2><span class="meta">${ms.filter(x => x.done).length} из ${ms.length}</span></div>`;
  h += ms.map(x => `<a class="row" href="#/lesson/${encodeURIComponent(x.m.lessonId)}"><span class="ms-badge ${x.done ? 'done' : status(x.m.lessonId) === 'locked' ? 'locked' : ''}">${esc(x.m.id)}</span>
    <span class="row-body"><div class="row-title" style="font-weight:600">${esc(x.m.displayTitle)}</div><div class="row-meta"><span>${esc(x.m.technicalTitle)}</span></div>
    <div class="row-meta">${x.done ? `<span class="tag yellow">получена${x.at ? ` на занятии №${x.at}` : ''}</span>` : `<span>примерно ${zan(x.left)}</span>`}</div></span></a>`).join('');
  h += `</div>`;

  h += `<div class="section"><div class="section-head"><h2>Цели</h2><span class="meta">${pace() ? 'прогноз по последним 20 занятиям' : `дата появится после ${MIN_SESSIONS_FOR_DATE} занятий`}</span></div>`;
  h += P.goals.map(g => {
    const left = goalRemaining(g);
    const done = isDone(g.lessonId);
    const d = forecastDate(left);
    const totalChain = Math.max(left + D.total, 1);
    const frac = done ? 1 : Math.min(D.total / totalChain, 1);
    return `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between;gap:10px"><div class="row-title" style="font-weight:600">${esc(g.title)}</div><div class="small ${done ? '' : 'muted'}" style="${done ? 'color:var(--green)' : ''}">${done ? 'достигнута' : `≈ ${zan(left)}`}</div></div>
      <div class="bar ${done ? 'green' : ''}" style="margin:8px 0 6px"><i style="width:${Math.round(frac * 100)}%"></i></div>
      <div class="row-meta"><span>${esc(lessonLabel(L(g.lessonId)))}</span>${!done && d ? `<span>примерно ${esc(monthLabel(d))}</span>` : ''}</div></div>`;
  }).join('');
  h += `</div>`;

  h += `<div class="section"><div class="section-head"><h2>Занятия по неделям</h2><span class="meta">12 недель</span></div>${weekChart()}</div>`;
  return h;
}

function weekChart() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const weeks = [];
  for (let i = 11; i >= 0; i--) { const s = new Date(monday); s.setDate(s.getDate() - i * 7); weeks.push({ start: s.getTime(), v: 0 }); }
  D.sorted.forEach(s => { for (let i = weeks.length - 1; i >= 0; i--) if (s.ts >= weeks[i].start) { if (i < weeks.length) weeks[i].v += s.short ? 0.5 : 1; break; } });
  const max = Math.max(4, ...weeks.map(w => w.v));
  const W = 340, H = 130, pb = 20, pt = 16, bw = W / weeks.length;
  let g = '';
  const y4 = pt + (H - pt - pb) * (1 - 4 / max);
  g += `<line x1="0" x2="${W}" y1="${y4}" y2="${y4}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 4"/><text x="${W}" y="${y4 - 4}" fill="#66676e" font-size="9" text-anchor="end">4 в неделю</text>`;
  weeks.forEach((w, i) => {
    const bh = (H - pt - pb) * (w.v / max);
    const x = i * bw + bw * 0.2, y = H - pb - bh;
    g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${Math.max(bh, w.v ? 2 : 0).toFixed(1)}" rx="3" fill="${i === weeks.length - 1 ? 'var(--blue)' : '#4a8cf7aa'}"/>`;
    if (w.v) g += `<text x="${(x + bw * 0.3).toFixed(1)}" y="${(y - 4).toFixed(1)}" fill="#9d9ea5" font-size="9.5" text-anchor="middle">${num(w.v)}</text>`;
    if (i % 3 === 0 || i === weeks.length - 1) g += `<text x="${(x + bw * 0.3).toFixed(1)}" y="${H - 5}" fill="#66676e" font-size="9" text-anchor="middle">${esc(fmtShort.format(new Date(w.start)).replace('.', ''))}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Занятия по неделям">${g}</svg></div>`;
}

function vSettings() {
  let h = topbar('#/progress', 'Прогресс');
  h += `<div class="page-title" style="margin-top:4px"><h1>Настройки</h1></div>`;
  const since = D.count - S.meta.lastExportCount;
  h += `<div class="section"><div class="section-head"><h2>Данные</h2></div>
    <div class="small muted" style="margin:8px 0 12px">Данные хранятся только на этом устройстве. ${S.meta.lastExportAt ? `Последняя копия: ${esc(dateLabel(S.meta.lastExportAt))}, после нее ${zan(since)}.` : 'Резервных копий еще не было.'}</div>
    <div class="stack"><button class="btn primary block" data-action="export">Сохранить резервную копию</button>
    <label class="btn secondary block" style="cursor:pointer">Восстановить из файла<input type="file" accept="application/json,.json" data-action="import" hidden></label></div></div>`;
  h += `<div class="section"><div class="section-head"><h2>Плановые значения</h2><span class="meta">в занятиях</span></div>`;
  P.lessons.filter(l => l.type !== 'theory').forEach(l => {
    const changed = typeof lsPeek(l.id).planned === 'number';
    h += `<div class="kv"><span class="k" style="flex:1;min-width:0;padding-right:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span class="code">${esc(l.id)}</span> ${esc(l.title)}${changed ? ' <span class="tag blue">изменен</span>' : ''}</span>
      <span class="stepper"><button data-action="plan" data-lesson="${esc(l.id)}" data-d="-1">−</button><span>${num(planned(l))}</span><button data-action="plan" data-lesson="${esc(l.id)}" data-d="1">+</button></span></div>`;
  });
  h += `</div>`;
  h += `<div class="section"><div class="section-head"><h2>Приложение</h2></div>
    <div class="kv"><span class="k">Версия</span><span class="v">${APP_VERSION}</span></div>
    <div class="kv"><span class="k">Программа</span><span class="v">версия ${esc(P.version)}</span></div>
    <div class="kv"><span class="k">Хранилище</span><span class="v" id="persist-state">проверяется</span></div>
    <div class="stack" style="margin-top:14px"><button class="btn secondary block" data-action="update-app">Проверить обновление</button>
    <button class="btn danger block" data-action="reset">Сбросить все данные</button></div></div>`;
  setTimeout(async () => {
    const el = $('#persist-state'); if (!el) return;
    try { const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; el.textContent = p ? 'защищено от очистки' : 'обычное'; } catch (_) { el.textContent = 'обычное'; }
  }, 0);
  return h;
}

/* =========================================================
   Sheets
   ========================================================= */
function openSheet(html, onMount) {
  closeSheet(true);
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  requestAnimationFrame(() => { root.querySelector('.sheet-backdrop').classList.add('show'); root.querySelector('.sheet').classList.add('show'); });
  if (onMount) onMount(root.querySelector('.sheet'));
}
function closeSheet(instant) {
  const root = $('#sheet-root');
  const sh = root.querySelector('.sheet'); const bd = root.querySelector('.sheet-backdrop');
  if (!sh) return;
  if (instant) { root.innerHTML = ''; return; }
  sh.classList.remove('show'); bd.classList.remove('show');
  setTimeout(() => { if (root.querySelector('.sheet') === sh) root.innerHTML = ''; }, 260);
}

function sessionSheet(preLesson, existing) {
  const edit = !!existing;
  const candidates = new Map();
  [...openPractice(mainThemes()), ...openPractice(parallelThemes())].forEach(l => candidates.set(l.id, l));
  if (edit) (existing.lessonIds || []).forEach(id => { const l = L(id); if (l) candidates.set(id, l); });
  let selected;
  if (edit) selected = new Set(existing.lessonIds || []);
  else if (preLesson) selected = new Set([preLesson]);
  else { const hero = heroLesson(); selected = new Set([...candidates.values()].filter(l => status(l.id) === 'progress').map(l => l.id)); if (hero) selected.add(hero.id); }
  let short = edit ? !!existing.short : false;
  const no = edit ? existing._no : D.count + 1;
  const dt = new Date(edit ? existing.ts : Date.now());
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const html = `<h3>${edit ? `Занятие №${no}` : `Занятие №${no} проведено`}</h3>
    <p class="sub">${edit ? 'Правка записи журнала' : 'Отметь уроки, над которыми работал'}</p>
    <div class="switch-row"><span>Короткое занятие<div class="tiny faint">меньше 20 минут, считается за половину</div></span><button class="switch ${short ? 'on' : ''}" data-role="short" aria-label="Короткое"></button></div>
    <div class="section-head" style="margin-top:10px"><h2 style="font-size:15px">Уроки</h2></div>
    <div data-role="lessons">${[...candidates.values()].map(l => `<button class="task ${selected.has(l.id) ? 'on-sel' : ''}" data-role="pick" data-id="${esc(l.id)}"><span class="check ${selected.has(l.id) ? 'on' : ''}">${I.checkMini}</span><span class="t"><span class="code">${esc(l.id)}</span> ${esc(l.title)}</span></button>`).join('') || '<div class="muted small" style="padding:8px 0">Нет открытых уроков</div>'}</div>
    <label class="field"><span>Заметка: что сделано, что не получилось</span><textarea class="input" data-role="note" rows="2" placeholder="Например: подставка стояла с наклоном, выправил">${esc(edit ? existing.note || '' : '')}</textarea></label>
    ${edit ? `<label class="field"><span>Дата и время</span><input class="input" type="datetime-local" data-role="date" value="${local}"></label>` : ''}
    <div class="foot">${edit ? `<button class="btn danger" data-role="delete">Удалить</button>` : `<button class="btn secondary" data-action="close-sheet">Отмена</button>`}<button class="btn primary" data-role="save">Сохранить</button></div>`;
  openSheet(html, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('[data-role]'); if (!b) return;
      const role = b.dataset.role;
      if (role === 'short') { short = !short; b.classList.toggle('on', short); }
      if (role === 'pick') { const id = b.dataset.id; if (selected.has(id)) selected.delete(id); else selected.add(id); b.querySelector('.check').classList.toggle('on', selected.has(id)); }
      if (role === 'delete') {
        if (b.dataset.confirm) { S.sessions = S.sessions.filter(s => s.id !== existing.id); save(); closeSheet(); render(); toast('Запись удалена'); }
        else { b.dataset.confirm = '1'; b.textContent = 'Точно удалить?'; }
      }
      if (role === 'save') {
        const note = sh.querySelector('[data-role=note]').value.trim();
        const lessonIds = [...selected];
        if (edit) {
          const s = S.sessions.find(x => x.id === existing.id);
          Object.assign(s, { note, lessonIds, short });
          const dv = sh.querySelector('[data-role=date]').value; if (dv) { const t = new Date(dv).getTime(); if (!isNaN(t)) s.ts = t; }
          save(); closeSheet(); render(); toast('Запись обновлена');
        } else {
          const before = D.actual;
          S.seq += 1;
          S.sessions.push({ id: S.seq, ts: Date.now(), lessonIds, short, note });
          save(); closeSheet(); render();
          const reached = lessonIds.map(L).filter(l => l && (before[l.id] || 0) < planned(l) && actual(l.id) >= planned(l));
          toast(reached.length ? `Записано. ${lessonLabel(reached[0])}: план выполнен, проверь условие завершения` : `Занятие №${D.count} записано`);
        }
      }
    });
  });
}

function closeLessonSheet(id) {
  const l = L(id);
  openSheet(`<h3>${esc(lessonLabel(l))} пройден?</h3><p class="sub">Проверь условие завершения</p>
    <div class="note-box" style="margin-top:8px">${inline(l.completionCriteria)}</div>
    ${taskProgress(l).done < taskProgress(l).total ? `<div class="info" style="margin-top:10px">Отмечено ${taskProgress(l).done} из ${taskProgress(l).total} микрозадач. Закрыть урок можно и так, решение за тобой.</div>` : ''}
    <div class="foot"><button class="btn secondary" data-action="close-sheet">Еще нет</button><button class="btn primary" data-action="confirm-close" data-lesson="${esc(l.id)}">Да, пройден</button></div>`);
}

function doCloseLesson(id) {
  const l = L(id);
  const openBefore = { ...D.themeOpen };
  const e = ls(id);
  e.done = true; e.closedAtSession = D.count; e.closedAt = Date.now();
  if (l.type === 'theory') e.theoryRead = true;
  save(); closeSheet(true); render();
  const newThemes = P.themes.filter(t => !openBefore[t.id] && D.themeOpen[t.id]);
  if (l.milestoneId) {
    const m = P.milestones.find(x => x.id === l.milestoneId);
    openSheet(`<div class="celebrate"><div class="big">${esc(m.id)}</div><h3>${esc(m.displayTitle)}</h3><p class="sub">${esc(m.technicalTitle)}</p>
      <p class="small muted">Веха получена${D.count ? ` на занятии №${D.count}` : ''}.${newThemes.length ? ` Открыта тема ${newThemes.map(t => t.id).join(', ')}.` : ''}</p></div>
      <div class="foot"><button class="btn primary" data-action="close-sheet">Дальше</button></div>`);
  } else {
    toast(newThemes.length ? `${lessonLabel(l)} пройден. Открыта тема ${newThemes.map(t => `${t.id}. ${t.title}`).join(', ')}` : `${lessonLabel(l)} пройден`);
  }
}

function materialSheet(id) {
  const own = S.userMaterials.find(m => m.id === id);
  const m = own || mergedMaterial(P.materials.find(x => x.id === id));
  if (!m) return;
  const links = [['url', 'Открыть'], ['referenceUrl', 'Эталон'], ['backingUrl', 'Минус']].filter(([k]) => m[k]);
  const lessons = (m.lessonIds || []).map(L).filter(Boolean);
  openSheet(`<h3>${esc(m.title)}</h3><p class="sub">${[KIND[m.kind], m.composer, m.source].filter(Boolean).map(esc).join(' · ')}</p>
    ${links.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px">${links.map(([k, n]) => `<a class="btn secondary" href="${esc(m[k])}" target="_blank" rel="noopener">${I.link} ${n}</a>`).join('')}</div>` : ''}
    <div class="seg" data-role="status">${Object.entries(MSTATUS).map(([k, n]) => `<button class="${(m.status || 'wish') === k ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div>
    ${own ? `<label class="field"><span>Название</span><input class="input" data-f="title" value="${esc(m.title)}"></label>` : ''}
    <label class="field"><span>Ссылка на ноты или страницу</span><input class="input" data-f="url" inputmode="url" value="${esc(m.url || '')}" placeholder="https://"></label>
    <label class="field"><span>Эталонная запись</span><input class="input" data-f="referenceUrl" inputmode="url" value="${esc(m.referenceUrl || '')}" placeholder="https://"></label>
    <label class="field"><span>Минусовка</span><input class="input" data-f="backingUrl" inputmode="url" value="${esc(m.backingUrl || '')}" placeholder="https://"></label>
    <label class="field"><span>Заметки</span><textarea class="input" data-f="notes" rows="3">${esc(m.notes || '')}</textarea></label>
    ${lessons.length ? `<div class="small muted" style="margin-top:12px">Уроки: ${lessons.map(l => `<a href="#/lesson/${encodeURIComponent(l.id)}" data-action="close-sheet">${esc(l.id)}</a>`).join(', ')}</div>` : ''}
    <div class="foot">${own ? '<button class="btn danger" data-role="delete">Удалить</button>' : ''}<button class="btn primary" data-role="save">Готово</button></div>`, sh => {
    let st = m.status || 'wish';
    sh.addEventListener('click', e => {
      const sb = e.target.closest('[data-role=status] button');
      if (sb) { st = sb.dataset.v; sh.querySelectorAll('[data-role=status] button').forEach(x => x.classList.toggle('on', x === sb)); return; }
      const b = e.target.closest('[data-role]'); if (!b) return;
      if (b.dataset.role === 'delete') {
        if (b.dataset.confirm) { S.userMaterials = S.userMaterials.filter(x => x.id !== id); save(); closeSheet(); render(); }
        else { b.dataset.confirm = '1'; b.textContent = 'Точно удалить?'; }
      }
      if (b.dataset.role === 'save') {
        const patch = { status: st };
        sh.querySelectorAll('[data-f]').forEach(inp => { patch[inp.dataset.f] = inp.value.trim(); });
        if (own) Object.assign(own, patch); else S.materials[id] = Object.assign(S.materials[id] || {}, patch);
        save(); closeSheet(); render();
      }
    });
  });
}

function addMaterialSheet(lessonId) {
  const opts = P.lessons.map(l => `<option value="${esc(l.id)}" ${l.id === lessonId ? 'selected' : ''}>${esc(l.id)}. ${esc(l.title)}</option>`).join('');
  openSheet(`<h3>Новый материал</h3>
    <label class="field"><span>Название</span><input class="input" data-f="title" placeholder="Например: Ода к радости, ноты"></label>
    <label class="field"><span>Автор или композитор</span><input class="input" data-f="composer"></label>
    <label class="field"><span>Тип</span><select class="input" data-f="kind">${Object.entries(KIND).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
    <label class="field"><span>Ссылка</span><input class="input" data-f="url" inputmode="url" placeholder="https://"></label>
    <label class="field"><span>Урок</span><select class="input" data-f="lesson"><option value="">без привязки</option>${opts}</select></label>
    <label class="field"><span>Заметки</span><textarea class="input" data-f="notes" rows="2"></textarea></label>
    <div class="foot"><button class="btn secondary" data-action="close-sheet">Отмена</button><button class="btn primary" data-role="save">Добавить</button></div>`, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('[data-role=save]'); if (!b) return;
      const f = {}; sh.querySelectorAll('[data-f]').forEach(i => { f[i.dataset.f] = i.value.trim(); });
      if (!f.title) { sh.querySelector('[data-f=title]').focus(); toast('Укажи название'); return; }
      S.userMaterials.push({ id: 'u' + Date.now().toString(36), title: f.title, composer: f.composer, kind: f.kind, url: f.url, source: 'свое', difficulty: 'beginner', status: 'wish', lessonIds: f.lesson ? [f.lesson] : [], notes: f.notes, referenceUrl: '', backingUrl: '', addedByUser: true });
      save(); closeSheet(); render(); toast('Материал добавлен');
    });
  });
}

/* =========================================================
   Actions
   ========================================================= */
let wakeLock = null;
async function toggleWakeLock() {
  try {
    if (wakeLock) { await wakeLock.release(); wakeLock = null; toast('Экран гаснет как обычно'); }
    else { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { if (wakeLock && wakeLock.released) { /* keep flag for re-acquire */ } }); toast('Экран не будет гаснуть на этой странице'); }
  } catch (_) { wakeLock = null; toast('Устройство не разрешило держать экран включенным'); }
  render();
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeLock && wakeLock.released) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { wakeLock = null; }
  }
});
window.addEventListener('hashchange', () => {
  if (wakeLock && route().name !== 'lesson') { wakeLock.release().catch(() => {}); wakeLock = null; }
  closeSheet(true); render();
});

async function exportData() {
  const payload = { app: 'violin', version: APP_VERSION, exportedAt: new Date().toISOString(), state: S };
  const text = JSON.stringify(payload, null, 1);
  const d = new Date();
  const name = `skripka-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([text], name, { type: 'application/json' });
  let ok = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Скрипка: резервная копия' }); ok = true; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  if (!ok) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  S.meta.lastExportCount = D.count; S.meta.lastExportAt = Date.now(); save(); render(); toast('Резервная копия сохранена');
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const st = data && data.state;
    if (!st || st.app !== 'violin') throw new Error('bad');
    openSheet(`<h3>Восстановить данные?</h3><p class="sub">Файл от ${esc(data.exportedAt ? dateLabel(Date.parse(data.exportedAt)) : 'неизвестной даты')}: ${st.sessions ? st.sessions.length : 0} занятий. Текущие данные будут заменены.</p>
      <div class="foot"><button class="btn secondary" data-action="close-sheet">Отмена</button><button class="btn primary" data-role="ok">Восстановить</button></div>`, sh => {
      sh.querySelector('[data-role=ok]').addEventListener('click', () => { S = normalizeState(st); save(); closeSheet(); render(); toast('Данные восстановлены'); });
    });
  } catch (_) { toast('Файл не похож на резервную копию этого приложения'); }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const lid = el.dataset.lesson;
  switch (a) {
    case 'session': sessionSheet(lid); break;
    case 'task': {
      if (status(lid) === 'locked') return;
      const e2 = ls(lid); e2.tasks = e2.tasks || {};
      e2.tasks[el.dataset.task] = !e2.tasks[el.dataset.task];
      save(); render(); break;
    }
    case 'lesson-tab': go(`lesson/${encodeURIComponent(lid)}${el.dataset.tab === 'lesson' ? '' : '/' + el.dataset.tab}`); break;
    case 'close-lesson': closeLessonSheet(lid); break;
    case 'confirm-close': doCloseLesson(lid); break;
    case 'reopen': { const e2 = ls(lid); e2.done = false; delete e2.closedAtSession; delete e2.closedAt; save(); render(); toast('Урок снова в работе'); break; }
    case 'theory-read': { const e2 = ls(lid); e2.theoryRead = !e2.theoryRead; save(); render(); break; }
    case 'plan': {
      const l = L(lid); const v = Math.max(1, planned(l) + Number(el.dataset.d));
      const e2 = ls(lid); if (v === l.plannedSessions) delete e2.planned; else e2.planned = v;
      save(); render(); break;
    }
    case 'toggle-theme': {
      const t = el.dataset.theme; const list = themeLessons(t);
      const cur = S.ui.collapsed[t] ?? ((list.length > 0 && list.every(l => isDone(l.id))) || !D.themeOpen[t]);
      S.ui.collapsed[t] = !cur; save(); render(); break;
    }
    case 'lib-kind': S.ui.libKind = el.dataset.v; save(); render(); break;
    case 'lib-status': S.ui.libStatus = el.dataset.v; save(); render(); break;
    case 'material': materialSheet(el.dataset.id); break;
    case 'add-material': addMaterialSheet(lid); break;
    case 'edit-session': { const s = D.sorted.find(x => String(x.id) === el.dataset.id); if (s) sessionSheet(null, s); break; }
    case 'close-sheet': closeSheet(); break;
    case 'go': go(el.dataset.to); break;
    case 'wakelock': toggleWakeLock(); break;
    case 'export': exportData(); break;
    case 'update-app': updateApp(); break;
    case 'reset':
      openSheet(`<h3>Сбросить все данные?</h3><p class="sub">Журнал, отметки уроков и свои материалы будут удалены. Перед сбросом лучше сохранить резервную копию.</p>
        <div class="foot"><button class="btn secondary" data-action="close-sheet">Отмена</button><button class="btn danger" data-role="ok">Сбросить</button></div>`, sh => {
        sh.querySelector('[data-role=ok]').addEventListener('click', () => { S = defaultState(); save(); closeSheet(); go(''); render(); toast('Данные сброшены'); });
      });
      break;
  }
});
$('#fab').addEventListener('click', () => {
  const r = route();
  sessionSheet(r.name === 'lesson' ? r.args[0] : null);
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-action=import]') && e.target.files[0]) { importData(e.target.files[0]); e.target.value = ''; }
});

async function updateApp() {
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
    const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k)));
  } catch (_) {}
  location.reload();
}

/* =========================================================
   Boot
   ========================================================= */
async function loadProgram() {
  const r = await fetch('program.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('program');
  return r.json();
}

async function boot() {
  try {
    const [prog, saved] = await Promise.all([loadProgram(), Store.get(STATE_KEY)]);
    P = prog;
    S = normalizeState(saved);
    if (S.meta.programVersion !== P.version) { S.meta.programVersion = P.version; save(); }
    render();
    loadKB().then(() => { const r = route(); if (['lesson', 'library', 'kb'].includes(r.name)) render(); });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Не удалось загрузить программу. Проверь подключение и открой приложение еще раз.</div>`;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
