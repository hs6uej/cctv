'use strict';
// Longdo/iTIC list is loaded live; data/cameras.json is built by scripts/build_cameras.py.
const LONGDO_LIST = 'https://traffic.longdo.com/camera.json';
const LOCAL_LIST = 'data/cameras.json';
const STATUS_LIST = 'status/status.json'; // written by the checker service
const DOH_HOST = 'https://streaming1.highwaytraffic.go.th/';
const SNAPSHOT_MS = 5000;
const MJPEG_RECONNECT_MS = 15000; // DWR closes MJPEG streams after ~11-24 s
const LIST_LIMIT = 150;
const BKK_VIEW = [[13.62, 100.35], [13.93, 100.75]];
const TH_VIEW = [[5.6, 97.3], [20.5, 105.7]];

const SOURCES = {
  itic:    {label: 'iTIC / Longdo',      color: '#20b27a', icon: '◉'},
  doh:     {label: 'กรมทางหลวง',         color: '#3b7be0', icon: '◉'},
  dwr:     {label: 'กรมทรัพยากรน้ำ',      color: '#14a3b8', icon: '≈'},
  hatyai:  {label: 'หาดใหญ่ (น้ำท่วม)',   color: '#f0a020', icon: '▣'},
  gistda:  {label: 'GISTDA ชายฝั่ง',      color: '#8e5ae8', icon: '◉'},
  bma:     {label: 'กทม. ตามแยก (เปิดเว็บ กทม.)', color: '#7c8aa5', icon: '↗'},
  pattaya: {label: 'พัทยา (เปิดเว็บต้นทาง)', color: '#98a2b3', icon: '↗', off: true},
};
const KIND_LABEL = {hls: 'วิดีโอสด', mjpeg: 'วิดีโอสด', jpeg: 'ภาพนิ่ง', iframe: 'วิดีโอสด', link: 'เปิดเว็บต้นทาง'};
const LIVE_KINDS = new Set(['hls', 'mjpeg', 'iframe']);

// Keyless tile services (CARTO now requires an API key; tile.openstreetmap.org blocks non-browser use).
const ESRI = n => `https://server.arcgisonline.com/ArcGIS/rest/services/${n}/MapServer/tile/{z}/{y}/{x}`;
const THEMES = {
  glacier:   {label: 'Glacier',   base: ESRI('Canvas/World_Light_Gray_Base'), labels: ESRI('Canvas/World_Light_Gray_Reference')},
  lagoon:    {label: 'Lagoon',    base: ESRI('Canvas/World_Light_Gray_Base'), labels: ESRI('Canvas/World_Light_Gray_Reference'), cls: 't-lagoon'},
  street:    {label: 'Street',    base: ESRI('World_Street_Map')},
  night:     {label: 'Night',     base: ESRI('Canvas/World_Dark_Gray_Base'), labels: ESRI('Canvas/World_Dark_Gray_Reference')},
  satellite: {label: 'Satellite', base: ESRI('World_Imagery'), labels: ESRI('Reference/World_Boundaries_and_Places')},
  humanitarian: {label: 'OSM HOT', base: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'},
};

const $ = id => document.getElementById(id);
const TOUCH = matchMedia('(pointer: coarse)').matches;
// iPhone / iPad (iPadOS reports itself as a Mac with touch): Safari's built-in HLS player is the most reliable there
const APPLE_MOBILE = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const narrow = () => matchMedia('(max-width: 760px)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bust = u => u + (u.includes('?') ? '&' : '?') + '_=' + Date.now();
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let cams = [], byId = new Map(), map, tiles, markers, selected = null, viewerPlayer = null;
let favs = store.get('cctv.favs', []);
let wallPlayers = [];
const enabled = new Set(store.get('cctv.sources.v2', Object.keys(SOURCES).filter(k => !SOURCES[k].off)).filter(k => SOURCES[k]));
let onlyLive = store.get('cctv.onlyLive', false);
let showDead = store.get('cctv.showDead', false);
let health = {};

/* ---------- data ---------- */
function fromLongdo(c) {
  const lat = +c.latitude, lng = +c.longitude;
  const video = c.hls_url && !/tempsus/.test(c.hls_url);
  const snap = c.imgurl && !c.imgurl.includes('X.X.X.X') ? c.imgurl : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!video && !snap)) return null;
  return {id: 'itic-' + c.camid, src: 'itic', title: c.title.replace(/^\s*\([^)]*\)\s*/, ''), org: c.sponsertext || c.organization,
    lat, lng, kind: video ? 'hls' : 'jpeg', url: video ? c.hls_url : snap, snap};
}

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); }

