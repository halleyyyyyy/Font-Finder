// FONT FINDER — front end
// You add foundries one at a time: paste a website, or tick one from the list (which comes from
// an Are.na board). Each added foundry is scanned by /api/scan and every family is shown in its own font.

const ARENA_CHANNEL = 'type_foundries-k81iuupsmsg'; // are.na/halley-husted-5cemb5esgsa/type_foundries-k81iuupsmsg
const FALLBACK_FOUNDRIES = ['abcdinamo.com', 'klim.co.nz', 'grillitype.com', 'pangrampangram.com'];
const SCAN_PARALLEL = 4;
// Always loaded on every visit, so the hero always has a typeface. Can't be unticked.
const ALWAYS_LOADED = { url: 'https://abcdinamo.com', name: 'ABC Dinamo' };
// Foundries on the Are.na board that Font Finder should skip
const HIDDEN_FOUNDRIES = ['bezier.com'];

// The ↗ used on every outbound link. Drawn by CSS from /arrow.svg in the text colour.
const ARROW = '<span class="arrow" aria-hidden="true"></span>';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ------------------------------------------------------------ saved settings

const KEYS = { prefs: 'fontFinder:prefs:v2', mine: 'fontFinder:foundries:v2', kinds: 'fontFinder:kinds:v1', unreadable: 'fontFinder:unreadable:v1', saves: 'fontFinder:saves:v1' };
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const DEFAULT_PREFS = { text: '', sort: 'az', view: 'list', size: 'm', foundries: [], types: [], showBlocked: false, savedOnly: false };
const prefs = { ...DEFAULT_PREFS, ...load(KEYS.prefs, {}) };
const mine = { added: [], names: {}, ...load(KEYS.mine, {}) }; // websites of the foundries you added, and their names by host
delete mine.removed; // left over from when every board foundry loaded automatically
const kinds = load(KEYS.kinds, {}); // family id -> 'serif' | 'sans' | 'mono', measured in the browser
// host -> time it failed. Foundries that couldn't be read are left off the list for a while.
const UNREADABLE_FOR = 30 * 24 * 60 * 60 * 1000;
const unreadable = load(KEYS.unreadable, {});
for (const [h, t] of Object.entries(unreadable)) if (Date.now() - t > UNREADABLE_FOR) delete unreadable[h];
const savePrefs = () => save(KEYS.prefs, prefs);
const saveMine = () => save(KEYS.mine, mine);
let saveKindsTimer;
const saveKinds = () => { clearTimeout(saveKindsTimer); saveKindsTimer = setTimeout(() => save(KEYS.kinds, kinds), 1000); };

// ------------------------------------------------------------ foundries

const foundries = new Map(); // the foundries you added. host -> { url, host, name, status, families, error }
let board = []; // foundries you can tick to add: [{ url, host, name }]

