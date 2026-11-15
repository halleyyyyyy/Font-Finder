// FONT EXPLORER — front end
// Everything lives in this file: saved foundries, the grid, font loading and the style sheet.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const SUGGESTIONS = [
  ['ABC Dinamo', 'abcdinamo.com'],
  ['Klim', 'klim.co.nz'],
  ['Grilli Type', 'grillitype.com'],
  ['Pangram Pangram', 'pangrampangram.com'],
  ['OH no Type Co', 'ohnotype.co'],
  ['Production Type', 'productiontype.com'],
  ['Swiss Typefaces', 'swisstypefaces.com'],
  ['Typotheque', 'typotheque.com'],
];

const STORE_KEY = 'fontExplorer:foundries:v1';
const PREFS_KEY = 'fontExplorer:prefs:v1';

const state = {
  foundries: load(STORE_KEY, []),
  prefs: Object.assign({ text: '', size: 64, view: 'grid', sort: 'az', foundry: '', search: '', variable: false, italic: false, theme: 'light' }, load(PREFS_KEY, {})),
};
const shuffleRank = new Map();

// ------------------------------------------------------------ storage

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveFoundries() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.foundries));
  } catch {
    // too big for this browser's storage — keep the list, rescan next visit
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.foundries.map(({ families, ...f }) => f)));
    } catch {}
  }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch {}
}

// ------------------------------------------------------------ foundries