async function loadCameras() {
  const [longdo, local, status] = await Promise.allSettled([getJSON(LONGDO_LIST), getJSON(LOCAL_LIST), getJSON(STATUS_LIST)]);
  const errs = [];
  if (status.status === 'fulfilled') health = status.value;
  if (longdo.status === 'fulfilled') cams.push(...longdo.value.item.map(fromLongdo).filter(Boolean)); else errs.push('Longdo');
  if (local.status === 'fulfilled') cams.push(...local.value.map(c =>
    // relay DOH streams through our nginx (their TLS chain is incomplete)
    c.src === 'doh' ? {...c, url: c.url.replace(DOH_HOST, 'proxy/doh/')} : c)); else errs.push('รายชื่อกล้อง');
  for (const c of cams) {
    const h = health.cams?.[c.id];
    if (h && !h.ok) c.dead = true;
    if (h?.fallback && c.snap) { c.kind = 'jpeg'; c.url = c.snap; } // video down but snapshot works
  }
  byId = new Map(cams.map(c => [c.id, c]));
  const live = cams.filter(c => LIVE_KINDS.has(c.kind) && !c.dead).length;
  const dead = cams.filter(c => c.dead).length;
  const when = health.checked ? fmtTime(health.checked) : null;
  $('status').textContent = `${live} วิดีโอสด` + (when ? ` · ตรวจล่าสุด ${when} น. (ออฟไลน์ ${dead})` : '') + (errs.length ? ` · โหลดไม่ได้: ${errs.join(', ')}` : '');
}

/* ---------- outbound-link cameras (BMA / Pattaya) ---------- */
function siteState(c) { return c.src === 'bma' ? health.sites?.bma : null; }

function linkUrl(c) {
  const st = siteState(c);
  // use whichever BMA host the checker last saw working
  return st?.up && st.base && c.src === 'bma' ? c.url.replace('http://www.bmatraffic.com/', st.base) : c.url;
}

function linkCard(c) {
  const st = siteState(c);
  const line = !st ? '' : st.up
    ? '<p class="site ok">● เว็บ กทม. ใช้งานได้</p>'
    : `<p class="site down">● เว็บ กทม. ล่มอยู่ (ตรวจเมื่อ ${esc(fmtTime(st.checked))} น.)</p>`;
  return `<div class="media-link"><div>กล้องนี้ดูได้เฉพาะที่เว็บของหน่วยงาน${line}<a href="${esc(linkUrl(c))}" target="_blank" rel="noopener">เปิดเว็บต้นทาง ↗</a></div></div>`;
}

const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'}) : '—';

/* ---------- players (shared by viewer + wall) ---------- */
const WATCHDOG_MS = 20000; // no picture within this time = treat as dead