function normalise(input) {
  let s = String(input).trim();
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

function addToMap(input, title) {
  const n = normalise(input);
  if (!n || foundries.has(n.host)) return null;
  const f = { ...n, name: cleanTitle(title) || n.host, status: 'queued', families: [] };
  foundries.set(n.host, f);
  return f;
}

function cleanTitle(t) {
  if (!t) return '';
  return t
    .split(/\s+[|–—·•]\s+|\s+-\s+|:\s/)[0]
    .replace(/\s*\(.*?\)\s*/g, ' ') // "Kometa ( Typefaces )" -> "Kometa"
    .trim()
    .replace(/^(home|homepage|index|news|freebies|shop|store|welcome|fonts?|typefaces)$/i, ''); // page names, not foundry names
}

// "Klim Type Foundry" -> "Klim", "Fontshare: Quality Fonts. Free." -> "Fontshare", "Lineto.com" -> "Lineto"
function shortName(scanned, f) {
  let n = cleanTitle(scanned || '');
  if (!n || n.length > 30) n = f.name !== f.host ? f.name : f.host;
  n = n.replace(/\s*[:.]\s.*$/, '').replace(/\.(com|net|org|co|ch|xyz|tf|design|studio)$/i, '');
  n = n.replace(/\s+(type\s+foundry|typefaces|type\s+fonts|foundry|type\s+co\.?|fonts)$/i, '').trim();
  return n || f.host;
}

// Only the foundries you added are scanned. The board just fills the list you can tick from.
function loadMine() {
  const always = addToMap(ALWAYS_LOADED.url, ALWAYS_LOADED.name); // first, so it's scanned first
  always.locked = true;
  for (const a of mine.added) addToMap(a, mine.names[normalise(a)?.host]);
  renderFoundryList();
  pumpScans();
  showHeroPlaceholder();
}

async function loadBoard() {
  let list;
  try {
    const r = await fetch(`/api/arena?channel=${ARENA_CHANNEL}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    list = data.foundries.filter((f) => !HIDDEN_FOUNDRIES.includes(f.host));
  } catch {
    list = FALLBACK_FOUNDRIES.map((h) => ({ url: 'https://' + h, title: h }));
  }
  board = list
    .map((f) => { const n = normalise(f.url); return n && { ...n, name: shortName(f.title, { ...n, name: n.host }) }; })
    .filter(Boolean);
  renderFoundryList();
}

const scanQueue = [];
let scanning = 0;
function pumpScans() {
  for (const f of foundries.values()) if (f.status === 'queued' && !scanQueue.includes(f)) scanQueue.push(f);
  while (scanning < SCAN_PARALLEL && scanQueue.length) {
    const f = scanQueue.shift();
    scanning++;
    scan(f).finally(() => { scanning--; pumpScans(); });
  }
  renderStatus();
}

async function scan(f) {
  f.status = 'loading';
  f.error = null;
  renderFoundryList();
  try {
    const res = await fetch(`/api/scan?url=${encodeURIComponent(f.url)}`);
    let data;
    try { data = await res.json(); } catch { throw new Error(res.status === 504 ? 'took too long' : `error ${res.status}`); }
    if (!res.ok) throw new Error(/block|429|403/i.test(data.error || '') ? 'blocked' : 'could not open');
    f.name = shortName(data.foundry.name, f);
    f.families = data.families.map((fam) => ({ ...fam, host: f.host, foundry: f.name }));
    f.status = f.families.length ? 'ready' : 'empty';
    if (!f.families.length) f.error = "couldn't read";
  } catch (e) {
    f.status = 'error';
    f.error = e.message;
  }
  if (foundries.get(f.host) !== f) return; // removed while scanning
  if (f.status !== 'ready' && !f.locked) {
    // couldn't read it: take it off your list and out of the list you tick from
    unreadable[f.host] = Date.now();
    save(KEYS.unreadable, unreadable);
    removeFoundry(f.host);
    flash(`Couldn't read ${f.name}, so it was removed.`);
    return;
  }
  renderFoundryList();
  scheduleRender();
  if (!heroFam) pickHero();
}

function addFoundry(input, title) {
  const n = normalise(input);
  if (!n) return flash('That does not look like a website.');
  if (foundries.has(n.host)) return flash(`${n.host} is already here.`);
  delete unreadable[n.host]; // you asked for it, so try again
  save(KEYS.unreadable, unreadable);
  if (!mine.added.includes(n.url)) mine.added.push(n.url);
  if (title) mine.names[n.host] = title;
  saveMine();
  const f = addToMap(n.url, title);
  renderFoundryList();
  showHeroPlaceholder();
  if (f) { scanQueue.unshift(f); pumpScans(); }
}

function removeFoundry(host) {
  const f = foundries.get(host);
  if (f?.locked) return renderFoundryList();
  foundries.delete(host);
  const i = scanQueue.indexOf(f);
  if (i >= 0) scanQueue.splice(i, 1);
  mine.added = mine.added.filter((u) => normalise(u)?.host !== host);
  delete mine.names[host];
  prefs.foundries = prefs.foundries.filter((h) => h !== host);
  saveMine();
  savePrefs();
  renderFoundryList();
  scheduleRender();
  if (heroFam?.host === host) heroFam = null;
  if (!heroFam) allFamilies().length ? pickHero() : showHeroPlaceholder();
}

// ------------------------------------------------------------ saves
// Whole families and single styles you saved for later. A copy of each family is kept,
// so your saves still show if you later untick that foundry.
const saves = { fams: [], styles: {}, data: {}, ...load(KEYS.saves, {}) };
// fams: [family id] · styles: { style url: family id } · data: { family id: family }

const isFamSaved = (fam) => saves.fams.includes(fam.id);
const isStyleSaved = (style) => style.url in saves.styles;
const savedStyleCount = (fam) => Object.values(saves.styles).filter((id) => id === fam.id).length;
const hasSaves = (fam) => isFamSaved(fam) || savedStyleCount(fam) > 0;
const saveCount = () => saves.fams.length + Object.keys(saves.styles).length;
// nothing saved means nothing to show, so don't open on an empty saves view
if (prefs.savedOnly && !saveCount()) { prefs.savedOnly = false; savePrefs(); }

function toggleFamSave(fam) {
  if (isFamSaved(fam)) saves.fams = saves.fams.filter((id) => id !== fam.id);
  else { saves.fams.push(fam.id); saves.data[fam.id] = fam; }
  savesChanged();
}

function toggleStyleSave(fam, style) {
  if (isStyleSaved(style)) delete saves.styles[style.url];
  else { saves.styles[style.url] = fam.id; saves.data[fam.id] = fam; }
  savesChanged();
}

function savesChanged() {
  // drop stored families nothing points to any more
  const used = new Set([...saves.fams, ...Object.values(saves.styles)]);
  for (const id of Object.keys(saves.data)) if (!used.has(id)) delete saves.data[id];
  save(KEYS.saves, saves);
  for (const el of cardEls.values()) paintSaveState(el);
  paintSheetSaves();
  // unsaved the last one while looking at your saves: go back to all fonts
  if (prefs.savedOnly && !saveCount()) {
    prefs.savedOnly = false;
    savePrefs();
    if (savedFilters) savedFilters.savedOnly = false;
    if (draft) { draft.savedOnly = false; renderFilters(); }
    render({ animate: true });
  } else if (prefs.savedOnly) scheduleRender();
  renderSavesBtn(true);
}

// Your saved families: the loaded copy when its foundry is loaded, otherwise the stored one.
function savedFamilies() {
  const loaded = allFamilies().filter(hasSaves);
  const ids = new Set(loaded.map((f) => f.id));
  return [...loaded, ...Object.values(saves.data).filter((f) => !ids.has(f.id) && hasSaves(f))];
}

function setSaveBtn(btn, on) {
  btn.setAttribute('aria-pressed', on);
  btn.textContent = on ? 'Saved' : 'Save for later';
}

function paintSaveState(el) {
  const fam = el._fam;
  setSaveBtn($('.card__save', el), isFamSaved(fam));
  if (el.classList.contains('is-failed')) return;
  const n = savedStyleCount(fam);
  $('.card__count', el).textContent = `${fam.styles.length} ${fam.styles.length === 1 ? 'style' : 'styles'}${n ? ` · ${n} saved` : ''}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
let lastSaveCount = null;
function renderSavesBtn(bump = false) {
  const btn = $('#savesBtn');
  const n = saveCount();
  btn.hidden = !n;
  btn.setAttribute('aria-pressed', prefs.savedOnly);
  btn.textContent = prefs.savedOnly ? `Show all fonts` : `See your saves [${pad2(n)}]`;
  btn.setAttribute('aria-label', prefs.savedOnly ? 'Show all fonts' : `See your ${n} saves`);
  if (bump && n !== lastSaveCount) { btn.classList.remove('is-bumped'); void btn.offsetWidth; btn.classList.add('is-bumped'); }
  lastSaveCount = n;
}

function toggleSavedOnly() {
  prefs.savedOnly = !prefs.savedOnly;
  savePrefs();
  // keep the drawer in step if it's open
  if (savedFilters) savedFilters.savedOnly = prefs.savedOnly;
  if (draft) { draft.savedOnly = prefs.savedOnly; renderFilters(); }
  render({ animate: true });
  scrollToList();
}

// ------------------------------------------------------------ font loading

const faceCache = new Map();
const fontQueue = [];
let fontActive = 0;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function loadFace(style, { priority = false } = {}) {
  if (faceCache.has(style.url)) return faceCache.get(style.url);
  const p = new Promise((resolve, reject) => {
    const job = async () => {
      const name = 'ff-' + hash(style.url);
      try {
        const desc = { style: 'normal', display: 'swap' };
        if (style.variable || style.weightRange) desc.weight = '1 1000';
        const face = new FontFace(name, `url("/api/font?u=${encodeURIComponent(style.url)}")`, desc);
        await face.load();
        document.fonts.add(face);
        resolve(name);
      } catch (e) {
        reject(e);
      }
    };
    priority ? fontQueue.unshift(job) : fontQueue.push(job);
    pumpFonts();
  });
  faceCache.set(style.url, p);
  return p;
}
function pumpFonts() {
  while (fontActive < 6 && fontQueue.length) {
    const job = fontQueue.shift();
    fontActive++;
    job().finally(() => { fontActive--; pumpFonts(); });
  }
}

function previewStyle(fam) {
  const score = (s) =>
    (s.italic ? 1000 : 0) + Math.abs((s.weight || 400) - 400) + (/regular|book|roman|normal/i.test(s.name) ? -50 : 0) +
    (/compressed|condensed|extended|expanded|wide|narrow|mono|outline|stencil/i.test(s.name) ? 40 : 0);
  return [...fam.styles].sort((a, b) => score(a) - score(b))[0];
}

function applyFace(el, style, name) {
  el.style.fontFamily = `"${name}", "Adobe Blank", sans-serif`;
  el.style.fontWeight = style.variable || style.weightRange ? '400' : 'normal';
  el.style.fontSynthesis = 'none';
}

// ------------------------------------------------------------ what kind of typeface is it?

function kindOf(fam) {
  const n = fam.name.toLowerCase();
  const styles = fam.styles.map((s) => s.name.toLowerCase()).join(' ');
  let shape = null;
  if (/\bmono|typewriter|\bcode\b/.test(n)) shape = 'mono';
  else if (/script|hand|brush|callig|cursive/.test(n)) shape = 'script';
  else if (/sans/.test(n)) shape = 'sans';
  else if (/serif|slab|antiqua|garamond|caslon|bodoni|didone|plantijn/.test(n)) shape = 'serif';
  else if (/grotesk|grotesque|gothic|\bgrot\b|helvetica|akzidenz|diatype|unica/.test(n)) shape = 'sans';
  else shape = kinds[fam.id] || null;

  const uses = new Set();
  if (/display|poster|banner|titling|\bfine\b/.test(n)) uses.add('display');
  if (/headline|\bdeck\b|title/.test(n)) uses.add('headlines');
  if (/\btext\b|\bbook\b|body|micro|caption|reading/.test(n) || /\btext\b/.test(styles)) uses.add('body');
  return { shape, uses };
}

const KIND_LABEL = { sans: 'Sans serif', serif: 'Serif', mono: 'Monospace', script: 'Script' };

// Measures a loaded font on a canvas: equal widths = monospace, wide stem ends on "H" = serif.
const measureCanvas = document.createElement('canvas');
measureCanvas.width = measureCanvas.height = 240;
function measureKind(fontName) {
  const ctx = measureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `160px "${fontName}"`;
  const wi = ctx.measureText('i').width;
  const wm = ctx.measureText('M').width;
  if (wi > 0 && Math.abs(wi - wm) / wm < 0.03) return 'mono';
  ctx.clearRect(0, 0, 240, 240);
  ctx.fillStyle = '#000';
  ctx.fillText('H', 20, 200);
  const img = ctx.getImageData(0, 0, 240, 240).data;
  const rowInk = (y) => { let c = 0; for (let x = 0; x < 240; x++) if (img[(y * 240 + x) * 4 + 3] > 128) c++; return c; };
  let top = -1, bottom = -1;
  for (let y = 0; y < 240; y++) if (rowInk(y)) { if (top < 0) top = y; bottom = y; }
  if (top < 0 || bottom - top < 40) return null;
  const h = bottom - top;
  const stem = rowInk(Math.round(top + h * 0.25));
  let foot = 0;
  for (let y = bottom - Math.round(h * 0.04); y <= bottom; y++) foot = Math.max(foot, rowInk(y));
  if (!stem) return null;
  return foot / stem > 1.35 ? 'serif' : 'sans';
}

// Can this font actually draw its own name? Logo and symbol fonts (like 205TF's Nd205) either lack
// the letters, so the browser falls back to another font, or draw every letter as the same shape.
function canShowText(fontName, text) {
  const ctx = measureCanvas.getContext('2d', { willReadFrequently: true });
  // missing letters: the width changes depending on which fallback font fills in
  ctx.font = `64px "${fontName}", monospace`;
  const a = ctx.measureText(text).width;
  ctx.font = `64px "${fontName}", serif`;
  if (Math.abs(a - ctx.measureText(text).width) > 0.5) return false;
  // every letter the same shape: draw a few different letters and compare the pixels
  const shapes = new Set();
  ctx.font = `160px "${fontName}", monospace`;
  for (const ch of 'HOaens') {
    ctx.clearRect(0, 0, 240, 240);
    ctx.fillText(ch, 20, 190);
    const img = ctx.getImageData(0, 0, 240, 240).data;
    let h = 0;
    for (let i = 3; i < img.length; i += 4) h = (h * 31 + img[i]) >>> 0;
    shapes.add(h);
  }
  return shapes.size >= 4;
}

function learnKind(fam, fontName) {
  if (kinds[fam.id]) return false;
  const k = measureKind(fontName);
  if (!k) return false;
  kinds[fam.id] = k;
  saveKinds();
  return true;
}

// ------------------------------------------------------------ list

const cardEls = new Map();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    loadCard(e.target);
  }
}, { rootMargin: '800px 0px' });

function loadCard(el) {
  const fam = el._fam;
  const style = previewStyle(fam);
  loadFace(style)
    .then((name) => {
      applyFace($('.card__sample', el), style, name);
      el.classList.add('is-ready');
      if (learnKind(fam, name)) fillTags(el, fam);
    })
    .catch(() => {
      el.classList.add('is-failed');
      $('.card__count', el).textContent = 'Preview blocked';
      markBlocked(fam);
    });
}

// Families whose font file the foundry won't let us load. Hidden unless "Show blocked previews" is on.
const blocked = new Set();
function markBlocked(fam) {
  if (blocked.has(fam.id)) return;
  blocked.add(fam.id);
  if (!prefs.showBlocked) scheduleRender();
}
const isHiddenBlocked = (fam) => !prefs.showBlocked && blocked.has(fam.id);

function allFamilies() {
  return [...foundries.values()].filter((f) => f.status === 'ready').flatMap((f) => f.families);
}

function matches(fam) {
  if (isHiddenBlocked(fam)) return false;
  if (prefs.foundries.length && !prefs.foundries.includes(fam.host)) return false;
  if (!prefs.types.length) return true;
  const { shape, uses } = kindOf(fam);
  const t = prefs.types;
  if (t.includes('variable') && !fam.variable) return false;
  const shapes = t.filter((x) => ['sans', 'serif', 'mono', 'script'].includes(x));
  if (shapes.length && !shapes.includes(shape)) return false;
  const useSel = t.filter((x) => ['display', 'body', 'headlines'].includes(x));
  if (useSel.length && !useSel.some((u) => uses.has(u))) return false;
  return true;
}

const shuffleRank = new Map();
function visibleFamilies() {
  const list = (prefs.savedOnly ? savedFamilies() : allFamilies()).filter(matches);
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (prefs.sort === 'az') list.sort(byName);
  if (prefs.sort === 'za') list.sort((a, b) => byName(b, a));
  if (prefs.sort === 'foundry') list.sort((a, b) => a.foundry.localeCompare(b.foundry) || byName(a, b));
  if (prefs.sort === 'shuffle') {
    for (const f of list) if (!shuffleRank.has(f.id)) shuffleRank.set(f.id, Math.random());
    list.sort((a, b) => shuffleRank.get(a.id) - shuffleRank.get(b.id));
  }
  return list;
}

function fillTags(el, fam) {
  const { shape, uses } = kindOf(fam);
  const tags = [];
  if (fam.variable) tags.push('Variable');
  if (shape) tags.push(KIND_LABEL[shape]);
  if (uses.has('display')) tags.push('Display');
  else if (uses.has('headlines')) tags.push('Headlines');
  else if (uses.has('body')) tags.push('Body');
  $('.card__tags', el).replaceChildren(...tags.slice(0, 3).map((t) => Object.assign(document.createElement('span'), { textContent: t })));
}

function makeCard(fam) {
  const el = $('#cardTpl').content.firstElementChild.cloneNode(true);
  el._fam = fam;
  const cover = $('.card__cover', el);
  cover.href = fam.specimenUrl;
  cover.setAttribute('aria-label', `${fam.name} by ${fam.foundry}: open specimen`);
  const foundry = $('.card__foundry', el);
  foundry.href = fam.foundryUrl;
  foundry.innerHTML = `${escapeHtml(fam.foundry)} ${ARROW}`;
  paintSaveState(el);
  fillTags(el, fam);
  $('.card__styles', el).addEventListener('click', () => openSheet(fam));
  $('.card__save', el).addEventListener('click', () => toggleFamSave(fam));
  el.addEventListener('animationend', () => el.classList.remove('is-entering'));
  observer.observe(el);
  return el;
}

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

// animate: ripple the first screenful of cards in (after a filter change).
// New cards (a foundry just finished loading) always ripple in.
function render({ animate = false } = {}) {
  const list = visibleFamilies();
  const frag = document.createDocumentFragment();
  const entering = [];
  list.forEach((fam, i) => {
    let el = cardEls.get(fam.id);
    if (!el || el._fam !== fam) { el = makeCard(fam); cardEls.set(fam.id, el); entering.push(el); }
    else if (animate && i < 24) entering.push(el);
    frag.append(el);
  });
  const box = $('#list');
  box.replaceChildren(frag);
  entering.slice(0, 24).forEach((el, i) => {
    el.classList.remove('is-entering');
    el.style.setProperty('--i', i);
    void el.offsetWidth; // restart the animation
    el.classList.add('is-entering');
  });
  box.classList.toggle('is-grid', prefs.view === 'grid');
  updateSamples();
  renderStatus(list.length);
  renderSavesBtn();
  maybeClassifyMore();
}

function renderStatus(shown) {
  const total = allFamilies().filter((f) => !isHiddenBlocked(f)).length;
  const ready = [...foundries.values()].filter((f) => f.status === 'ready').length;
  const pending = [...foundries.values()].filter((f) => f.status === 'queued' || f.status === 'loading').length;
  shown ??= visibleFamilies().length;
  const bits = [];
  if (prefs.savedOnly) {
    // just your saves: say how many, not how many of everything
    bits.push(shown ? `Your saves · ${shown} ${shown === 1 ? 'typeface' : 'typefaces'}` : saveCount() ? 'None of your saves match these filters.' : 'Nothing saved yet. Press Save for later on any typeface.');
  } else if (total) bits.push(shown === total ? `${total} typefaces from ${ready} ${ready === 1 ? 'foundry' : 'foundries'}` : `Showing ${shown} of ${total} typefaces`);
  if (pending) bits.push(`reading ${pending} more ${pending === 1 ? 'foundry' : 'foundries'}…`);
  if (classifying) bits.push(`sorting ${classifying} more by type…`);
  if (!prefs.savedOnly && !total && !pending) bits.push('No typefaces yet. Add a foundry to get started.');
  $('#status').textContent = bits.join(' · ');
  $('#footCount').textContent = total ? `${total} typefaces · ${ready} ${ready === 1 ? 'foundry' : 'foundries'}` : '';
}

function updateSamples() {
  for (const el of cardEls.values()) $('.card__sample', el).textContent = prefs.text || el._fam.name;
  const sizes = { s: 'clamp(24px, 2.8vw, 64px)', m: 'clamp(34px, 4.6vw, 110px)', l: 'clamp(44px, 7.5vw, 180px)' };
  document.documentElement.style.setProperty('--sample', sizes[prefs.size] || sizes.m);
}

// When filtering by serif / sans, quietly load the fonts we haven't measured yet.
let classifying = 0;
const classified = new Set();
function maybeClassifyMore() {
  const shapeFilter = prefs.types.some((t) => ['sans', 'serif', 'mono'].includes(t));
  if (!shapeFilter) return;
  const unknown = allFamilies().filter(
    (f) => (!prefs.foundries.length || prefs.foundries.includes(f.host)) && !kindOf(f).shape && !classified.has(f.id)
  );
  for (const fam of unknown) {
    classified.add(fam.id);
    classifying++;
    const style = previewStyle(fam);
    loadFace(style)
      .then((name) => { if (learnKind(fam, name)) scheduleRender(); })
      .catch(() => markBlocked(fam))
      .finally(() => { classifying--; if (!classifying) renderStatus(); });
  }
  renderStatus();
}

// ------------------------------------------------------------ hero

let heroFam = null;
const heroSkip = new Set(); // families that can't draw their own name
function randomDuotone() {
  const r = (a, b) => a + Math.random() * (b - a);
  const h = r(0, 360);
  const L = r(0.38, 0.78);
  const bg = `oklch(${L.toFixed(3)} ${r(0.08, 0.2).toFixed(3)} ${h.toFixed(1)})`;
  const fgL = L + (L > 0.58 ? -1 : 1) * r(0.13, 0.22);
  const fg = `oklch(${fgL.toFixed(3)} ${r(0.05, 0.17).toFixed(3)} ${((h + (Math.random() < 0.5 ? -1 : 1) * r(30, 160) + 360) % 360).toFixed(1)})`;
  return { bg, fg };
}

async function pickHero(tries = 0) {
  const usable = allFamilies().filter((f) => !blocked.has(f.id) && !heroSkip.has(f.id));
  const pool = usable.filter((f) => f.specimenMatched && f.styles.length >= 2 && f.name.length <= 26);
  let options = pool.length ? pool : usable;
  // don't pick the one already showing
  if (options.length > 1 && heroFam) options = options.filter((f) => f !== heroFam);
  if (!options.length || tries > 10) return;
  const fam = options[Math.floor(Math.random() * options.length)];
  heroFam = fam;
  const style = previewStyle(fam);
  try {
    const name = await loadFace(style, { priority: true });
    if (heroFam !== fam) return; // another pick or a removal happened meanwhile
    if (!canShowText(name, fam.name)) {
      // a logo or symbol font: its name would come out as shapes, so pick another
      heroSkip.add(fam.id);
      heroFam = null;
      return pickHero(tries + 1);
    }
    showHero(fam, style, name);
  } catch {
    markBlocked(fam);
    if (heroFam !== fam) return;
    heroFam = null;
    return pickHero(tries + 1);
  }
}

// Before any foundry is added there's no typeface to show, so point people to the add panel.
function showHeroPlaceholder() {
  if (heroFam || allFamilies().length) return;
  clearTimeout(heroSwapTimer);
  const hero = $('#hero');
  hero.classList.remove('is-swapping');
  hero.classList.remove('is-ready');
  hero.removeAttribute('href');
  hero.setAttribute('aria-label', 'Add a foundry to get started');
  $('#heroTrack').replaceChildren();
  const name = $('#heroName');
  name.removeAttribute('style');
  name.textContent = foundries.size ? 'Loading…' : 'No typefaces yet';
  $('#heroFoundry').textContent = foundries.size ? 'Finding a typeface' : 'Add a foundry to start';
}

async function refreshHero() {
  const btn = $('#heroRefresh');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await pickHero();
  } finally {
    btn.disabled = false;
  }
}

// If a typeface is already showing, fade it out first, then swap.
let heroSwapTimer;
function showHero(fam, style, fontName) {
  const hero = $('#hero');
  clearTimeout(heroSwapTimer);
  if (hero.classList.contains('is-ready') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    hero.classList.add('is-swapping');
    heroSwapTimer = setTimeout(() => { swapHero(fam, style, fontName); hero.classList.remove('is-swapping'); }, 320);
  } else {
    swapHero(fam, style, fontName);
  }
}

function swapHero(fam, style, fontName) {
  const hero = $('#hero');
  const { bg, fg } = randomDuotone();
  hero.style.setProperty('--hero-bg', bg);
  hero.style.setProperty('--hero-fg', fg);
  hero.href = fam.specimenUrl;
  hero.setAttribute('aria-label', `${fam.name} by ${fam.foundry}: open specimen`);
  const track = $('#heroTrack');
  applyFace(track, style, fontName);
  const word = escapeHtml(fam.name);
  track.innerHTML = Array(8).fill(`<span>${word}</span>`).join('');
  applyFace($('#heroName'), style, fontName);
  $('#heroName').textContent = fam.name;
  $('#heroFoundry').textContent = fam.foundry;
  sizeHero();
  hero.classList.add('is-ready');
}

function sizeHero() {
  const hero = $('#hero');
  const track = $('#heroTrack');
  // fill the height, but don't let tall phone screens blow it up past readability
  hero.style.setProperty('--hero-size', Math.min(hero.clientHeight * 1.32, hero.clientWidth * 0.8) + 'px');
  requestAnimationFrame(() => {
    const half = track.scrollWidth / 2;
    hero.style.setProperty('--hero-speed', Math.max(20, half / 140) + 's');
  });
}

// ------------------------------------------------------------ nav, panels, filters

const nav = $('#nav');
let openPanel = null;

function updateStuck() {
  const stuck = nav.getBoundingClientRect().top <= parseFloat(getComputedStyle(nav).top) + 1 && window.scrollY > 10;
  nav.classList.toggle('is-stuck', stuck);
}

function scrollToList() {
  const y = $('#fonts').getBoundingClientRect().top + window.scrollY - nav.offsetHeight - 12;
  if (window.scrollY < y - 2) window.scrollTo({ top: y, behavior: 'smooth' });
}

function togglePanel(name) {
  const next = openPanel === name ? null : name;
  // leaving the filters without pressing Apply: put the list back how it was
  if (openPanel === 'filters' && next !== 'filters' && savedFilters) {
    if (JSON.stringify(pickFilters(prefs)) !== JSON.stringify(savedFilters)) {
      Object.assign(prefs, structuredClone(savedFilters));
      render({ animate: true });
    }
    savedFilters = null;
  }
  openPanel = next;
  for (const btn of $$('[data-panel]')) {
    const on = btn.dataset.panel === next;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-expanded', on);
    $('.pm', btn).textContent = on ? '−' : '+';
  }
  $('#panel-filters').hidden = next !== 'filters';
  $('#panel-add').hidden = next !== 'add';
  nav.classList.toggle('has-panel', !!next);
  if (next) {
    scrollToList();
    if (next === 'filters') { savedFilters = structuredClone(pickFilters(prefs)); draft = structuredClone(savedFilters); renderFilters(); }
    if (next === 'add') setTimeout(() => $('#addInput').focus(), 50);
  }
}

let draft = null; // the filter choices in the open drawer
let savedFilters = null; // what they were when the drawer opened, to go back to if you don't Apply
const pickFilters = (p) => ({ foundries: p.foundries, types: p.types, sort: p.sort, view: p.view, size: p.size, showBlocked: p.showBlocked, savedOnly: p.savedOnly });

// Show the drawer's choices in the list right away, without saving them yet.
function previewDraft() {
  if (draft.sort === 'shuffle' && prefs.sort !== 'shuffle') shuffleRank.clear();
  Object.assign(prefs, structuredClone(draft));
  render({ animate: true });
}

function optionButton(label, pressed, onClick, count) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'opt';
  b.setAttribute('aria-pressed', pressed);
  b.textContent = label;
  if (count != null) b.append(Object.assign(document.createElement('span'), { className: 'count', textContent: ` ${count}` }));
  b.onclick = () => { onClick(); renderFilters(); previewDraft(); };
  return b;
}
function toggleIn(arr, v) { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); }

function renderFilters() {
  if (!draft) return;
  const ready = [...foundries.values()].filter((f) => f.status === 'ready').sort((a, b) => a.name.localeCompare(b.name));
  $('#fFoundries').replaceChildren(...ready.map((f) => optionButton(f.name, draft.foundries.includes(f.host), () => toggleIn(draft.foundries, f.host), f.families.length)));
  const types = [['variable', 'Variable'], ['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace'], ['display', 'Display'], ['script', 'Script'], ['body', 'Body'], ['headlines', 'Headlines']];
  $('#fTypes').replaceChildren(...types.map(([k, l]) => optionButton(l, draft.types.includes(k), () => toggleIn(draft.types, k))));
  const sorts = [['az', 'A to Z'], ['za', 'Z to A'], ['foundry', 'By foundry'], ['shuffle', 'Shuffled']];
  $('#fSort').replaceChildren(...sorts.map(([k, l]) => optionButton(l, draft.sort === k, () => (draft.sort = k))));
  $('#fSaved').replaceChildren(optionButton('Only show your saves', draft.savedOnly, () => (draft.savedOnly = !draft.savedOnly), saveCount()));
  $('#fView').replaceChildren(...[['list', 'List'], ['grid', 'Grid']].map(([k, l]) => optionButton(l, draft.view === k, () => (draft.view = k))));
  $('#fSize').replaceChildren(...[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(([k, l]) => optionButton(l, draft.size === k, () => (draft.size = k))));
  $('#fBlocked').replaceChildren(
    ...[[false, 'Hide blocked previews'], [true, 'Show blocked previews']].map(([k, l]) => optionButton(l, draft.showBlocked === k, () => (draft.showBlocked = k)))
  );
}

function applyDraft() {
  const changed = JSON.stringify(pickFilters(prefs)) !== JSON.stringify(draft);
  if (draft.sort === 'shuffle' && prefs.sort !== 'shuffle') shuffleRank.clear();
  Object.assign(prefs, structuredClone(draft));
  savePrefs();
  savedFilters = null; // keep these, don't revert
  togglePanel(null);
  render({ animate: changed });
}

// One checklist: the foundries you added (ticked) plus the ones you can add (unticked).
function renderFoundryList() {
  const rows = new Map();
  for (const b of board) if (!unreadable[b.host]) rows.set(b.host, b);
  for (const f of foundries.values()) rows.set(f.host, f);
  const items = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  $('#foundryList').replaceChildren(
    ...items.map((item) => {
      const f = foundries.get(item.host);
      const li = document.createElement('li');
      li.className = f ? `is-added is-${f.status}` : '';
      const label = document.createElement('label');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!f, disabled: !!f?.locked });
      if (f?.locked) label.title = 'Always loaded';
      box.onchange = () => (box.checked ? addFoundry(item.url, item.name) : removeFoundry(item.host));
      label.append(box, Object.assign(document.createElement('span'), { className: 'name', textContent: item.name }));
      const n = Object.assign(document.createElement('span'), {
        className: 'n',
        textContent: !f ? '' : f.status === 'ready' ? f.families.length : f.status === 'loading' ? 'reading…' : f.status === 'queued' ? 'waiting' : f.error,
      });
      const a = Object.assign(document.createElement('a'), { href: item.url, target: '_blank', rel: 'noopener', title: `Open ${item.name}` });
      a.innerHTML = ARROW;
      a.setAttribute('aria-label', `Open ${item.name}'s website`);
      li.append(label, n, a);
      return li;
    })
  );
  if (draft && openPanel === 'filters') renderFilters();
}