function normalise(input) {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return null;
    return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')), host: u.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

async function addFoundry(input) {
  const n = normalise(input);
  if (!n) return flash('That does not look like a website address.');
  if (state.foundries.some((f) => f.host === n.host)) return flash(`${n.host} is already in your list.`);
  const f = { url: n.url, host: n.host, name: n.host, status: 'loading', families: [] };
  state.foundries.push(f);
  renderAll();
  await scan(f);
}

async function scan(f) {
  f.status = 'loading';
  f.error = null;
  renderChips();
  try {
    const res = await fetch(`/api/scan?url=${encodeURIComponent(f.url)}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(res.status === 504 ? 'The scan took too long.' : `Scan failed (${res.status}).`);
    }
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    f.name = data.foundry.name;
    f.families = data.families;
    f.scannedAt = data.scannedAt;
    f.stats = data.stats;
    f.status = data.families.length ? 'ready' : 'error';
    if (!data.families.length) f.error = 'No web fonts found on this site.';
  } catch (e) {
    f.status = 'error';
    f.error = e.message;
  }
  saveFoundries();
  renderAll();
}

function removeFoundry(host) {
  state.foundries = state.foundries.filter((f) => f.host !== host);
  if (state.prefs.foundry === host) state.prefs.foundry = '';
  saveFoundries();
  renderAll();
}

// ------------------------------------------------------------ font loading

const faceCache = new Map(); // font url → Promise<css family name>
const queue = [];
let active = 0;
const MAX_PARALLEL = 6;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function loadFace(style) {
  if (faceCache.has(style.url)) return faceCache.get(style.url);
  const p = new Promise((resolve, reject) => {
    queue.push(async () => {
      const name = 'fx-' + hash(style.url);
      try {
        const descriptors = { style: 'normal', display: 'swap' };
        if (style.variable || style.weightRange) descriptors.weight = '1 1000';
        const face = new FontFace(name, `url("/api/font?u=${encodeURIComponent(style.url)}")`, descriptors);
        await face.load();
        document.fonts.add(face);
        resolve(name);
      } catch (e) {
        reject(e);
      }
    });
    pump();
  });
  faceCache.set(style.url, p);
  return p;
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}

// the style that best represents a family on its card
function previewStyle(fam) {
  const score = (s) =>
    (s.italic ? 1000 : 0) +
    Math.abs((s.weight || 400) - 400) +
    (/regular|book|roman|normal/i.test(s.name) ? -50 : 0) +
    (/compressed|condensed|extended|expanded|wide|narrow|mono/i.test(s.name) ? 40 : 0);
  return [...fam.styles].sort((a, b) => score(a) - score(b))[0];
}

function applyFace(el, style, name) {
  el.style.fontFamily = `"${name}", "Adobe Blank", sans-serif`;
  el.style.fontWeight = style.variable || style.weightRange ? '400' : 'normal';
  el.style.fontStyle = 'normal';
  el.style.fontSynthesis = 'none';
}

// ------------------------------------------------------------ grid

const cardEls = new Map(); // family id → element
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      const fam = e.target._fam;
      const style = previewStyle(fam);
      const sample = $('.card__sample', e.target);
      loadFace(style)
        .then((name) => {
          applyFace(sample, style, name);
          e.target.classList.add('is-ready');
        })
        .catch(() => {
          e.target.classList.add('is-failed');
          $('.card__count', e.target).textContent = 'Preview blocked';
        });
    }
  },
  { rootMargin: '600px 0px' }
);

function allFamilies() {
  return state.foundries.filter((f) => f.status === 'ready').flatMap((f) => (f.families || []).map((fam) => ({ ...fam, host: f.host, foundry: f.name })));
}

function visibleFamilies() {
  const p = state.prefs;
  const q = p.search.trim().toLowerCase();
  let list = allFamilies().filter(
    (f) =>
      (!p.foundry || f.host === p.foundry) &&
      (!q || f.name.toLowerCase().includes(q) || f.foundry.toLowerCase().includes(q)) &&
      (!p.variable || f.variable) &&
      (!p.italic || f.hasItalic)
  );
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (p.sort === 'az') list.sort(byName);
  if (p.sort === 'foundry') list.sort((a, b) => a.foundry.localeCompare(b.foundry) || byName(a, b));
  if (p.sort === 'styles') list.sort((a, b) => b.styles.length - a.styles.length || byName(a, b));
  if (p.sort === 'shuffle') {
    for (const f of list) if (!shuffleRank.has(f.id)) shuffleRank.set(f.id, Math.random());
    list.sort((a, b) => shuffleRank.get(a.id) - shuffleRank.get(b.id));
  }
  return list;
}

function weightText(f) {
  if (f.weightMin === f.weightMax) return f.variable ? 'Variable' : String(f.weightMin);
  return `${f.weightMin}–${f.weightMax}`;
}

function makeCard(fam) {
  const el = $('#cardTpl').content.firstElementChild.cloneNode(true);
  el._fam = fam;
  $('.card__link', el).href = fam.specimenUrl;
  $('.card__link', el).title = `Open the ${fam.name} specimen on ${fam.foundry}`;
  $('.card__foundry', el).textContent = fam.foundry;
  $('.card__count', el).textContent = `${fam.styles.length} ${fam.styles.length === 1 ? 'style' : 'styles'}`;
  $('.card__name', el).textContent = fam.name;
  const tags = $('.card__tags', el);
  const addTag = (t, cls = '') => {
    const s = document.createElement('span');
    s.className = 'tag ' + cls;
    s.textContent = t;
    tags.append(s);
  };
  addTag(weightText(fam));
  if (fam.variable) addTag('VF', 'tag--vf');
  if (fam.hasItalic) addTag('Ital');
  $('.card__styles', el).addEventListener('click', () => openSheet(fam));
  observer.observe(el);
  return el;
}

function renderGrid() {
  const grid = $('#grid');
  const list = visibleFamilies();
  const frag = document.createDocumentFragment();
  for (const fam of list) {
    let el = cardEls.get(fam.id);
    if (!el || el._fam.styles.length !== fam.styles.length) {
      el = makeCard(fam);
      cardEls.set(fam.id, el);
    }
    frag.append(el);
  }
  grid.replaceChildren(frag);
  grid.classList.toggle('is-list', state.prefs.view === 'list');
  updateSamples();

  const total = allFamilies().length;
  const loading = state.foundries.filter((f) => f.status === 'loading').length;
  $('#resultsLine').textContent = total
    ? `Showing ${list.length} of ${total} typefaces${loading ? ` · scanning ${loading} more…` : ''}`
    : loading ? 'Scanning foundry… this can take up to a minute the first time.' : '';
  $('#empty').hidden = total > 0 || loading > 0;
}

function updateSamples() {
  const text = state.prefs.text;
  for (const el of cardEls.values()) $('.card__sample', el).textContent = text || el._fam.name;
  document.documentElement.style.setProperty('--sample', state.prefs.size + 'px');
}

// ------------------------------------------------------------ chips, filters, header

function renderChips() {
  const ul = $('#foundryList');
  ul.replaceChildren(
    ...state.foundries.map((f) => {
      const li = document.createElement('li');
      li.className = `chip is-${f.status}`;
      li.title = f.error || f.url;
      const name = document.createElement('a');
      name.href = f.url;
      name.target = '_blank';
      name.rel = 'noopener';
      name.textContent = f.name;
      const count = document.createElement('span');
      count.className = 'chip__count';
      count.textContent = f.status === 'loading' ? 'scanning' : f.status === 'error' ? f.error || 'error' : `${(f.families || []).length}`;
      const re = document.createElement('button');
      re.className = 'chip__btn';
      re.type = 'button';
      re.textContent = '↻';
      re.title = 'Scan again';
      re.ariaLabel = `Scan ${f.name} again`;
      re.disabled = f.status === 'loading';
      re.onclick = () => scan(f);
      const rm = document.createElement('button');
      rm.className = 'chip__btn';
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.ariaLabel = `Remove ${f.name}`;
      rm.onclick = () => removeFoundry(f.host);
      li.append(name, count, re, rm);
      return li;
    })
  );

  const sug = $('#suggest');
  $$('button', sug).forEach((b) => b.remove());
  for (const [label, host] of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = state.foundries.some((f) => f.host === host);
    b.onclick = () => addFoundry(host);
    sug.append(b);
  }

  const sel = $('#foundryFilter');
  sel.replaceChildren(new Option('All foundries', ''), ...state.foundries.filter((f) => f.status === 'ready').map((f) => new Option(`${f.name} (${f.families.length})`, f.host)));
  sel.value = state.prefs.foundry;
}

function renderHeader() {
  const ready = state.foundries.filter((f) => f.status === 'ready');
  const n = ready.reduce((a, f) => a + f.families.length, 0);
  $('#countLine').textContent = `${n} typefaces · ${ready.length} ${ready.length === 1 ? 'foundry' : 'foundries'}`;
  const bits = ['Font Explorer', 'A little foundry of foundries', `${n} typefaces`, `${ready.length} foundries`, ...ready.map((f) => f.name), 'Type is a beautiful group of letters'];
  const html = bits.map((b) => `<span>${escapeHtml(b)} ✦</span>`).join('');
  $('#ticker').innerHTML = html + html;
}

function renderAll() {
  renderHeader();
  renderChips();
  renderGrid();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let flashTimer;
function flash(msg) {
  const input = $('#addInput');
  input.setCustomValidity(msg);
  input.reportValidity();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => input.setCustomValidity(''), 2500);
}

// ------------------------------------------------------------ style sheet (drawer)

let sheetFam = null;
function openSheet(fam) {
  sheetFam = fam;
  const sheet = $('#sheet');
  $('#sheetFoundry').textContent = fam.foundry;
  $('#sheetTitle').textContent = fam.name;
  $('#sheetMeta').textContent = [`${fam.styles.length} styles`, `Weights ${weightText(fam)}`, fam.variable ? 'Variable' : null, fam.hasItalic ? 'Italics' : null].filter(Boolean).join(' · ');
  $('#sheetSpecimen').href = fam.specimenUrl;
  $('#sheetWeightWrap').hidden = !fam.variable;

  const preview = previewStyle(fam);
  loadFace(preview).then((name) => applyFace($('#sheetTitle'), preview, name)).catch(() => {});

  const ol = $('#sheetStyles');
  ol.replaceChildren(
    ...fam.styles.map((s) => {
      const li = document.createElement('li');
      const label = document.createElement('p');
      label.className = 'label';
      label.textContent = `${s.name}${s.variable ? ' · variable' : ''} · ${s.weightRange ? s.weightRange.join('–') : s.weight}`;
      const text = document.createElement('div');
      text.className = 'waterfall__text';
      text.contentEditable = 'true';
      text.spellcheck = false;
      text.style.opacity = '0.15';
      text._style = s;
      loadFace(s)
        .then((name) => {
          applyFace(text, s, name);
          text.style.opacity = '';
          if (s.variable) text.style.fontWeight = $('#sheetWeight').value;
        })
        .catch(() => (label.textContent += ' · preview blocked'));
      li.append(label, text);
      return li;
    })
  );
  updateSheetText();
  sheet.showModal();
  ol.scrollTop = 0;
}
function updateSheetText() {
  const t = $('#sheetText').value || sheetFam?.name || '';
  const size = $('#sheetSize').value;
  $('#sheetSizeOut').textContent = size;
  $$('.waterfall__text').forEach((el) => {
    el.textContent = t;
    el.style.fontSize = size + 'px';
  });
}

// ------------------------------------------------------------ wiring

function fitWordmark() {
  for (const el of [$('#wordmark'), $('.footer__big')]) {
    el.style.fontSize = '100px';
    const cs = getComputedStyle(el.parentElement);
    const w = el.parentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    el.style.fontSize = (100 * w) / el.scrollWidth + 'px';
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.prefs.theme;
}

function wire() {
  const p = state.prefs;
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#addInput').value;
    $('#addInput').value = '';
    addFoundry(v);
  });

  const tester = $('#testerInput');
  tester.value = p.text;
  tester.addEventListener('input', () => { p.text = tester.value; updateSamples(); savePrefs(); });

  const size = $('#sizeInput');
  size.value = p.size;
  $('#sizeOut').textContent = p.size;
  size.addEventListener('input', () => { p.size = +size.value; $('#sizeOut').textContent = p.size; updateSamples(); savePrefs(); });

  const search = $('#searchInput');
  search.value = p.search;
  search.addEventListener('input', () => { p.search = search.value; renderGrid(); savePrefs(); });

  $('#foundryFilter').addEventListener('change', (e) => { p.foundry = e.target.value; renderGrid(); savePrefs(); });
  $('#sortSelect').value = p.sort;
  $('#sortSelect').addEventListener('change', (e) => { p.sort = e.target.value; shuffleRank.clear(); renderGrid(); savePrefs(); });

  $$('[data-toggle]').forEach((b) => {
    const key = b.dataset.toggle;
    b.classList.toggle('is-on', !!p[key]);
    b.addEventListener('click', () => { p[key] = !p[key]; b.classList.toggle('is-on', p[key]); renderGrid(); savePrefs(); });
  });
  $$('[data-view]').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.view === p.view);
    b.addEventListener('click', () => {
      p.view = b.dataset.view;
      $$('[data-view]').forEach((x) => x.classList.toggle('is-on', x === b));
      renderGrid();
      savePrefs();
    });
  });

  $('#themeToggle').addEventListener('click', () => { p.theme = p.theme === 'dark' ? 'light' : 'dark'; applyTheme(); savePrefs(); });

  const sheet = $('#sheet');
  $('#sheetClose').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
  $('#sheetText').addEventListener('input', updateSheetText);
  $('#sheetSize').addEventListener('input', updateSheetText);
  $('#sheetWeight').addEventListener('input', (e) => {
    $('#sheetWeightOut').textContent = e.target.value;
    $$('.waterfall__text').forEach((el) => { if (el._style?.variable) el.style.fontWeight = e.target.value; });
  });

  window.addEventListener('resize', fitWordmark);
  document.fonts.ready.then(fitWordmark);
}

applyTheme();
wire();
renderAll();
fitWordmark();
// finish any scans that were interrupted, or whose results didn't fit in storage
for (const f of state.foundries) if (f.status === 'loading' || (f.status === 'ready' && !f.families?.length)) scan(f);