function createPlayer(c, box) {
  const p = {};
  const note = (msg, retry) => {
    let e = box.querySelector('.media-err');
    if (!e) { e = document.createElement('div'); e.className = 'media-err'; box.append(e); }
    e.innerHTML = esc(msg) + (retry ? ' <button class="retry">ลองใหม่</button>' : '');
    e.querySelector('.retry')?.addEventListener('click', () => { p.stop(); start(); });
  };
  const loading = on => {
    let l = box.querySelector('.media-loading');
    if (on && !l) box.insertAdjacentHTML('beforeend', '<div class="media-loading"><span></span>กำลังเชื่อมต่อกล้อง…</div>');
    if (!on) l?.remove();
  };
  const ok = () => { clearTimeout(p.watchdog); loading(false); box.querySelector('.media-err')?.remove(); };
  const dead = msg => { clearTimeout(p.watchdog); loading(false); note(msg, true); };
  const watch = msg => { clearTimeout(p.watchdog); p.watchdog = setTimeout(() => dead(msg), WATCHDOG_MS); };

  const image = (url, every, isStream) => {
    const img = p.img = document.createElement('img');
    img.className = 'media'; img.alt = c.title;
    img.onload = ok;
    img.onerror = () => { if (!isStream) dead('ไม่มีภาพจากกล้องนี้ตอนนี้'); };
    const load = () => { img.src = bust(url); };
    box.append(img); load(); p.timer = setInterval(load, every);
    watch(isStream ? 'กล้องไม่ส่งภาพ (อาจปิดอยู่)' : 'ไม่มีภาพจากกล้องนี้ตอนนี้');
  };
  const frame = src => {
    const f = document.createElement('iframe');
    f.className = 'media'; f.src = src; f.title = c.title;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true;
    f.onload = ok;
    box.append(f);
  };
  const hls = () => {
    const v = document.createElement('video');
    v.className = 'media'; v.muted = true; v.autoplay = true; v.playsInline = true; v.controls = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    box.append(v);
    const fail = () => {
      if (p.failed) return; p.failed = true;
      p.hls?.destroy(); p.hls = null; v.remove();
      if (c.snap) { note('วิดีโอไม่ตอบ · แสดงภาพนิ่งแทน'); image(c.snap, SNAPSHOT_MS); }
      else dead('เปิดวิดีโอไม่ได้ตอนนี้');
    };
    v.addEventListener('playing', ok);
    p.watchdog = setTimeout(fail, WATCHDOG_MS);
    const native = v.canPlayType('application/vnd.apple.mpegurl');
    if (native && (APPLE_MOBILE || !(window.Hls && Hls.isSupported()))) {
      v.src = c.url; v.onerror = fail; v.play?.().catch(() => {});
    } else if (window.Hls && Hls.isSupported()) {
      p.hls = new Hls({liveSyncDurationCount: 2, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2});
      p.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(); });
      p.hls.loadSource(c.url); p.hls.attachMedia(v);
    } else fail();
  };

  const start = () => {
    p.failed = false;
    if (c.kind !== 'link') loading(true);
    switch (c.kind) {
      case 'iframe': frame(c.url); break;
      case 'mjpeg': image(c.url, MJPEG_RECONNECT_MS, true); break;
      case 'jpeg': image(c.url, SNAPSHOT_MS); break;
      case 'hls': hls(); break;
      case 'link': box.insertAdjacentHTML('beforeend', linkCard(c));
    }
  };
  p.stop = () => {
    p.hls?.destroy(); p.hls = null; clearInterval(p.timer); clearTimeout(p.watchdog);
    if (p.img) { p.img.onload = p.img.onerror = null; p.img.src = ''; p.img = null; }
    box.querySelectorAll('.media, .media-err, .media-loading, .media-link').forEach(n => n.remove());
  };
  p.destroy = () => { p.stop(); box.innerHTML = ''; };
  start();
  return p;
}

/* ---------- map ---------- */
function setTheme(key) {
  const t = THEMES[key] || THEMES.lagoon;
  tiles?.forEach(l => l.remove());
  tiles = [L.tileLayer(t.base, {maxZoom: 19, maxNativeZoom: 18, subdomains: 'abc', className: 'base-tiles'})];
  if (t.labels) tiles.push(L.tileLayer(t.labels, {maxZoom: 19, maxNativeZoom: 18, pane: 'labels', className: 'label-tiles'}));
  tiles.forEach(l => l.addTo(map));
  document.body.classList.toggle('t-lagoon', t.cls === 't-lagoon');
  store.set('cctv.theme', key);
  $('themes').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === key));
}

function visibleCams() { return cams.filter(c => enabled.has(c.src) && (showDead || !c.dead) && (!onlyLive || LIVE_KINDS.has(c.kind))); }

