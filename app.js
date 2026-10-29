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

/* ---------- dates (local time) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const firstOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const todayStr = () => ymd(new Date());
const short = ds => { const d = parse(ds); return `${d.getMonth() + 1}.${d.getDate()}`; };
const weekLabel = mon => { const thu = addDays(mon, 3); return `${thu.getMonth() + 1}월 ${Math.ceil(thu.getDate() / 7)}주차`; };
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const store = new Map();            // 'YYYY-MM-DD' -> items
const dirty = new Set();            // changed locally, not yet sent to Firestore
let pending = 0;                    // writes sent but not yet confirmed by the server
let F = null, auth = null, db = null, col = null, currentUid = null;
let unsub = null, sub = null, loadedRange = null, loadFallback = 0, flushTimer = 0;

const pack = it => { const o = { id: it.id, text: it.text, done: !!it.done }; if (it.sub) o.sub = true; if (it.group) o.group = it.group; return o; };
const clean = items => Array.isArray(items)
  ? items.filter(it => it && typeof it.id === 'string' && typeof it.text === 'string')
      .map(it => pack({ id: it.id.slice(0, 40), text: it.text.slice(0, 300), done: it.done, sub: !!it.sub, group: typeof it.group === 'string' ? it.group.slice(0, 40) : '' }))
  : [];
const blockEnd = (items, i) => { let j = i + 1; if (!items[i].sub) while (j < items.length && items[j].sub) j++; return j; };

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
  const it = { id: newId(), text, done: false };
  if (asSub && items.some(x => !x.sub)) it.sub = true;
  store.set(ds, [...items, it]);
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
  if (!items[i].sub) for (let j = i + 1; j < items.length && items[j].sub; j++) items[j].done = done;
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
function copyItem(src, id, dst, index) {
  if (!canEdit(src) || !canEdit(dst)) return;
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
  if (src !== dst && !hadGroup) touch(src);
  touch(dst);
  const d = parse(dst);
  toast(`${d.getMonth() + 1}월 ${d.getDate()}일로 복사했어요`, '되돌리기', () => {
    const ids = new Set(copies.map(c => c.id));
    store.set(dst, (store.get(dst) || []).filter(x => !ids.has(x.id)));
    if (!hadGroup) store.set(src, (store.get(src) || []).map(x => { if (x.id !== id) return x; const y = { ...x }; delete y.group; return y; }));
    if (src !== dst && !hadGroup) touch(src);
    touch(dst);
  });
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
  groups.forEach(list => {
    if (list.length < 2) return;
    list.sort((a, b) => a.ds < b.ds ? -1 : a.ds > b.ds ? 1 : a.idx - b.idx);
    for (let k = 0; k < list.length - 1; k++) {
      const a = list[k], b = list[k + 1];
      chainPairs.push([a.id, b.id]);
      nb(a.id).next = b.ds; nb(b.id).prev = a.ds;
    }
  });
}

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
    sec.innerHTML = `<header class="dh"><span class="mo"></span><span class="dow"></span><span class="num"></span><span class="cnt"></span></header><ul class="items"></ul><form class="add" autocomplete="off"><input type="text" maxlength="300" aria-label="할 일 추가" placeholder="할 일 추가"><button type="submit" aria-label="추가">${PLUS}</button></form>`;
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
  lab.innerHTML = '<span class="t"></span><span class="lk lk-p"></span><span class="lk lk-n"></span>';
  if (interactive) { cb.id = 'cb-' + it.id; lab.htmlFor = cb.id; }
  const acts = document.createElement('span'); acts.className = 'acts';
  acts.innerHTML = `<button type="button" class="subadd" aria-label="세부 업무 추가">${SUBICON}</button><button type="button" class="del">${XICON}</button>`;
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

function reconcile(ul, rows, interactive, ds, ws, we) {
  const old = new Map();
  for (const li of ul.children) old.set(li.dataset.id, li);
  let ref = ul.firstChild;
  const editable = interactive && canEdit(ds);
  for (const it of rows) {
    let li = old.get(it.id);
    if (li) old.delete(it.id); else li = it.form ? makeSubForm() : makeItem(it, interactive);
    if (!it.form) {
      const t = li.querySelector('.t');
      if (t.textContent !== it.text) { t.textContent = it.text; li.querySelector('.del').setAttribute('aria-label', `‘${it.text}’ 지우기`); }
      const cb = li.querySelector('.cb');
      if (cb.checked !== it.done) cb.checked = it.done;
      cb.disabled = !editable;
      li.classList.toggle('sub', !!it.sub);
      li.classList.toggle('done', !!it.done);
      const nb = chainNbr.get(it.id) || {};
      setText(li.querySelector('.lk-p'), nb.prev && nb.prev < ws ? `← ${short(nb.prev)}` : '');
      setText(li.querySelector('.lk-n'), nb.next && nb.next > we ? `→ ${short(nb.next)}` : '');
      li.querySelector('.acts').hidden = !editable;
      li.querySelector('.subadd').hidden = !!it.sub;
    }
    if (li !== ref) ul.insertBefore(li, ref); else ref = ref.nextSibling;
  }
  old.forEach(li => li.remove());
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
    const rows = [...items];
    if (interactive && state.subEdit && state.subEdit.date === ds) {
      const pi = items.findIndex(x => x.id === state.subEdit.parent);
      if (pi >= 0 && !items[pi].sub && canEdit(ds)) rows.splice(blockEnd(items, pi), 0, { id: '__sub', form: true });
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
    const tops = items.filter(x => !x.sub);
    const done = items.filter(x => x.done).length;
    const cls = ['mcell'];
    if (d.getMonth() !== first.getMonth()) cls.push('out');
    if (ds === t) cls.push('today');
    if (w === 5) cls.push('sat');
    if (w === 6) cls.push('sun');
    const lines = tops.slice(0, 3).map(it => `<span class="ml${it.done ? ' done' : ''}">${esc(it.text)}</span>`).join('')
      + (tops.length > 3 ? `<span class="more">+${tops.length - 3}개</span>` : '');
    const dots = tops.slice(0, 6).map(it => `<i${it.done ? ' class="on"' : ''}></i>`).join('');
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

function drawLinks(p, pi) {
  const wk = p.querySelector('.week');
  if (!wk) return;
  let svg = wk.querySelector(':scope > svg.links');
  if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'links'); svg.setAttribute('aria-hidden', 'true'); wk.appendChild(svg); }
  const base = wk.getBoundingClientRect();
  const ox = base.left + wk.clientLeft, oy = base.top + wk.clientTop;
  const lis = new Map();
  wk.querySelectorAll('.item[data-id]').forEach(li => { if (!li.classList.contains('subform')) lis.set(li.dataset.id, li); });
  const bulge = WIDE.matches ? 10 : 13;
  let d = '';
  for (const [a, b] of chainPairs) {
    const la = lis.get(a), lb = lis.get(b);
    if (!la || !lb) continue;
    const ra = la.getBoundingClientRect(), rb = lb.getBoundingClientRect();
    const ca = la.querySelector('.cb').getBoundingClientRect(), cbx = lb.querySelector('.cb').getBoundingClientRect();
    const ya = ca.top + ca.height / 2 - oy, yb = cbx.top + cbx.height / 2 - oy;
    if (ra.right < rb.left - 1) {
      const sx = ra.right - ox + 1, ex = cbx.left - ox - 4;
      const dx = Math.max(20, (ex - sx) * 0.45);
      d += `<path class="ln" d="M${sx.toFixed(1)} ${ya.toFixed(1)} C${(sx + dx).toFixed(1)} ${ya.toFixed(1)}, ${(ex - dx).toFixed(1)} ${yb.toFixed(1)}, ${ex.toFixed(1)} ${yb.toFixed(1)}" marker-end="url(#ah${pi})"/>`;
    } else {
      const x1 = ra.right - ox + 2, x2 = rb.right - ox + 2, bx = Math.max(x1, x2) + bulge;
      d += `<path class="ln" d="M${x1.toFixed(1)} ${ya.toFixed(1)} C${bx.toFixed(1)} ${ya.toFixed(1)}, ${bx.toFixed(1)} ${yb.toFixed(1)}, ${x2.toFixed(1)} ${yb.toFixed(1)}" marker-end="url(#ah${pi})"/>`;
    }
  }
  svg.innerHTML = d ? `<defs><marker id="ah${pi}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="ah" d="M2 1.5 8.5 5 2 8.5"/></marker></defs>${d}` : '';
}
let linksRaf = 0;
function scheduleLinks() {
  cancelAnimationFrame(linksRaf);
  linksRaf = requestAnimationFrame(() => panes.forEach((p, i) => drawLinks(p, i)));
}

function countRange(a, n) {
  let done = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const items = store.get(ymd(addDays(a, i))) || [];
    total += items.length; done += items.filter(x => x.done).length;
  }
  return [done, total];
}

let hintClosed = false;
try { hintClosed = localStorage.getItem('wp.hint') === '1'; } catch (e) {}
if (TOUCH) $('#tip-copy').textContent = '할 일을 길게 누른 채 다른 요일로 끌면 복사되고, 먼저 날짜에서 나중 날짜로 화살표가 이어져요. 화면 왼쪽·오른쪽 끝까지 끌고 가면 다른 주로 넘어가요.';

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

function render() {
  if (screens.app.hidden) return;
  computeChains();
  renderHeader();
  panes.forEach((p, i) => renderPane(p, paneAnchor(i - 1), i === 1));
  fitHeight();
  scheduleLinks();
  setSync();
}

if ('ResizeObserver' in window) new ResizeObserver(() => { fitHeight(); scheduleLinks(); }).observe(panes[1]);
window.addEventListener('resize', scheduleLinks);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fitHeight(); scheduleLinks(); });

/* ---------- navigation ---------- */
let animating = false;

