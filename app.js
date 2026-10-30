// 위크플래너 — Firebase(로그인 + Firestore) 버전
// 데이터 위치: weekplanner/{사용자 uid}/days/{YYYY-MM-DD}  →  { date, items: [{id, text, done, sub?, group?}] }
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

const $ = (s, r = document) => r.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const DOW = ['월', '화', '수', '목', '금', '토', '일'];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH = matchMedia('(hover: none)').matches;
const WIDE = matchMedia('(min-width: 880px)');
const PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const XICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const SUBICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 3v5.5A1.5 1.5 0 0 0 5.5 10H12M9.5 7.5 12 10l-2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COPYICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="5.25" width="8.25" height="8.25" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M10.6 3.2A1.6 1.6 0 0 0 9.1 2.1H4.1A1.6 1.6 0 0 0 2.5 3.7v5c0 .75.5 1.38 1.2 1.55" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const MOREICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';

/* ---------- dates (local time) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const firstOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const dayName = d => DOW[(d.getDay() + 6) % 7];
const todayStr = () => ymd(new Date());
const short = ds => { const d = parse(ds); return `${d.getMonth() + 1}.${d.getDate()}`; };
const weekLabel = mon => { const thu = addDays(mon, 3); return `${thu.getMonth() + 1}월 ${Math.ceil(thu.getDate() / 7)}주차`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- screens ---------- */
const screens = { boot: $('#boot'), setup: $('#setup'), login: $('#login'), app: $('#app') };
function show(name) { for (const k in screens) screens[k].hidden = k !== name; }

/* ---------- state ---------- */
const state = { view: 'week', anchor: mondayOf(new Date()), mode: 'loading', readonly: false, error: false, errorText: '', subEdit: null };
{
  let v = location.hash === '#month' ? 'month' : location.hash === '#week' ? 'week' : null;
  if (!v) { try { v = localStorage.getItem('wp.view'); } catch (e) {} }
  if (v === 'month') { state.view = 'month'; state.anchor = firstOfMonth(new Date()); }
}

const store = new Map();            // 'YYYY-MM-DD' -> items (stored order)
const dirty = new Set();            // changed locally, not yet sent to Firestore
const settling = new Set();         // just checked: stays in place a moment so the strike-through shows, then sinks
const justCopied = new Map();       // new copy id -> time, so its arrow draws in once
let pending = 0;                    // writes sent but not yet confirmed by the server
let focusG = null;                  // copy chain under the pointer
let F = null, auth = null, db = null, col = null, currentUid = null;
let unsub = null, sub = null, loadedRange = null, loadFallback = 0, flushTimer = 0;

const pack = it => { const o = { id: it.id, text: it.text, done: !!it.done }; if (it.sub) o.sub = true; if (it.group) o.group = it.group; return o; };
const clean = items => Array.isArray(items)
  ? items.filter(it => it && typeof it.id === 'string' && typeof it.text === 'string')
      .map(it => pack({ id: it.id.slice(0, 40), text: it.text.slice(0, 300), done: it.done, sub: !!it.sub, group: typeof it.group === 'string' ? it.group.slice(0, 40) : '' }))
  : [];
const blockEnd = (items, i) => { let j = i + 1; if (!items[i].sub) while (j < items.length && items[j].sub) j++; return j; };

// Display order: open tasks first, then completed ones. A task moves with its sub-tasks;
// a sub-task being done never moves anything.
function displayOrder(items) {
  const open = [], closed = [];
  for (let i = 0; i < items.length;) {
    const end = blockEnd(items, i), head = items[i];
    const done = !head.sub && head.done && !settling.has(head.id);
    (done ? closed : open).push(...items.slice(i, end));
    i = end;
  }
  return { list: open.concat(closed), doneFrom: open.length };
}

const isLoaded = ds => state.mode === 'db' && !!loadedRange && ds >= loadedRange.a && ds <= loadedRange.b;
const canEdit = ds => isLoaded(ds) && !state.readonly;

/* ---------- Firestore sync ---------- */
function span() {
  if (state.view === 'week') return [ymd(addDays(state.anchor, -7)), ymd(addDays(state.anchor, 13))];
  const a = state.anchor;
  const lastNext = new Date(a.getFullYear(), a.getMonth() + 2, 0);
  return [ymd(mondayOf(addMonths(a, -1))), ymd(addDays(mondayOf(lastNext), 6))];
}

function stopSub() {
  if (unsub) { try { unsub(); } catch (e) {} }
  unsub = null; sub = null; loadedRange = null;
  clearTimeout(loadFallback);
}

function ensureSub() {
  if (state.mode !== 'db' || !col) return;
  const [a, b] = span();
  if (sub && a >= sub.a && b <= sub.b) return;
  const A = ymd(addDays(parse(a), -42)), B = ymd(addDays(parse(b), 42));
  stopSub();
  const mine = { a: A, b: B };
  sub = mine;
  // Offline with only a local cache: allow editing after a short wait.
  loadFallback = setTimeout(() => { if (sub === mine && !loadedRange) { loadedRange = mine; render(); } }, 5000);
  const q = F.query(col, F.where('date', '>=', A), F.where('date', '<=', B));
  unsub = F.onSnapshot(q, { includeMetadataChanges: true }, snap => {
    if (sub !== mine) return;
    const seen = new Set();
    snap.docs.forEach(d => {
      const data = d.data() || {};
      const ds = typeof data.date === 'string' ? data.date : d.id;
      seen.add(ds);
      if (dirty.has(ds)) return;
      store.set(ds, clean(data.items));
    });
    for (const k of [...store.keys()]) {
      if (k >= A && k <= B && !seen.has(k) && !dirty.has(k)) store.delete(k);
    }
    if (!snap.metadata.fromCache && !loadedRange) loadedRange = mine;
    if (state.readonly && state.errorText.startsWith('권한')) { state.readonly = false; state.error = false; }
    render();
  }, err => {
    if (sub !== mine) return;
    sub = null; unsub = null;
    if (err && err.code === 'permission-denied') {
      state.readonly = true; state.error = true; state.errorText = '권한이 없어요 · 보안 규칙을 확인해 주세요';
      toast('Firestore 보안 규칙 때문에 할 일을 불러오지 못했어요. README의 규칙 단계를 확인해 주세요.');
      render();
      return;
    }
    setTimeout(ensureSub, 3000);
  });
}

function touch(ds) {
  dirty.add(ds);
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 250);
  render();
}

function flush() {
  clearTimeout(flushTimer);
  if (!col) return;
  const list = [...dirty]; dirty.clear();
  for (const ds of list) {
    pending++;
    writeDay(ds)
      .then(() => { if (state.error && !state.readonly) { state.error = false; state.errorText = ''; } }, e => onWriteError(e, ds))
      .finally(() => { pending--; setSync(); });
  }
  setSync();
}

function writeDay(ds) {
  const items = store.get(ds) || [];
  const ref = F.doc(col, ds);
  return items.length ? F.setDoc(ref, { date: ds, items: items.map(pack) }) : F.deleteDoc(ref);
}

function onWriteError(e, ds) {
  const code = e && e.code;
  state.error = true;
  if (code === 'permission-denied') {
    state.readonly = true;
    state.errorText = '권한이 없어요 · 보안 규칙을 확인해 주세요';
    toast('저장할 권한이 없어요. README의 Firestore 규칙 단계를 확인해 주세요.');
  } else if (code === 'resource-exhausted') {
    state.errorText = '오늘 저장 한도를 넘었어요';
    toast('Firebase 무료 사용량을 넘어서 저장하지 못했어요. 내일 다시 저장돼요.');
  } else {
    state.errorText = '저장하지 못했어요 · 다시 시도할게요';
    dirty.add(ds);
    setTimeout(() => { if (dirty.size && !state.readonly) flush(); }, 6000);
  }
  render();
}