function drawMarkers() {
  markers.clearLayers();
  for (const c of visibleCams()) {
    const s = SOURCES[c.src], sel = selected?.id === c.id, fav = favs.includes(c.id);
    L.circleMarker([c.lat, c.lng], {
      radius: (sel ? 10 : c.kind === 'link' ? 4 : 6) + (TOUCH ? 2 : 0),
      weight: sel ? 4 : fav ? 3 : 1.5, color: sel ? '#1b2230' : fav ? '#f2a900' : '#fff',
      fillColor: c.dead ? '#b8bfcc' : s.color, fillOpacity: c.kind === 'link' || c.dead ? .55 : .95,
    }).bindTooltip(esc(c.title), {direction: 'top', offset: [0, -6]})
      .on('click', () => select(c, false)).addTo(markers);
  }
}

/* ---------- right panel list ---------- */
function thumb(c) {
  const s = SOURCES[c.src];
  return c.snap || c.kind === 'jpeg'
    ? `<img class="thumb" loading="lazy" alt="" src="${esc(c.snap || c.url)}" onerror="this.outerHTML='<span class=&quot;thumb&quot; style=&quot;background:${s.color}&quot;>${s.icon}</span>'">`
    : `<span class="thumb" style="background:${s.color}">${s.icon}</span>`;
}

function card(c) {
  const fav = favs.includes(c.id);
  return `<div class="item ${selected?.id === c.id ? 'active' : ''}" data-id="${esc(c.id)}" role="button" tabindex="0">${thumb(c)}
    <div class="txt"><b>${esc(c.title)}</b><small>${c.dead ? '<span class="tag">ออฟไลน์</span>' : LIVE_KINDS.has(c.kind) ? '<span class="tag live">● สด</span>' : `<span class="tag">${KIND_LABEL[c.kind]}</span>`}${esc(SOURCES[c.src].label)}</small></div>
    <button class="icon star ${fav ? 'on' : ''}" data-fav="${esc(c.id)}" aria-label="กล้องโปรด">${fav ? '★' : '☆'}</button></div>`;
}

function renderList() {
  const b = map.getBounds(), center = map.getCenter();
  const inView = visibleCams().filter(c => b.contains([c.lat, c.lng]))
    .sort((a, z) => (!!a.dead - !!z.dead) || (LIVE_KINDS.has(z.kind) - LIVE_KINDS.has(a.kind)) || center.distanceTo([a.lat, a.lng]) - center.distanceTo([z.lat, z.lng]));
  $('listTitle').textContent = `${inView.length.toLocaleString()} กล้อง`;
  $('list').innerHTML = inView.length
    ? inView.slice(0, LIST_LIMIT).map(card).join('') + (inView.length > LIST_LIMIT ? `<p class="empty">ซูมเข้าเพื่อดูอีก ${inView.length - LIST_LIMIT} กล้อง</p>` : '')
    : '<p class="empty">ไม่มีกล้องในบริเวณนี้<br>ลองเลื่อนหรือซูมออกแผนที่</p>';
}

function wireList(container) {
  container.addEventListener('click', e => {
    const f = e.target.closest('[data-fav]');
    if (f) { e.stopPropagation(); toggleFav(f.dataset.fav); return; }
    const it = e.target.closest('[data-id]');
    if (it) select(byId.get(it.dataset.id), true);
  });
  container.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.closest('[data-id]')?.click(); });
}

/* ---------- viewer ---------- */
function select(c, fly) {
  if (!c) return;
  selected = c;
  viewerPlayer?.destroy();
  $('viewer').hidden = false;
  $('viewerTitle').textContent = c.title;
  $('viewerOrg').textContent = `${c.org} · ${SOURCES[c.src].label}`;
  viewerPlayer = createPlayer(c, $('viewerMedia'));
  updateFavBtn();
  setCollapsed(false);
  if (fly) map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 15), {duration: .6});
  drawMarkers(); renderList();
}

function toggleMax(on = !$('viewer').classList.contains('max')) {
  $('viewer').classList.toggle('max', on);
  $('viewerMax').textContent = on ? '⤡' : '⤢';
  $('viewerMax').setAttribute('aria-label', on ? 'ย่อ' : 'ขยายเต็มจอ');
}