let flashTimer;
function flash(msg) {
  const input = $('#addInput');
  if (document.activeElement !== input || !input.value) input.value = '';
  input.placeholder = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (input.placeholder = 'Paste a foundry website...'), 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------ see styles overlay

let sheetFam = null;
function openSheet(fam) {
  sheetFam = fam;
  const foundryLink = $('#sheetFoundry');
  foundryLink.href = fam.foundryUrl;
  foundryLink.innerHTML = `${escapeHtml(fam.foundry)} ${ARROW}`;
  $('#sheetTitle').textContent = fam.name;
  const { shape } = kindOf(fam);
  $('#sheetMeta').textContent = [`${fam.styles.length} styles`, fam.weightMin === fam.weightMax ? null : `Weights ${fam.weightMin}–${fam.weightMax}`, fam.variable ? 'Variable' : null, shape ? KIND_LABEL[shape] : null].filter(Boolean).join(' · ');
  $('#sheetSpecimen').href = fam.specimenUrl;
  setSaveBtn($('#sheetSave'), isFamSaved(fam));
  $('#sheetWeightWrap').hidden = !fam.variable;
  $('#sheetTester').value = prefs.text;

  const pv = previewStyle(fam);
  loadFace(pv, { priority: true }).then((n) => applyFace($('#sheetTitle'), pv, n)).catch(() => {});

  $('#sheetStyles').replaceChildren(
    ...fam.styles.map((s) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'mono style__meta';
      const info = document.createElement('div');
      info.innerHTML = `${escapeHtml(s.name)}<br><span class="muted">${s.weightRange ? s.weightRange.join('–') : s.weight}${s.variable ? ' · variable' : ''}</span>`;
      const saveBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'pill style__save' });
      saveBtn._style = s;
      setSaveBtn(saveBtn, isStyleSaved(s));
      saveBtn.addEventListener('click', () => toggleStyleSave(fam, s));
      meta.append(info, saveBtn);
      const text = document.createElement('div');
      text.className = 'card__sample';
      text.contentEditable = 'true';
      text.spellcheck = false;
      text._style = s;
      loadFace(s)
        .then((n) => {
          applyFace(text, s, n);
          text.style.opacity = 1;
          if (s.variable) text.style.fontWeight = $('#sheetWeight').value;
        })
        .catch(() => info.insertAdjacentHTML('beforeend', '<br><span class="muted">preview blocked</span>'));
      li.append(meta, text);
      return li;
    })
  );
  updateSheetText();
  $('#sheet').showModal();
  $('#sheetStyles').scrollTop = 0;
}
function paintSheetSaves() {
  if (!sheetFam) return;
  setSaveBtn($('#sheetSave'), isFamSaved(sheetFam));
  $$('#sheetStyles .style__save').forEach((b) => setSaveBtn(b, isStyleSaved(b._style)));
}