function setSync() {
  const el = $('#sync');
  let s = 'synced', t = '모든 기기에 저장됨';
  if (state.mode !== 'db') { s = 'loading'; t = '불러오는 중'; }
  else if (state.error) { s = 'error'; t = state.errorText || '저장하지 못했어요'; }
  else if (!navigator.onLine) { s = 'offline'; t = (dirty.size || pending) ? '오프라인 · 연결되면 저장돼요' : '오프라인'; }
  else if (dirty.size || pending) { s = 'saving'; t = '저장 중'; }
  else if (!loadedRange) { s = 'loading'; t = '불러오는 중'; }
  el.dataset.state = s; el.lastElementChild.textContent = t;
}
window.addEventListener('online', setSync);
window.addEventListener('offline', setSync);

/* ---------- edits ---------- */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function addItem(ds, raw) {
  const asSub = /^\s/.test(raw);
  const text = raw.trim().slice(0, 300);
  if (!text || !canEdit(ds)) return false;
  const items = store.get(ds) || [];
  if (asSub) {
    // "바로 위 할 일" = the last task shown above the input
    const { list } = displayOrder(items);
    for (let k = list.length - 1; k >= 0; k--) if (!list[k].sub) return addSub(ds, list[k].id, text);
  }
  store.set(ds, [...items, { id: newId(), text, done: false }]);
  touch(ds); return true;
}
function addSub(ds, parentId, raw) {
  const text = raw.trim().slice(0, 300);
  if (!text || !canEdit(ds)) return false;
  const items = [...(store.get(ds) || [])];
  const i = items.findIndex(x => x.id === parentId);
  if (i < 0) return false;
  items.splice(blockEnd(items, i), 0, { id: newId(), text, done: false, sub: true });
  store.set(ds, items); touch(ds); return true;
}
function toggleItem(ds, id, done) {
  if (!canEdit(ds)) return;
  const items = (store.get(ds) || []).map(x => ({ ...x }));
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  items[i].done = done;
  if (!items[i].sub) {
    for (let j = i + 1; j < items.length && items[j].sub; j++) items[j].done = done;
    if (done) {
      settling.add(id);
      setTimeout(() => { if (settling.delete(id)) render(); }, 450);
    } else settling.delete(id);
  }
  store.set(ds, items); touch(ds);
}
function removeItem(ds, id) {
  if (!canEdit(ds)) return;
  const items = store.get(ds) || [];
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  const end = blockEnd(items, i), gone = items.slice(i, end);
  if (state.subEdit && state.subEdit.parent === id) state.subEdit = null;
  store.set(ds, [...items.slice(0, i), ...items.slice(end)]);
  touch(ds);
  toast(gone.length > 1 ? `할 일과 세부 업무 ${gone.length - 1}개를 지웠어요` : '할 일을 지웠어요', '되돌리기', () => {
    const cur = [...(store.get(ds) || [])];
    if (cur.some(x => x.id === id)) return;
    let at = Math.min(i, cur.length);
    if (!gone[0].sub) while (at < cur.length && cur[at].sub) at++;
    cur.splice(at, 0, ...gone);
    store.set(ds, cur); touch(ds);
  });
}
// index: stored position to insert before, or -1 for "after the open tasks" (which is the end)
function copyItem(src, id, dst, index, force) {
  if (!canEdit(src) || (!force && !canEdit(dst))) return;
  const sItems = (store.get(src) || []).map(x => ({ ...x }));
  const i = sItems.findIndex(x => x.id === id);
  if (i < 0) return;
  const block = sItems.slice(i, blockEnd(sItems, i));
  const hadGroup = !!sItems[i].group;
  const group = sItems[i].group || newId();
  sItems[i].group = group;
  const copies = block.map((x, k) => k === 0 ? { id: newId(), text: x.text, done: false, group } : { id: newId(), text: x.text, done: false, sub: true });
  const dItems = src === dst ? sItems : (store.get(dst) || []).map(x => ({ ...x }));
  let at = index < 0 ? dItems.length : Math.min(index, dItems.length);
  while (at < dItems.length && dItems[at].sub) at++;
  dItems.splice(at, 0, ...copies);
  store.set(src, sItems);
  if (src !== dst) store.set(dst, dItems);
  const cid = copies[0].id;
  justCopied.set(cid, performance.now());
  setTimeout(() => justCopied.delete(cid), 1500);
  if (src !== dst && !hadGroup) touch(src);
  touch(dst);
  const d = parse(dst);
  toast(`${d.getMonth() + 1}월 ${d.getDate()}일(${dayName(d)})로 복사했어요`, '되돌리기', () => {
    const ids = new Set(copies.map(c => c.id));
    store.set(dst, (store.get(dst) || []).filter(x => !ids.has(x.id)));
    if (!hadGroup) store.set(src, (store.get(src) || []).map(x => { if (x.id !== id) return x; const y = { ...x }; delete y.group; return y; }));
    if (src !== dst && !hadGroup) touch(src);
    touch(dst);
  });
}
// Copy to any date. A date outside the loaded weeks is read first so nothing there is overwritten.
async function copyTo(src, id, dst) {
  if (!canEdit(src)) return;
  if (!canEdit(dst)) {
    if (state.readonly) return;
    try {
      const snap = await F.getDoc(F.doc(col, dst));
      if (!dirty.has(dst)) store.set(dst, clean(snap.exists() ? (snap.data() || {}).items : []));
    } catch (e) {
      toast('그 날짜의 할 일을 불러오지 못해서 복사하지 못했어요. 인터넷 연결을 확인해 주세요.');
      return;
    }
  }
  copyItem(src, id, dst, -1, true);
}

/* ---------- chains: a task and its copies, ordered earlier → later ---------- */
let chainPairs = [], chainNbr = new Map();
function computeChains() {
  const groups = new Map();
  for (const [ds, items] of store) items.forEach((it, idx) => {
    if (!it.group) return;
    let g = groups.get(it.group); if (!g) groups.set(it.group, g = []);
    g.push({ ds, idx, id: it.id });
  });
  chainPairs = []; chainNbr = new Map();
  const nb = id => { let o = chainNbr.get(id); if (!o) chainNbr.set(id, o = {}); return o; };
  groups.forEach((list, g) => {
    if (list.length < 2) return;
    list.sort((a, b) => a.ds < b.ds ? -1 : a.ds > b.ds ? 1 : a.idx - b.idx);
    for (let k = 0; k < list.length - 1; k++) {
      const a = list[k], b = list[k + 1];
      chainPairs.push([a.id, b.id, g]);
      nb(a.id).next = b.ds; nb(b.id).prev = a.ds;
    }
  });
}
const hasNext = id => { const n = chainNbr.get(id); return !!(n && n.next); };

/* ---------- rendering ---------- */
const vp = $('#viewport'), track = $('#track'), panes = [...track.children];
panes[0].inert = true; panes[2].inert = true;
const paneAnchor = k => state.view === 'week' ? addDays(state.anchor, 7 * k) : addMonths(state.anchor, k);

function buildWeek(p, interactive) {
  const wrap = document.createElement('div');
  wrap.className = 'week';
  for (let i = 0; i < 7; i++) {
    const sec = document.createElement('section');
    sec.className = 'day';
    sec.innerHTML = `<header class="dh"><span class="mo"></span><span class="dow"></span><span class="tdy">Today</span><span class="num"></span><span class="cnt"></span></header><ul class="items"></ul><form class="add" autocomplete="off"><input type="text" maxlength="300" aria-label="할 일 추가" placeholder="할 일 추가"><button type="submit" aria-label="추가">${PLUS}</button></form>`;
    if (interactive) { const inp = sec.querySelector('input'); inp.id = 'add-' + i; inp.name = 'add-' + i; }
    wrap.appendChild(sec);
  }
  p.appendChild(wrap);
}