function slide(dir, target) {
  if (animating) return;
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

function openDay(ds) {
  setView('week', mondayOf(parse(ds)));
  requestAnimationFrame(() => {
    const sec = panes[1].querySelector(`.day[data-date="${ds}"]`);
    if (!sec) return;
    sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
    if (!WIDE.matches) sec.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' });
  });
}

$('#prev').addEventListener('click', () => slide(-1));
$('#next').addEventListener('click', () => slide(1));
$('#today').addEventListener('click', goToday);
$('#v-week').addEventListener('click', () => { if (state.view !== 'week') setView('week'); });
$('#v-month').addEventListener('click', () => { if (state.view !== 'month') setView('month'); });
$('#hint-close').addEventListener('click', () => {
  hintClosed = true; $('#hint').hidden = true;
  try { localStorage.setItem('wp.hint', '1'); } catch (e) {}
});
window.addEventListener('hashchange', () => {
  const v = location.hash === '#month' ? 'month' : location.hash === '#week' ? 'week' : null;
  if (v && v !== state.view) setView(v);
});

/* ---------- pointer: swipe weeks, Ctrl-drag (or long-press) to copy ---------- */
let drag = null, cdrag = null, ghost = null, suppressClick = false;
const dropLine = $('#dropline');

function clearDrop() {
  panes[1].querySelectorAll('.day.drop').forEach(el => el.classList.remove('drop'));
  dropLine.hidden = true;
}

function cdStart(x, y) {
  const li = cdrag.li, day = li.closest('.day');
  cdrag.src = day.dataset.date; cdrag.id = li.dataset.id;
  const items = store.get(cdrag.src) || [];
  const i = items.findIndex(x2 => x2.id === cdrag.id);
  if (i < 0) { cdEnd(true); return; }
  const n = blockEnd(items, i) - i - 1;
  cdrag.active = true;
  ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.innerHTML = '<b aria-hidden="true">+</b><span></span>';
  ghost.lastChild.textContent = items[i].text + (n ? ` · 세부 ${n}` : '');
  document.body.appendChild(ghost);
  li.classList.add('src');
  try { vp.setPointerCapture(cdrag.pid); } catch (e) {}
  document.documentElement.classList.add('copying');
  cdMove(x, y);
}

function cdMove(x, y) {
  ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
  const r = vp.getBoundingClientRect();
  const edge = x < r.left + 44 ? -1 : x > r.right - 44 ? 1 : 0;
  vp.classList.toggle('edge-l', edge < 0);
  vp.classList.toggle('edge-r', edge > 0);
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
  let index = -1, lineY = null;
  for (const li of ul.children) {
    if (!li.dataset.id || li.classList.contains('sub')) continue;
    const rr = li.getBoundingClientRect();
    if (y < rr.top + rr.height / 2) { index = items.findIndex(x2 => x2.id === li.dataset.id); lineY = rr.top; break; }
  }
  const ur = ul.getBoundingClientRect();
  if (lineY === null) { const lastLi = ul.lastElementChild; lineY = lastLi ? lastLi.getBoundingClientRect().bottom : ur.top + 4; }
  day.classList.add('drop');
  dropLine.hidden = false;
  dropLine.style.width = `${Math.max(40, ur.width)}px`;
  dropLine.style.transform = `translate(${ur.left}px, ${lineY - 1}px)`;
  cdrag.target = ds; cdrag.index = index;
}

function cdEnd(cancel) {
  const c = cdrag; cdrag = null;
  if (!c) return;
  clearTimeout(c.edgeT);
  vp.classList.remove('edge-l', 'edge-r');
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
  if (e.target.closest('.add, .acts, .subform')) return;
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
  if (screens.app.hidden) return;
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
  const del = e.target.closest('.del');
  if (del) {
    const li = del.closest('.item'), day = del.closest('.day');
    if (li && day) removeItem(day.dataset.date, li.dataset.id);
    return;
  }
  const sa = e.target.closest('.subadd');
  if (sa) {
    const li = sa.closest('.item'), day = sa.closest('.day');
    if (!li || !day) return;
    const same = state.subEdit && state.subEdit.parent === li.dataset.id;
    state.subEdit = same ? null : { date: day.dataset.date, parent: li.dataset.id };
    render();
    const si = $('#sub-input');
    if (si && !same) { si.value = ''; si.focus(); }
    return;
  }
  const cell = e.target.closest('.mcell');
  if (cell) openDay(cell.dataset.date);
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
  if (addItem(day.dataset.date, inp.value)) inp.value = '';
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
  stopSub(); store.clear(); dirty.clear();
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
  stopSub(); store.clear(); dirty.clear();
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