function closeViewer() {
  toggleMax(false); viewerPlayer?.destroy(); viewerPlayer = null; selected = null; $('viewer').hidden = true; drawMarkers(); renderList(); }

function updateFavBtn() {
  const on = selected && favs.includes(selected.id);
  $('viewerFav').classList.toggle('on', !!on);
  $('viewerFav').textContent = on ? '★' : '☆';
  $('favCount').textContent = favs.length;
}

function toggleFav(id) {
  favs = favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id];
  store.set('cctv.favs', favs);
  updateFavBtn(); drawMarkers(); renderList();
  if (!$('wall').hidden) renderWall();
}

/* ---------- favourites wall ---------- */
function renderWall() {
  wallPlayers.forEach(p => p.destroy()); wallPlayers = [];
  const n = store.get('cctv.layout', 4);
  const cols = Math.sqrt(n);
  document.querySelectorAll('#layout button').forEach(b => b.classList.toggle('on', +b.dataset.n === n));
  const grid = $('wallGrid');
  // phones: at most 2 columns and scroll, otherwise 9/16 cells become too small to see
  const phone = narrow() || innerHeight < 520;
  const c2 = phone ? Math.min(cols, innerWidth > innerHeight ? 3 : 2) : cols;
  grid.classList.toggle('scroll', phone && n > 1);
  grid.style.gridTemplateColumns = `repeat(${c2}, 1fr)`;
  grid.style.gridTemplateRows = phone && n > 1 ? '' : `repeat(${cols}, 1fr)`;
  grid.innerHTML = '';
  const list = favs.map(id => byId.get(id)).filter(Boolean).slice(0, n);
  $('wallEmpty').hidden = list.length > 0;
  grid.hidden = !list.length;
  for (const c of list) {
    const cell = document.createElement('div');
    cell.className = 'wall-cell';
    cell.innerHTML = `<div class="cap">${esc(c.title)}<small>${esc(SOURCES[c.src].label)}</small></div><button class="rm" aria-label="เอาออกจากกล้องโปรด">×</button>`;
    cell.querySelector('.rm').onclick = () => toggleFav(c.id);
    grid.append(cell);
    wallPlayers.push(createPlayer(c, cell));
  }
  $('wallMore').textContent = favs.length > n ? `แสดง ${n} จาก ${favs.length} กล้อง · เลือกช่องมากขึ้นเพื่อดูทั้งหมด` : '';
}

function openWall() { viewerPlayer?.destroy(); viewerPlayer = null; $('wall').hidden = false; renderWall(); }
function closeWall() { wallPlayers.forEach(p => p.destroy()); wallPlayers = []; $('wall').hidden = true; if (selected) select(selected, false); }

/* ---------- search ---------- */
function search() {
  const q = $('search').value.trim().toLowerCase();
  const box = $('results');
  if (!q) { box.hidden = true; return; }
  const hits = visibleCams().filter(c => (c.title + ' ' + c.org).toLowerCase().includes(q)).slice(0, 30);
  box.hidden = false;
  box.innerHTML = hits.length ? hits.map(c => `<button data-id="${esc(c.id)}">${esc(c.title)}<small>${esc(SOURCES[c.src].label)} · ${KIND_LABEL[c.kind]}</small></button>`).join('')
    : '<p class="empty">ไม่พบกล้อง</p>';
}

/* ---------- ui ---------- */
function setCollapsed(v) {
  document.body.classList.toggle('collapsed', v);
  $('reopen').hidden = !v;
  store.set('cctv.collapsed', v);
}