function makeItem(it, interactive) {
  const li = document.createElement('li');
  li.className = 'item'; li.dataset.id = it.id;
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'cb';
  const lab = document.createElement('label'); lab.className = 'text';
  lab.innerHTML = '<span class="t"></span><button type="button" class="lk lk-p"></button><button type="button" class="lk lk-n"></button>';
  if (interactive) { cb.id = 'cb-' + it.id; lab.htmlFor = cb.id; }
  const acts = document.createElement('span'); acts.className = 'acts';
  acts.innerHTML = `<button type="button" class="copyto" aria-label="다른 날로 복사" title="다른 날로 복사" aria-haspopup="menu">${COPYICON}</button>`
    + `<button type="button" class="subadd" aria-label="세부 업무 추가" title="세부 업무 추가">${SUBICON}</button>`
    + `<button type="button" class="del" title="지우기">${XICON}</button>`
    + `<button type="button" class="more" aria-label="더 보기" aria-haspopup="menu">${MOREICON}</button>`;
  li.append(cb, lab, acts);
  return li;
}

function makeSubForm() {
  const li = document.createElement('li');
  li.className = 'item sub subform'; li.dataset.id = '__sub';
  li.innerHTML = '<span class="cb-ph" aria-hidden="true"></span><form class="subform-f" autocomplete="off"><input type="text" id="sub-input" name="sub-input" maxlength="300" placeholder="세부 업무 적고 Enter" aria-label="세부 업무 추가"></form>';
  return li;
}

const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };

function setLink(btn, ds, arrow) {
  if (!ds) { setText(btn, ''); return; }
  setText(btn, arrow === 'next' ? `→ ${short(ds)}` : `← ${short(ds)}`);
  btn.dataset.date = ds;
  const d = parse(ds);
  btn.title = `${d.getMonth() + 1}월 ${d.getDate()}일(${dayName(d)})로 가기`;
}

function reconcile(ul, rows, interactive, ds, ws, we) {
  // FLIP: remember where each row was, so moved rows glide to their new place
  const flip = interactive && !REDUCED && ul.children.length > 0 && typeof Element.prototype.animate === 'function';
  const before = flip ? new Map() : null;
  if (flip) for (const li of ul.children) before.set(li.dataset.id, li.getBoundingClientRect().top);

  const old = new Map();
  for (const li of ul.children) old.set(li.dataset.id, li);
  let ref = ul.firstChild;
  const editable = interactive && canEdit(ds);
  for (const it of rows) {
    let li = old.get(it.id);
    if (li) old.delete(it.id); else li = it.form ? makeSubForm() : makeItem(it, interactive);
    li.classList.toggle('sunk', !!it.sunk);
    if (!it.form) {
      const t = li.querySelector('.t');
      if (t.textContent !== it.text) { t.textContent = it.text; li.querySelector('.del').setAttribute('aria-label', `‘${it.text}’ 지우기`); }
      const cb = li.querySelector('.cb');
      if (cb.checked !== it.done) cb.checked = it.done;
      cb.disabled = !editable;
      li.classList.toggle('sub', !!it.sub);
      li.classList.toggle('done', !!it.done);
      li.classList.toggle('moved', !!it.moved);
      li.dataset.g = it.group || '';
      const nb = chainNbr.get(it.id) || {};
      setLink(li.querySelector('.lk-p'), nb.prev && nb.prev < ws ? nb.prev : '', 'prev');
      setLink(li.querySelector('.lk-n'), nb.next && nb.next > we ? nb.next : '', 'next');
      li.querySelector('.acts').hidden = !editable;
      li.querySelector('.subadd').hidden = !!it.sub;
    }
    if (li !== ref) ul.insertBefore(li, ref); else ref = ref.nextSibling;
  }
  old.forEach(li => li.remove());

  if (flip) {
    const anims = [];
    for (const li of ul.children) {
      const b = before.get(li.dataset.id);
      if (b == null) continue;
      const dy = b - li.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      anims.push(li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.75,.25,1)' }));
    }
    if (anims.length) Promise.all(anims.map(a => a.finished.catch(() => {}))).then(scheduleLinks);
  }
}

function fillWeek(p, mon, interactive) {
  const t = todayStr();
  const ws = ymd(mon), we = ymd(addDays(mon, 6));
  const spansMonths = mon.getMonth() !== addDays(mon, 6).getMonth();
  p.querySelectorAll('.day').forEach((sec, i) => {
    const d = addDays(mon, i), ds = ymd(d);
    sec.dataset.date = ds;
    sec.classList.toggle('today', ds === t);
    sec.classList.toggle('past', ds < t);
    sec.classList.toggle('sat', i === 5);
    sec.classList.toggle('sun', i === 6);
    sec.setAttribute('aria-label', `${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[i]}요일`);
    setText($('.mo', sec), spansMonths && (i === 0 || d.getDate() === 1) ? `${d.getMonth() + 1}월` : '');
    setText($('.dow', sec), DOW[i]);
    setText($('.num', sec), String(d.getDate()));
    const items = store.get(ds) || [];
    const done = items.filter(x => x.done).length;
    setText($('.cnt', sec), items.length ? `${done}/${items.length}` : '');
    const { list, doneFrom } = displayOrder(items);
    let parentMoved = false;
    const rows = list.map((it, k) => {
      const mv = hasNext(it.id);
      if (!it.sub) parentMoved = mv;
      return { ...it, moved: it.sub ? parentMoved || mv : mv, sunk: k >= doneFrom };
    });
    if (interactive && state.subEdit && state.subEdit.date === ds) {
      const pi = rows.findIndex(x => x.id === state.subEdit.parent);
      if (pi >= 0 && !rows[pi].sub && canEdit(ds)) rows.splice(blockEnd(rows, pi), 0, { id: '__sub', form: true, sunk: rows[pi].sunk });
      else state.subEdit = null;
    }
    reconcile($('.items', sec), rows, interactive, ds, ws, we);
    const ok = interactive && canEdit(ds);
    const inp = $('.add input', sec), btn = $('.add button', sec);
    inp.disabled = !ok; btn.disabled = !ok;
    inp.placeholder = state.readonly ? '읽기 전용' : (isLoaded(ds) ? '할 일 추가' : '불러오는 중…');
  });
}