function updateSheetText() {
  const t = $('#sheetTester').value || 'The quick brown fox jumps over the lazy dog';
  $$('#sheetStyles .card__sample').forEach((el) => (el.textContent = t));
}

// ------------------------------------------------------------ wiring

function fitWordmark() {
  const el = $('#wordmark');
  el.style.fontSize = '100px';
  const w = document.body.clientWidth - parseFloat(getComputedStyle(document.body).paddingLeft) * 2;
  el.style.fontSize = (100 * w) / el.scrollWidth + 'px';
}

function wire() {
  const tester = $('#tester');
  tester.value = prefs.text;
  tester.addEventListener('input', () => { prefs.text = tester.value; updateSamples(); savePrefs(); });

  $('#browseBtn').addEventListener('click', () => { scrollToList(); setTimeout(() => tester.focus({ preventScroll: true }), 450); });
  for (const b of $$('[data-panel]')) b.addEventListener('click', () => togglePanel(b.dataset.panel));
  $('#applyFilters').addEventListener('click', applyDraft);
  $('#clearFilters').addEventListener('click', () => { draft = { ...draft, foundries: [], types: [], sort: 'az', showBlocked: false, savedOnly: false }; applyDraft(); });
  $('#savesBtn').addEventListener('click', toggleSavedOnly);
  $('#sheetSave').addEventListener('click', () => sheetFam && toggleFamSave(sheetFam));
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#addInput').value;
    $('#addInput').value = '';
    addFoundry(v);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPanel && !$('#sheet').open) togglePanel(null); });

  const sheet = $('#sheet');
  $('#sheetClose').addEventListener('click', () => sheet.close());
  $('#sheetTester').addEventListener('input', updateSheetText);
  $('#sheetWeight').addEventListener('input', (e) => {
    $('#sheetWeightOut').textContent = e.target.value;
    $$('#sheetStyles .card__sample').forEach((el) => { if (el._style?.variable) el.style.fontWeight = e.target.value; });
  });

  $('#heroRefresh').addEventListener('click', refreshHero);

  window.addEventListener('scroll', updateStuck, { passive: true });
  window.addEventListener('resize', () => { fitWordmark(); sizeHero(); updateStuck(); });
  document.fonts.ready.then(fitWordmark);
}

wire();
fitWordmark();
updateStuck();
render();
loadMine();
loadBoard();