function renderSources() {
  $('sources').innerHTML = Object.entries(SOURCES).map(([k, s]) =>
    `<label><input type="checkbox" value="${k}" ${enabled.has(k) ? 'checked' : ''}><i style="background:${s.color}"></i>${s.label}${k === 'bma' && health.sites?.bma ? (health.sites.bma.up ? ' <em class="ok">เว็บใช้ได้</em>' : ' <em class="down">เว็บล่ม</em>') : ''}<span>${cams.filter(c => c.src === k).length}</span></label>`).join('');
  $('sources').insertAdjacentHTML('beforeend', `<label class="dead-toggle"><input type="checkbox" id="showDead" ${showDead ? 'checked' : ''}>แสดงกล้องที่ออฟไลน์<span>${cams.filter(c => c.dead).length}</span></label>`);
  $('sources').onchange = e => {
    if (e.target.id === 'showDead') { showDead = e.target.checked; store.set('cctv.showDead', showDead); drawMarkers(); renderList(); search(); return; }
    e.target.checked ? enabled.add(e.target.value) : enabled.delete(e.target.value);
    store.set('cctv.sources.v2', [...enabled]); drawMarkers(); renderList(); search();
  };
}

// One Bangkok tile (Pathum Wan, z14) for the theme previews.
const tileAt = url => url.replace('{s}', 'a').replace('{z}', 14).replace('{x}', 12767).replace('{y}', 7560);

async function init() {
  // larger canvas hit tolerance so markers are easy to tap with a finger
  map = L.map('map', {renderer: L.canvas({tolerance: TOUCH ? 12 : 3}), zoomControl: false, tapTolerance: 20}).fitBounds(BKK_VIEW);
  L.control.zoom({position: 'bottomleft'}).addTo(map);
  map.createPane('labels').style.zIndex = 350; // above base tiles, below camera markers
  markers = L.layerGroup().addTo(map);
  $('themes').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button data-k="${k}"><img alt="" src="${tileAt(t.base)}" class="${t.cls || ''}"><span>${t.label}</span></button>`).join('');
  $('themes').querySelectorAll('.t-lagoon').forEach(i => i.style.filter = 'sepia(.25) hue-rotate(185deg) saturate(1.7)');
  $('themes').onclick = e => { const b = e.target.closest('[data-k]'); if (b) setTheme(b.dataset.k); };
  setTheme(THEMES[store.get('cctv.theme')] ? store.get('cctv.theme') : 'lagoon');
  setCollapsed(store.get('cctv.collapsed', false));
  if (narrow()) $('sourcesBox').open = false;

  $('themeBtn').onclick = () => { $('themeCard').hidden = !$('themeCard').hidden; };
  $('themeClose').onclick = () => { $('themeCard').hidden = true; };
  $('collapse').onclick = () => setCollapsed(!document.body.classList.contains('collapsed'));
  $('reopen').onclick = () => setCollapsed(false);
  $('viewerClose').onclick = closeViewer;
  $('viewerMax').onclick = () => toggleMax();
  $('viewerFav').onclick = () => selected && toggleFav(selected.id);
  $('favBtn').onclick = openWall;
  $('wallClose').onclick = closeWall;
  $('layout').onclick = e => { const b = e.target.closest('[data-n]'); if (b) { store.set('cctv.layout', +b.dataset.n); renderWall(); } };
  $('goBkk').onclick = () => map.flyToBounds(BKK_VIEW, {duration: .6});
  $('goTh').onclick = () => map.flyToBounds(TH_VIEW, {duration: .6});
  $('onlyLive').setAttribute('aria-pressed', onlyLive);
  $('onlyLive').onclick = () => { onlyLive = !onlyLive; store.set('cctv.onlyLive', onlyLive); $('onlyLive').setAttribute('aria-pressed', onlyLive); drawMarkers(); renderList(); search(); };
  $('search').oninput = search;
  $('results').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { $('results').hidden = true; select(byId.get(b.dataset.id), true); } };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('viewer').classList.contains('max')) toggleMax(false); else if (!$('wall').hidden) closeWall(); else $('themeCard').hidden = true; } });
  // re-layout the wall when a phone/tablet is rotated
  // (only on width changes: mobile browsers fire resize when the address bar hides, which must not restart streams)
  let rt, lastW = innerWidth; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { map.invalidateSize(); if (innerWidth !== lastW && !$('wall').hidden) renderWall(); lastW = innerWidth; }, 250); });
  wireList($('list'));
  map.on('moveend', renderList);

  await loadCameras();
  renderSources(); drawMarkers(); renderList(); updateFavBtn();
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