function fillMonth(p, first, interactive) {
  const t = todayStr();
  const start = mondayOf(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const end = addDays(mondayOf(last), 6);
  const days = Math.round((end - start) / 864e5) + 1;
  let html = '<div class="mgrid">';
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i), ds = ymd(d), w = i % 7;
    const items = store.get(ds) || [];
    const tops = displayOrder(items).list.filter(x => !x.sub);
    const done = items.filter(x => x.done).length;
    const cls = ['mcell'];
    if (d.getMonth() !== first.getMonth()) cls.push('out');
    if (ds === t) cls.push('today');
    if (w === 5) cls.push('sat');
    if (w === 6) cls.push('sun');
    const lines = tops.slice(0, 3).map(it => `<span class="ml${it.done ? ' done' : ''}${hasNext(it.id) ? ' moved' : ''}">${esc(it.text)}</span>`).join('')
      + (tops.length > 3 ? `<span class="more-n">+${tops.length - 3}개</span>` : '');
    const dots = tops.slice(0, 6).map(it => {
      const c = [it.done ? 'on' : '', hasNext(it.id) ? 'mv' : ''].filter(Boolean).join(' ');
      return `<i${c ? ` class="${c}"` : ''}></i>`;
    }).join('');
    const label = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[w]}요일` + (items.length ? `, 할 일 ${items.length}개 중 ${done}개 완료` : '') + ', 주간 보기로 열기';
    html += `<button type="button" class="${cls.join(' ')}" data-date="${ds}" aria-label="${label}"${interactive ? '' : ' tabindex="-1"'}><span class="mnum">${d.getDate()}</span><span class="mlist">${lines}</span><span class="mdots">${dots}</span></button>`;
  }
  p.innerHTML = html + '</div>';
}

function renderPane(p, anchor, interactive) {
  if (p.dataset.kind !== state.view) {
    p.textContent = '';
    p.dataset.kind = state.view;
    if (state.view === 'week') buildWeek(p, interactive);
  }
  if (state.view === 'week') fillWeek(p, anchor, interactive);
  else fillMonth(p, anchor, interactive);
}

/* ---------- arrows ---------- */
// Orthogonal path with rounded corners through the given points.
function roundPath(pts, r) {
  const P = [];
  for (const p of pts) { const q = P[P.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 0.3 || Math.abs(q[1] - p[1]) > 0.3) P.push(p); }
  for (let i = P.length - 2; i > 0; i--) {
    const [x0, y0] = P[i - 1], [x1, y1] = P[i], [x2, y2] = P[i + 1];
    const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
    const dot = (x1 - x0) * (x2 - x1) + (y1 - y0) * (y2 - y1);
    if (Math.abs(cross) < 0.5 && dot > 0) P.splice(i, 1);
  }
  if (P.length < 2) return '';
  const f = n => n.toFixed(1);
  let d = `M${f(P[0][0])} ${f(P[0][1])}`;
  for (let i = 1; i < P.length - 1; i++) {
    const [x0, y0] = P[i - 1], [x1, y1] = P[i], [x2, y2] = P[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 - (x1 - x0) / l1 * rr, ay = y1 - (y1 - y0) / l1 * rr;
    const bx = x1 + (x2 - x1) / l2 * rr, by = y1 + (y2 - y1) / l2 * rr;
    d += ` L${f(ax)} ${f(ay)} Q${f(x1)} ${f(y1)} ${f(bx)} ${f(by)}`;
  }
  const z = P[P.length - 1];
  return d + ` L${f(z[0])} ${f(z[1])}`;
}

// Arrows leave the earlier task, run through the gaps between days (or along the line under
// the day headings when they skip days), and arrive at the later task's checkbox.
function drawLinks(p, pi) {
  const wk = p.querySelector('.week');
  if (!wk) return;
  let svg = wk.querySelector(':scope > svg.links');
  if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'links'); svg.setAttribute('aria-hidden', 'true'); wk.appendChild(svg); }
  if (!chainPairs.length) { if (svg.firstChild) svg.textContent = ''; svg.classList.remove('focus'); return; }
  const lis = new Map();
  wk.querySelectorAll('.item[data-id]').forEach(li => { if (!li.classList.contains('subform')) lis.set(li.dataset.id, li); });
  const base = wk.getBoundingClientRect();
  const ox = base.left + wk.clientLeft, oy = base.top + wk.clientTop;
  const wide = WIDE.matches, gap = 8;
  const cache = new Map();
  const geo = li => {
    let G = cache.get(li);
    if (G) return G;
    const day = li.closest('.day'), ul = li.parentElement;
    const cr = day.getBoundingClientRect(), ur = ul.getBoundingClientRect();
    const cb = li.querySelector('.cb').getBoundingClientRect(), dh = day.querySelector('.dh').getBoundingClientRect();
    const raw = cb.top + cb.height / 2, lo = ur.top + 6, hi = ur.bottom - 6;
    G = { day, L: cr.left - ox, R: cr.right - ox, cbx: cb.left - ox, y: Math.min(hi, Math.max(lo, raw)) - oy, off: raw < lo || raw > hi, rail: dh.bottom - oy };
    cache.set(li, G);
    return G;
  };
  const lanes = new Map();
  const lane = key => { const n = lanes.get(key) || 0; lanes.set(key, n + 1); return n; };
  const spread = n => [0, -2.5, 2.5][n % 3];
  const now = performance.now(), f = n => n.toFixed(1);
  let out = '', anyHl = false;
  for (const [a, b, g] of chainPairs) {
    const la = lis.get(a), lb = lis.get(b);
    if (!la || !lb) continue;
    const A = geo(la), B = geo(lb);
    const tip = B.cbx - 2, end = tip - 5;
    let pts, sx;
    if (wide && B.L > A.R - 1) {
      // later day is in a column to the right
      sx = A.R - 6;
      const g1 = A.R + gap / 2 + spread(lane('g' + Math.round(A.R)));
      const g2 = B.L - gap / 2 + spread(lane('g' + Math.round(B.L - gap)));
      if (B.L - A.R < gap * 2) pts = [[sx, A.y], [g1, A.y], [g1, B.y], [end, B.y]];
      else {
        const ry = A.rail + 4 + Math.min(lane('rail'), 2) * 3;
        pts = [[sx, A.y], [g1, A.y], [g1, ry], [g2, ry], [g2, B.y], [end, B.y]];
      }
    } else {
      // same column (phone, Sat → Sun, or the same day): a bracket on the left
      const k = Math.min(lane(wide ? 'c' + Math.round(A.L) : 'col'), 2);
      const bx = wide ? A.L - gap / 2 + spread(k) : Math.min(A.cbx, B.cbx) - 12 - k * 3;
      sx = A.cbx - 4;
      pts = [[sx, A.y], [bx, A.y], [bx, B.y], [end, B.y]];
    }
    const d = roundPath(pts, wide ? 6 : 5);
    if (!d) continue;
    const head = `M${f(tip - 6.5)} ${f(B.y - 4)} L${f(tip)} ${f(B.y)} L${f(tip - 6.5)} ${f(B.y + 4)} Z`;
    const t0 = justCopied.get(b);
    const isNew = !REDUCED && t0 != null && now - t0 < 900;
    const hl = !!focusG && g === focusG;
    if (hl) anyHl = true;
    out += `<g class="lnk${A.off || B.off ? ' off' : ''}${isNew ? ' new' : ''}${hl ? ' hl' : ''}" data-g="${esc(g)}"${isNew ? ` style="--d:${-Math.round(now - t0)}ms"` : ''}>`
      + `<path class="ln"${isNew ? ' pathLength="1"' : ''} d="${d}"/>`
      + `<circle class="dot" cx="${f(sx)}" cy="${f(A.y)}" r="2.5"/>`
      + `<path class="hd" d="${head}"/></g>`;
  }
  svg.innerHTML = out;
  svg.classList.toggle('focus', anyHl);
}
let linksRaf = 0;
function scheduleLinks() {
  cancelAnimationFrame(linksRaf);
  linksRaf = requestAnimationFrame(() => panes.forEach((p, i) => drawLinks(p, i)));
}
function setFocus(g) {
  if (g === focusG) return;
  focusG = g;
  panes.forEach(p => {
    const svg = p.querySelector('svg.links');
    if (!svg) return;
    let any = false;
    svg.querySelectorAll('.lnk').forEach(el => { const on = !!g && el.dataset.g === g; el.classList.toggle('hl', on); if (on) any = true; });
    svg.classList.toggle('focus', any);
  });
}

function countRange(a, n) {
  let done = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const items = store.get(ymd(addDays(a, i))) || [];
    total += items.length; done += items.filter(x => x.done).length;
  }
  return [done, total];
}

const HINT_KEY = 'wp.hint2';
let hintClosed = false;
try { hintClosed = localStorage.getItem(HINT_KEY) === '1'; } catch (e) {}
if (TOUCH) {
  $('#tip-menu').textContent = '할 일 옆 ⋯ 버튼을 누르면 다음 날이나 다음 주로 넘길 수 있어요. 복사한 할 일끼리는 화살표로 이어져요.';
  $('#tip-copy').textContent = '할 일을 길게 누른 채 다른 요일로 끌어도 복사돼요. 화면 양쪽 끝으로 끌고 가면 지난주·다음 주로 넘어가요.';
}

function renderHeader() {
  const now = new Date();
  let label, done, total, isNow;
  if (state.view === 'week') {
    const mon = state.anchor, sun = addDays(mon, 6);
    isNow = ymd(mon) === ymd(mondayOf(now));
    $('#title').textContent = weekLabel(mon);
    $('#eyebrow').textContent = `${mon.getFullYear()} · ${mon.getMonth() + 1}.${mon.getDate()} – ${sun.getMonth() + 1}.${sun.getDate()}`;
    $('#today').textContent = '이번 주';
    $('#prev').setAttribute('aria-label', '지난주');
    $('#next').setAttribute('aria-label', '다음 주');
    [done, total] = countRange(mon, 7);
    label = isNow ? '이번 주' : '이 주';
  } else {
    const f = state.anchor;
    const last = new Date(f.getFullYear(), f.getMonth() + 1, 0);
    isNow = f.getFullYear() === now.getFullYear() && f.getMonth() === now.getMonth();
    $('#title').textContent = `${f.getFullYear()}년 ${f.getMonth() + 1}월`;
    $('#eyebrow').textContent = `${f.getFullYear()} · ${f.getMonth() + 1}.1 – ${f.getMonth() + 1}.${last.getDate()}`;
    $('#today').textContent = '이번 달';
    $('#prev').setAttribute('aria-label', '지난달');
    $('#next').setAttribute('aria-label', '다음 달');
    [done, total] = countRange(f, last.getDate());
    label = isNow ? '이번 달' : '이 달';
  }
  $('#today').disabled = isNow;
  $('#ptext').textContent = total ? `${label} ${done} / ${total} 완료` : `${label} 할 일이 아직 없어요`;
  $('#pbar').style.width = total ? `${Math.round(done / total * 100)}%` : '0%';
  $('#v-week').setAttribute('aria-selected', String(state.view === 'week'));
  $('#v-month').setAttribute('aria-selected', String(state.view === 'month'));
  $('#dowRow').hidden = state.view !== 'month';
  $('#hint').hidden = hintClosed || state.view !== 'week' || state.readonly;
}

function fitHeight() { vp.style.height = panes[1].offsetHeight + 'px'; }

// On a computer the week fills exactly the space left under the header (and the tips box,
// when it is open), so every day stays inside the window at any window height.
function sizeWeek() {
  const root = document.documentElement;
  if (screens.app.hidden || !WIDE.matches || state.view !== 'week') { root.style.removeProperty('--week-h'); return; }
  const top = vp.getBoundingClientRect().top + scrollY;
  const h = Math.round(Math.min(980, Math.max(360, innerHeight - top - 2 - 16)));
  if (root.style.getPropertyValue('--week-h') !== `${h}px`) root.style.setProperty('--week-h', `${h}px`);
}

function render() {
  if (screens.app.hidden) return;
  computeChains();
  renderHeader();
  sizeWeek();
  panes.forEach((p, i) => renderPane(p, paneAnchor(i - 1), i === 1));
  fitHeight();
  scheduleLinks();
  setSync();
  if (menuFor && !menuFor.btn.isConnected) closeMenu(false);
}

if ('ResizeObserver' in window) new ResizeObserver(() => { fitHeight(); scheduleLinks(); }).observe(panes[1]);
window.addEventListener('resize', () => { sizeWeek(); scheduleLinks(); closeMenu(false); });
WIDE.addEventListener ? WIDE.addEventListener('change', () => render()) : WIDE.addListener(() => render());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { sizeWeek(); fitHeight(); scheduleLinks(); });
// the header can change height (status line wrapping, tips box): keep the week fitted
if ('ResizeObserver' in window) new ResizeObserver(() => sizeWeek()).observe($('.top'));
// a day's list scrolled: arrows follow, an open menu stays with its button
track.addEventListener('scroll', () => { scheduleLinks(); placeMenu(); }, true);
window.addEventListener('scroll', () => placeMenu(), { passive: true });

/* ---------- navigation ---------- */
let animating = false;

function slide(dir, target, after) {
  if (animating) return;
  closeMenu(false);
  const next = target || paneAnchor(dir);
  if (target) renderPane(panes[dir > 0 ? 2 : 0], target, false);
  const finish = () => {
    state.anchor = next;
    if (state.subEdit) state.subEdit = null;
    track.style.transition = 'none';
    track.style.transform = 'translateX(-100%)';
    ensureSub();
    render();
    void track.offsetWidth;
    animating = false;
    if (cdrag && cdrag.active) placeEdges();
    if (after) after();
  };
  if (REDUCED) { finish(); return; }
  animating = true;
  track.style.transition = 'transform 320ms cubic-bezier(.22,.8,.24,1)';
  track.style.transform = `translateX(${dir > 0 ? '-200%' : '0%'})`;
  let fired = false;
  const fin = e => {
    if (e && e.target !== track) return;
    if (fired) return; fired = true;
    track.removeEventListener('transitionend', fin);
    finish();
  };
  track.addEventListener('transitionend', fin);
  setTimeout(() => fin(), 420);
}

function goToday() {
  const now = new Date();
  const target = state.view === 'week' ? mondayOf(now) : firstOfMonth(now);
  if (ymd(target) === ymd(state.anchor)) return;
  const dir = target > state.anchor ? 1 : -1;
  if (ymd(paneAnchor(dir)) === ymd(target)) slide(dir); else slide(dir, target);
}

function setView(v, anchor) {
  if (animating) return;
  closeMenu(false);
  const prevView = state.view;
  state.view = v;
  state.subEdit = null;
  if (anchor) state.anchor = anchor;
  else if (v !== prevView) {
    if (v === 'week') {
      const now = new Date(), f = state.anchor;
      state.anchor = (now.getFullYear() === f.getFullYear() && now.getMonth() === f.getMonth()) ? mondayOf(now) : mondayOf(f);
    } else {
      state.anchor = firstOfMonth(addDays(state.anchor, 3));
    }
  }
  try { localStorage.setItem('wp.view', v); } catch (e) {}
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
  ensureSub();
  render();
}

function flashDay(ds) {
  requestAnimationFrame(() => {
    const sec = panes[1].querySelector(`.day[data-date="${ds}"]`);
    if (!sec) return;
    sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
    if (!WIDE.matches) sec.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' });
  });
}
function openDay(ds) { setView('week', mondayOf(parse(ds))); flashDay(ds); }
// Jump to a date's week; slide when it is the week next door.
function goToDate(ds) {
  const mon = mondayOf(parse(ds));
  const diff = Math.round((mon - state.anchor) / (7 * 864e5));
  if (state.view === 'week' && diff === 0) { flashDay(ds); return; }
  if (state.view === 'week' && Math.abs(diff) === 1) slide(diff, null, () => flashDay(ds));
  else openDay(ds);
}

$('#prev').addEventListener('click', () => slide(-1));
$('#next').addEventListener('click', () => slide(1));
$('#today').addEventListener('click', goToday);
$('#v-week').addEventListener('click', () => { if (state.view !== 'week') setView('week'); });
$('#v-month').addEventListener('click', () => { if (state.view !== 'month') setView('month'); });
$('#hint-close').addEventListener('click', () => {
  hintClosed = true; $('#hint').hidden = true;
  try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
  sizeWeek();
});
window.addEventListener('hashchange', () => {
  const v = location.hash === '#month' ? 'month' : location.hash === '#week' ? 'week' : null;
  if (v && v !== state.view) setView(v);
});

/* ---------- copy menu ---------- */
const menu = $('#menu');
let menuFor = null;   // { btn, li, ds, id }

function closeMenu(refocus) {
  if (!menuFor) return;
  const { btn, li } = menuFor;
  menuFor = null;
  menu.hidden = true; menu.textContent = '';
  btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
  li.classList.remove('menuing');
  if (refocus && btn.isConnected) btn.focus();
}
function placeMenu() {
  if (!menuFor) return;
  const r = menuFor.btn.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || (!r.width && !r.height)) { closeMenu(false); return; }
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = Math.min(innerWidth - mw - 8, Math.max(8, r.right - mw));
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
}
function openMenu(btn, ds, id, full) {
  closeMenu(false);
  const items = store.get(ds) || [];
  const it = items.find(x => x.id === id);
  if (!it) return;
  const li = btn.closest('.item');
  const d = parse(ds);
  const lab = dd => `${dd.getMonth() + 1}.${dd.getDate()} ${dayName(dd)}`;
  const nextDay = addDays(d, 1), nextWeek = addDays(d, 7), nextMon = addDays(mondayOf(d), 7);
  menu.textContent = '';
  const item = (html, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mi' + (cls ? ' ' + cls : ''); b.setAttribute('role', 'menuitem');
    b.innerHTML = html; b.addEventListener('click', fn);
    menu.appendChild(b);
  };
  const heading = t => { const h = document.createElement('div'); h.className = 'mh'; h.textContent = t; menu.appendChild(h); };
  const rule = () => { const s = document.createElement('div'); s.className = 'msep'; menu.appendChild(s); };
  const go = dd => { closeMenu(false); copyTo(ds, id, ymd(dd)); };

  if (full && !it.sub) { item('<span>세부 업무 추가</span>', () => { closeMenu(false); openSub(ds, id); }); rule(); }
  heading('복사해서 넘기기');
  item(`<span>다음 날</span><em>${lab(nextDay)}</em>`, () => go(nextDay));
  item(`<span>다음 주 같은 요일</span><em>${lab(nextWeek)}</em>`, () => go(nextWeek));
  if (ymd(nextMon) !== ymd(nextWeek)) item(`<span>다음 주 월요일</span><em>${lab(nextMon)}</em>`, () => go(nextMon));
  const row = document.createElement('div');
  row.className = 'mdate';
  row.innerHTML = '<span>날짜 고르기</span><input type="date" id="copy-date" name="copy-date" aria-label="복사할 날짜"><button type="button">복사</button>';
  const inp = row.querySelector('input');
  inp.value = ymd(addDays(d, 1));
  row.querySelector('button').addEventListener('click', () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.value)) { inp.focus(); return; }
    go(parse(inp.value));
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); row.querySelector('button').click(); } });
  menu.appendChild(row);
  if (full) { rule(); item('<span>지우기</span>', () => { closeMenu(false); removeItem(ds, id); }, 'danger'); }

  menuFor = { btn, li, ds, id };
  btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
  li.classList.add('menuing');
  menu.hidden = false;
  placeMenu();
  const first = menu.querySelector('.mi');
  if (first) first.focus({ preventScroll: true });
}
menu.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
  if (e.target.tagName === 'INPUT') return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const list = [...menu.querySelectorAll('button.mi, .mdate input, .mdate button')];
  const i = list.indexOf(document.activeElement);
  const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
  list[n].focus();
});
document.addEventListener('pointerdown', e => {
  if (menuFor && !menu.contains(e.target) && !menuFor.btn.contains(e.target)) closeMenu(false);
}, true);

function openSub(ds, id) {
  const same = state.subEdit && state.subEdit.parent === id;
  state.subEdit = same ? null : { date: ds, parent: id };
  render();
  const si = $('#sub-input');
  if (si && !same) { si.value = ''; si.focus(); }
}

/* ---------- pointer: swipe weeks, Ctrl-drag (or long-press) to copy ---------- */
let drag = null, cdrag = null, ghost = null, suppressClick = false, autoRaf = 0;
const dropLine = $('#dropline'), edgeL = $('#edge-l'), edgeR = $('#edge-r');
const EDGE = 40;

function clearDrop() {
  panes[1].querySelectorAll('.day.drop').forEach(el => el.classList.remove('drop'));
  dropLine.hidden = true;
}
function placeEdges() {
  const r = vp.getBoundingClientRect();
  const top = Math.max(r.top, 8), bottom = Math.min(r.bottom, innerHeight - 8);
  const h = Math.max(80, bottom - top);
  edgeL.style.left = `${r.left + 4}px`; edgeR.style.left = `${r.right - EDGE - 4}px`;
  for (const el of [edgeL, edgeR]) { el.style.top = `${top}px`; el.style.height = `${h}px`; }
}

function cdStart(x, y) {
  const li = cdrag.li, day = li.closest('.day');
  cdrag.src = day.dataset.date; cdrag.id = li.dataset.id;
  const items = store.get(cdrag.src) || [];
  const i = items.findIndex(x2 => x2.id === cdrag.id);
  if (i < 0) { cdEnd(true); return; }
  const n = blockEnd(items, i) - i - 1;
  cdrag.active = true;
  closeMenu(false);
  ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.innerHTML = '<b aria-hidden="true">+</b><span></span>';
  ghost.lastChild.textContent = items[i].text + (n ? ` · 세부 ${n}` : '');
  document.body.appendChild(ghost);
  li.classList.add('src');
  try { vp.setPointerCapture(cdrag.pid); } catch (e) {}
  document.documentElement.classList.add('copying');
  placeEdges();
  cdMove(x, y);
  if (!autoRaf) autoRaf = requestAnimationFrame(autoScroll);
}

// While dragging near the top or bottom of the screen, scroll the page (long weeks on a phone).
function autoScroll() {
  if (!cdrag || !cdrag.active) { autoRaf = 0; return; }
  const y = cdrag.y, zone = 70;
  let v = 0;
  if (y < zone) v = -Math.ceil((zone - y) / 5);
  else if (y > innerHeight - zone) v = Math.ceil((y - (innerHeight - zone)) / 5);
  if (v) { const before = scrollY; scrollBy(0, v); if (scrollY !== before) { placeEdges(); cdMove(cdrag.x, cdrag.y); } }
  autoRaf = requestAnimationFrame(autoScroll);
}

function cdMove(x, y) {
  cdrag.x = x; cdrag.y = y;
  ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
  const r = vp.getBoundingClientRect();
  const edge = x < r.left + EDGE + 4 ? -1 : x > r.right - EDGE - 4 ? 1 : 0;
  edgeL.classList.toggle('on', edge < 0);
  edgeR.classList.toggle('on', edge > 0);
  if (edge !== cdrag.edge) {
    cdrag.edge = edge;
    clearTimeout(cdrag.edgeT);
    if (edge) {
      const step = () => {
        if (!cdrag || cdrag.edge !== edge) return;
        slide(edge);
        cdrag.edgeT = setTimeout(step, 950);
      };
      cdrag.edgeT = setTimeout(step, 600);
    }
  }
  clearDrop();
  cdrag.target = null;
  if (animating) return;
  const el = document.elementFromPoint(x, y);
  const day = el && el.closest ? el.closest('.day') : null;
  if (!day || !panes[1].contains(day) || !canEdit(day.dataset.date)) return;
  const ds = day.dataset.date, items = store.get(ds) || [];
  const ul = day.querySelector('.items');
  const ur = ul.getBoundingClientRect();
  let index = -1, lineY = null;
  // open tasks only: a new copy is never dropped among completed ones
  for (const li of ul.children) {
    if (!li.dataset.id || li.classList.contains('sub')) continue;
    const rr = li.getBoundingClientRect();
    if (li.classList.contains('sunk')) { lineY = rr.top; break; }
    if (y < rr.top + rr.height / 2) { index = items.findIndex(x2 => x2.id === li.dataset.id); lineY = rr.top; break; }
  }
  if (lineY === null) { const lastLi = ul.lastElementChild; lineY = lastLi ? lastLi.getBoundingClientRect().bottom : ur.top + 4; }
  lineY = Math.min(Math.max(lineY, ur.top + 1), ur.bottom - 1);
  day.classList.add('drop');
  dropLine.hidden = false;
  dropLine.style.width = `${Math.max(40, ur.width - 8)}px`;
  dropLine.style.transform = `translate(${ur.left + 4}px, ${lineY - 1}px)`;
  cdrag.target = ds; cdrag.index = index;
}

function cdEnd(cancel) {
  const c = cdrag; cdrag = null;
  if (!c) return;
  clearTimeout(c.edgeT);
  edgeL.classList.remove('on'); edgeR.classList.remove('on');
  document.documentElement.classList.remove('copying');
  if (ghost) { ghost.remove(); ghost = null; }
  clearDrop();
  panes[1].querySelectorAll('.item.src').forEach(li => li.classList.remove('src'));
  if (!c.active) return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
  if (!cancel && c.target && !animating) copyItem(c.src, c.id, c.target, c.index);
}

vp.addEventListener('pointerdown', e => {
  if (animating || drag || cdrag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('.add, .acts, .subform, .lk')) return;
  // grabbing a list's scrollbar scrolls the list, not the week
  const sc = e.target.closest('.items');
  if (sc && e.target === sc && e.offsetX >= sc.clientWidth) return;
  const li = state.view === 'week' ? e.target.closest('.item') : null;
  const day = li && li.closest('.day');
  const copyable = !!(li && day && panes[1].contains(li) && canEdit(day.dataset.date));
  if (copyable && e.pointerType !== 'touch' && (e.ctrlKey || e.metaKey)) {
    cdrag = { pid: e.pointerId, li, x0: e.clientX, y0: e.clientY, active: false, edge: 0 };
    e.preventDefault();
    return;
  }
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY, dx: 0, v: 0, lastX: e.clientX, lastT: e.timeStamp, active: false, lp: 0 };
  if (copyable && e.pointerType === 'touch') {
    drag.lp = setTimeout(() => {
      if (!drag || drag.active) return;
      const d = drag; drag = null;
      cdrag = { pid: d.id, li, x0: d.x0, y0: d.y0, active: false, edge: 0 };
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      cdStart(d.cx, d.cy);
    }, 450);
  }
  if (e.pointerType === 'mouse') e.preventDefault();
});

vp.addEventListener('pointermove', e => {
  if (cdrag && e.pointerId === cdrag.pid) {
    if (!cdrag.active) {
      if (Math.hypot(e.clientX - cdrag.x0, e.clientY - cdrag.y0) > 4) cdStart(e.clientX, e.clientY);
      else return;
    }
    if (cdrag) cdMove(e.clientX, e.clientY);
    e.preventDefault();
    return;
  }
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  drag.cx = e.clientX; drag.cy = e.clientY;
  if (!drag.active) {
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(drag.lp);
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      drag.active = true;
      closeMenu(false);
      try { vp.setPointerCapture(e.pointerId); } catch (err) {}
      document.documentElement.classList.add('dragging');
      track.style.transition = 'none';
    } else if (Math.abs(dy) > 12) { drag = null; return; }
    else return;
  }
  const dt = e.timeStamp - drag.lastT;
  if (dt > 0) { drag.v = (e.clientX - drag.lastX) / dt; drag.lastX = e.clientX; drag.lastT = e.timeStamp; }
  drag.dx = dx;
  track.style.transform = `translateX(calc(-100% + ${dx}px))`;
  e.preventDefault();
});

vp.addEventListener('touchmove', e => { if (cdrag && cdrag.active) e.preventDefault(); }, { passive: false });
vp.addEventListener('contextmenu', e => { if (cdrag || (drag && drag.lp)) e.preventDefault(); });

function endDrag(e, cancelled) {
  if (cdrag && e.pointerId === cdrag.pid) { cdEnd(cancelled); return; }
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null;
  clearTimeout(d.lp);
  if (!d.active) return;
  document.documentElement.classList.remove('dragging');
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
  const th = Math.min(110, vp.clientWidth * 0.2);
  let dir = 0;
  if (!cancelled) {
    if (d.dx < -th || (d.v < -0.45 && d.dx < -30)) dir = 1;
    else if (d.dx > th || (d.v > 0.45 && d.dx > 30)) dir = -1;
  }
  if (dir) { slide(dir); return; }
  animating = true;
  track.style.transition = 'transform 240ms ease';
  track.style.transform = 'translateX(-100%)';
  setTimeout(() => { track.style.transition = 'none'; animating = false; }, 260);
}
window.addEventListener('pointerup', e => endDrag(e, false), true);
window.addEventListener('pointercancel', e => endDrag(e, true), true);
vp.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } }, true);

/* ---------- keys ---------- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && cdrag) { cdEnd(true); return; }
  if (screens.app.hidden || menuFor) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const tg = e.target;
  if (tg && tg.tagName === 'INPUT' && tg.type !== 'checkbox') return;
  if (tg && tg.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); slide(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); slide(1); }
});

/* ---------- item events ---------- */
track.addEventListener('change', e => {
  const cb = e.target.closest('.cb'); if (!cb) return;
  const li = cb.closest('.item'), day = cb.closest('.day');
  if (li && day) toggleItem(day.dataset.date, li.dataset.id, cb.checked);
});
track.addEventListener('click', e => {
  const lk = e.target.closest('.lk');
  if (lk) { e.preventDefault(); if (lk.dataset.date) goToDate(lk.dataset.date); return; }
  const btn = e.target.closest('.acts button');
  if (btn) {
    const li = btn.closest('.item'), day = btn.closest('.day');
    if (!li || !day) return;
    const ds = day.dataset.date, id = li.dataset.id;
    if (btn.classList.contains('del')) removeItem(ds, id);
    else if (btn.classList.contains('subadd')) openSub(ds, id);
    else if (menuFor && menuFor.btn === btn) closeMenu(true);
    else openMenu(btn, ds, id, btn.classList.contains('more'));
    return;
  }
  const cell = e.target.closest('.mcell');
  if (cell) { openDay(cell.dataset.date); return; }
  // a click on the empty part of a day goes to its "할 일 추가" box
  const day = e.target.closest('.day');
  if (day && panes[1].contains(day) && (e.target === day || e.target.classList.contains('items'))) {
    const inp = day.querySelector('.add input');
    if (inp && !inp.disabled) inp.focus();
  }
});
track.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, day = f.closest('.day');
  if (!day) return;
  const inp = f.querySelector('input');
  if (f.classList.contains('subform-f')) {
    if (state.subEdit && addSub(day.dataset.date, state.subEdit.parent, inp.value)) inp.value = '';
    inp.focus();
    return;
  }
  if (addItem(day.dataset.date, inp.value)) {
    inp.value = '';
    const ul = day.querySelector('.items');
    if (ul && ul.scrollHeight > ul.clientHeight) {
      // keep the new task in view: it sits just above the completed ones
      requestAnimationFrame(() => {
        const items = store.get(day.dataset.date) || [];
        const last = items[items.length - 1];
        const li = last && ul.querySelector(`.item[data-id="${last.id}"]`);
        if (li) li.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
      });
    }
  }
  inp.focus();
});
track.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.id === 'sub-input') { state.subEdit = null; render(); }
});
track.addEventListener('focusout', e => {
  if (e.target.id !== 'sub-input') return;
  setTimeout(() => {
    const si = $('#sub-input');
    if (!state.subEdit || !si || document.activeElement === si) return;
    if (!si.value.trim()) { state.subEdit = null; render(); }
  }, 150);
});
// hovering a task lights up its copy chain
track.addEventListener('pointerover', e => {
  if (cdrag || drag) return;
  const li = e.target.closest && e.target.closest('.item');
  setFocus(li && li.dataset.g ? li.dataset.g : null);
});
track.addEventListener('pointerleave', () => setFocus(null));

/* ---------- toast ---------- */
let toastTimer = 0, toastAction = null;
function toast(msg, actionLabel, action) {
  const el = $('#toast'), b = $('#toast-btn');
  $('#toast-msg').textContent = msg;
  b.hidden = !actionLabel; b.textContent = actionLabel || '';
  toastAction = action || null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastAction = null; }, actionLabel ? 5000 : 7000);
}
$('#toast-btn').addEventListener('click', () => {
  const a = toastAction; toastAction = null; $('#toast').hidden = true; clearTimeout(toastTimer);
  if (a) a();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ---------- login ---------- */
let signupMode = false;
const AUTH_MSG = {
  'auth/invalid-email': '이메일 주소 형식을 확인해 주세요.',
  'auth/missing-email': '이메일을 입력해 주세요.',
  'auth/missing-password': '비밀번호를 입력해 주세요.',
  'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/invalid-login-credentials': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/wrong-password': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/user-not-found': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/email-already-in-use': '이미 가입된 이메일이에요. 로그인해 주세요.',
  'auth/weak-password': '비밀번호는 6자 이상으로 정해 주세요.',
  'auth/too-many-requests': '시도가 너무 많았어요. 잠시 후 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
  'auth/unauthorized-domain': '이 주소가 Firebase 승인된 도메인에 없어요. README의 "승인된 도메인" 단계를 확인해 주세요.',
  'auth/operation-not-allowed': 'Firebase에서 이 로그인 방식이 꺼져 있어요. Authentication → 로그인 방법에서 켜 주세요.',
  'auth/popup-blocked': '팝업이 막혔어요. 브라우저에서 팝업을 허용해 주세요.',
  'auth/user-disabled': '사용이 중지된 계정이에요.',
};
function showErr(e) {
  const code = (e && e.code) || '';
  const el = $('#login-err');
  el.textContent = AUTH_MSG[code] || `로그인하지 못했어요. 잠시 후 다시 해 주세요.${code ? ` (${code})` : ''}`;
  el.hidden = false; $('#login-ok').hidden = true;
}
function showOk(msg) { const el = $('#login-ok'); el.textContent = msg; el.hidden = false; $('#login-err').hidden = true; }
function clearMsgs() { $('#login-err').hidden = true; $('#login-ok').hidden = true; }
function setBusy(on) { ['#google-btn', '#email-submit', '#mode-toggle', '#reset-btn'].forEach(s => { $(s).disabled = on; }); }
function setMode(signup) {
  signupMode = signup;
  $('#email-submit').textContent = signup ? '계정 만들기' : '로그인';
  $('#mode-toggle').textContent = signup ? '이미 계정이 있어요 · 로그인' : '처음이세요? 계정 만들기';
  $('#login-pw').autocomplete = signup ? 'new-password' : 'current-password';
  $('#reset-btn').hidden = signup;
  clearMsgs();
}

$('#mode-toggle').addEventListener('click', () => setMode(!signupMode));
$('#google-btn').addEventListener('click', async () => {
  if (!F) return;
  clearMsgs(); setBusy(true);
  const provider = new F.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await F.signInWithPopup(auth, provider);
  } catch (e) {
    const code = e && e.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/web-storage-unsupported') {
      try { await F.signInWithRedirect(auth, provider); return; } catch (e2) { showErr(e2); }
    } else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
      showErr(e);
    }
  } finally { setBusy(false); }
});
$('#email-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!F) return;
  clearMsgs();
  const email = $('#login-email').value.trim(), pw = $('#login-pw').value;
  if (!email) { showErr({ code: 'auth/missing-email' }); return; }
  if (!pw) { showErr({ code: 'auth/missing-password' }); return; }
  setBusy(true);
  try {
    if (signupMode) await F.createUserWithEmailAndPassword(auth, email, pw);
    else await F.signInWithEmailAndPassword(auth, email, pw);
  } catch (err) { showErr(err); }
  finally { setBusy(false); }
});
$('#reset-btn').addEventListener('click', async () => {
  if (!F) return;
  const email = $('#login-email').value.trim();
  if (!email) { showErr({ code: 'auth/missing-email' }); $('#login-email').focus(); return; }
  setBusy(true);
  try { await F.sendPasswordResetEmail(auth, email); showOk(`${email}로 비밀번호 재설정 메일을 보냈어요. 메일함(스팸함 포함)을 확인해 주세요.`); }
  catch (err) { showErr(err); }
  finally { setBusy(false); }
});
$('#logout').addEventListener('click', async () => {
  if (!F) return;
  flush();
  try { await F.signOut(auth); } catch (e) { toast('로그아웃하지 못했어요. 다시 눌러 주세요.'); }
});

/* ---------- session ---------- */
function startSession(user) {
  if (currentUid === user.uid) return;
  stopSub(); store.clear(); dirty.clear(); settling.clear();
  currentUid = user.uid;
  col = F.collection(db, 'weekplanner', user.uid, 'days');
  Object.assign(state, { mode: 'db', readonly: false, error: false, errorText: '', subEdit: null });
  $('#acct-email').textContent = user.email || user.displayName || '로그인됨';
  $('#acct-email').title = user.email || '';
  show('app');
  ensureSub();
  render();
}
function endSession() {
  closeMenu(false);
  stopSub(); store.clear(); dirty.clear(); settling.clear();
  currentUid = null; col = null; state.mode = 'loading';
  panes.forEach(p => { p.textContent = ''; delete p.dataset.kind; });
  $('#login-pw').value = '';
  setMode(false);
  show('login');
}

/* ---------- start ---------- */
const configured = !!(firebaseConfig && typeof firebaseConfig.apiKey === 'string' && firebaseConfig.apiKey
  && !/여기에|YOUR_|붙여/i.test(firebaseConfig.apiKey) && firebaseConfig.projectId && !/프로젝트/.test(firebaseConfig.projectId));

async function boot() {
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
    ]);
    F = { ...authMod, ...fsMod };
    const app = appMod.initializeApp(firebaseConfig);
    auth = F.getAuth(app);
    try {
      db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch (e) {
      db = F.getFirestore(app);
    }
  } catch (e) {
    $('#boot-msg').textContent = 'Firebase를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.';
    return;
  }
  F.getRedirectResult(auth).catch(e => { show('login'); showErr(e); });
  F.onAuthStateChanged(auth, user => { if (user) startSession(user); else endSession(); });
}

if (configured) boot(); else show('setup');
