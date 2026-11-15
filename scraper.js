// FONT EXPLORER — foundry scraper
// ------------------------------------------------------------
// Works like WhatFont / Font Ninja, but on the server:
//   1. Load the foundry homepage (and its "all typefaces" page).
//   2. Find links that look like specimen pages (/typefaces/x, /fonts/x …).
//   3. Visit those pages, collect every stylesheet + font file they use.
//   4. Read every @font-face rule, plus any loose .woff2/.woff/.otf/.ttf URLs.
//   5. Group the styles into families and link each family to its specimen page.
// No dependencies — just fetch + regular expressions.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const MAX_SPECIMEN_PAGES = 60;
const MAX_STYLESHEETS = 60;
const CONCURRENCY = 5;
const TOTAL_BUDGET_MS = 42_000;

// Third-party hosts whose fonts/CSS are not the foundry's own work.
const BLOCKED_HOSTS = [
  'fonts.googleapis.com', 'fonts.gstatic.com', 'typekit.net', 'fontawesome', 'cdnjs.cloudflare.com',
  'jsdelivr.net', 'unpkg.com', 'shopifycloud', 'stripe.com', 'sibforms.com', 'hubspot', 'intercom',
  'cookiebot', 'onetrust', 'vimeo', 'youtube', 'klaviyo', 'paypal', 'googletagmanager', 'recaptcha',
];

// Family names that are UI helpers, not typefaces.
const JUNK_FAMILY = /adobe ?blank|icon|awesome|glyph|symbol|swiper|slick|loading|fallback|emoji|dashicons|material|feather|ionic|revicons|eicons|fontello|socicon|social/i;

// Slugs that look like specimen pages but aren't.
const NON_SPECIMEN_SLUGS = new Set([
  'all', 'new', 'free', 'trial', 'trials', 'search', 'page', 'tag', 'tags', 'category', 'categories',
  'licensing', 'license', 'licenses', 'info', 'in-use', 'custom', 'bundle', 'bundles', 'cart', 'checkout',
  'account', 'login', 'faq', 'about', 'contact', 'index', 'overview', 'catalog', 'collection', 'collections',
  'free-trial-fonts', 'trial-fonts', 'sale', 'gift-card', 'newsletter', 'feed', 'rss',
]);

const SPECIMEN_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:typefaces?|fonts?|font-families|families|family|retail(?:-fonts)?|collections\/[^/]+\/products|products|catalog(?:ue)?|shop\/fonts?|library)\/([^/?#]+)\/?$/i;

const INDEX_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:typefaces|fonts|collections\/fonts|collections\/all|retail|retail-fonts|catalog(?:ue)?|library|shop)\/?$/i;

// ------------------------------------------------------------
// small helpers

function deadlineFrom(ms) {
  const end = Date.now() + ms;
  return () => end - Date.now();
}

async function fetchText(url, opts = {}, attempt = 0) {
  try {
    return await fetchOnce(url, opts);
  } catch (e) {
    // polite retry when a site says "slow down" (HTTP 429) or hiccups
    if (attempt < 2 && /HTTP (429|5\d\d)/.test(e.message)) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      return fetchText(url, opts, attempt + 1);
    }
    throw e;
  }
}

async function fetchOnce(url, { referer, timeout = 12_000, maxBytes = 4_000_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,text/css,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...(referer ? { referer } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error('Response too large');
    return { text: new TextDecoder('utf-8').decode(buf), finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

async function pool(items, limit, worker, timeLeft) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length && timeLeft() > 2_000) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx]);
      } catch {
        out[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function abs(href, base) {
  try {
    const u = new URL(href.trim().replace(/&amp;/g, '&'), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function isBlocked(url) {
  try {
    const h = new URL(url).hostname;
    return BLOCKED_HOSTS.some((b) => h.includes(b));
  } catch {
    return true;
  }
}

function baseDomain(host) {
  const parts = host.replace(/^www\./, '').split('.');
  // handle things like klim.co.nz / foo.com.au
  if (parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// ------------------------------------------------------------
// page parsing

const FONT_EXT = /\.(woff2|woff|otf|ttf)(?:[?#]|$)/i;
const LOOSE_FONT_URL =
  /(?:https?:)?\/\/[^"'\s()<>\\]+?\.(?:woff2|woff|otf|ttf)(?:\?[^"'\s()<>\\]*)?|(?<=["'(=\s])\/[^"'\s()<>\\]+?\.(?:woff2|woff|otf|ttf)(?:\?[^"'\s()<>\\]*)?/gi;

function parsePage(html, pageUrl) {
  const page = { url: pageUrl, links: [], cssUrls: [], inlineCss: [], fontUrls: [], title: null, siteName: null, icon: null };

  // stylesheets & preloaded fonts
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    const u = abs(href, pageUrl);
    if (!u || isBlocked(u)) continue;
    const as = (attr(tag, 'as') || '').toLowerCase();
    if (rel.includes('stylesheet') || (rel.includes('preload') && as === 'style')) page.cssUrls.push(u);
    else if (FONT_EXT.test(u)) page.fontUrls.push(u);
    else if (rel.includes('icon') && !page.icon) page.icon = u;
  }

  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) page.inlineCss.push(m[1]);

  // loose font URLs anywhere (data attributes, JSON blobs, inline scripts…)
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  for (const m of unescaped.matchAll(LOOSE_FONT_URL)) {
    const u = abs(decodeEntities(m[0]), pageUrl);
    if (u && !isBlocked(u)) page.fontUrls.push(u);
  }

  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.includes("'")) continue;
    const u = abs(href, pageUrl);
    if (u) page.links.push(u);
  }

  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*>/i);
  if (og) page.siteName = attr(og[0], 'content');
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) page.title = decodeEntities(t[1].replace(/\s+/g, ' ').trim());
  return page;
}

// ------------------------------------------------------------
// CSS parsing

function parseFontFaces(css, cssUrl) {
  const faces = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const get = (prop) => {
      const r = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i'));
      return r ? r[1].trim() : null;
    };
    const family = (get('font-family') || '').replace(/^["']|["']$/g, '').trim();
    const src = get('src') || '';
    if (!family || !src) continue;

    // pick the best format available
    const candidates = [];
    for (const u of src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi)) {
      const raw = u[2].trim();
      if (raw.startsWith('data:')) continue;
      const url = abs(raw, cssUrl);
      if (!url || isBlocked(url)) continue;
      const fmt = (u[3] || (url.match(FONT_EXT) || [])[1] || '').toLowerCase();
      const rank = fmt.includes('woff2') ? 0 : fmt.includes('woff') ? 1 : /opentype|truetype|otf|ttf/.test(fmt) ? 2 : 9;
      if (rank < 9) candidates.push({ url, rank });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => a.rank - b.rank);

    faces.push({
      family,
      url: candidates[0].url,
      weight: get('font-weight'),
      style: get('font-style'),
      unicodeRange: get('unicode-range'),
    });
  }
  return faces;
}

function findImports(css, cssUrl) {
  const out = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi)) {
    const u = abs(m[1], cssUrl);
    if (u && !isBlocked(u)) out.push(u);
  }
  return out;
}

// ------------------------------------------------------------
// naming: turn "GT-Era-Text-Thin" or "ABCCamera-MediumItalic_ab12cd34.woff2"
// into { family: "GT Era Text", style: "Thin" }

const WEIGHT_WORDS = {
  hairline: 100, thin: 100, extralight: 200, ultralight: 200, light: 300, book: 400, regular: 400,
  normal: 400, roman: 400, plain: 400, medium: 500, semibold: 600, demibold: 600, demi: 600, bold: 700,
  extrabold: 800, ultrabold: 800, heavy: 800, black: 900, fat: 900, ultra: 900, super: 900,
};
const STYLE_WORDS = new Set([
  ...Object.keys(WEIGHT_WORDS), 'extra', 'semi', 'italic', 'oblique', 'kursiv', 'slanted', 'slant', 'upright',
  'it', 'ital', 'vf', 'variable', 'var', 'web', 'webfont', 'trial', 'widths', 'condensed', 'compressed',
  'extended', 'expanded', 'wide', 'narrow', 'cond', 'comp', 'ext', 'standard', 'backslant', 'unslanted',
  'lcgv', 'lcg', 'lc', 'rotalic', 'lazer', 'subset', 'latin', 'ext', 'woff', 'woff2', 'otf', 'ttf', 'min', 'v1', 'v2', 'v3',
]);

const HARD_STYLE = new Set(['web', 'webfont', 'regular', 'italic', 'bold', 'semibold', 'extrabold', 'light', 'extralight', 'thin', 'hairline', 'medium', 'book', 'black', 'heavy', 'oblique', 'kursiv', 'roman']);

function splitWords(s) {
  return s
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.+]+/)
    .filter(Boolean);
}

function stripHashes(name) {
  let s = name;
  s = s.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ''); // shopify uuid
  // build hashes like "-d2720e99207f…" or Django's "_L6hxfEU"
  for (let i = 0; i < 2; i++) {
    s = s.replace(/[-_.~]([A-Za-z0-9]{6,})$/, (m, seg) => {
      const hasDigit = /\d/.test(seg);
      const innerUpper = /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(seg);
      const isWords = splitWords(seg).every((w) => STYLE_WORDS.has(w.toLowerCase()));
      return (hasDigit || innerUpper) && !isWords && !/^\d{3}$/.test(seg) ? '' : m;
    });
  }
  s = s.replace(/_(?![a-z]+$)[A-Za-z0-9]{7}$/, ''); // Django storage suffix
  s = s.replace(/^_+/, '').replace(/_[a-f0-9]{5,}$/i, ''); // Next.js "__Inter_a1b2c3"
  return s;
}

function analyseName(raw) {
  const words = splitWords(stripHashes(raw)).filter((w, i) => i === 0 || !/^(LCGV|LCG|LC)$/.test(w));
  const styleWords = [];
  // "Cardinal Classic Web Regular Display" → cut at the first clear style word after the name
  const cut = words.findIndex((w, i) => i > 0 && HARD_STYLE.has(w.toLowerCase()));
  if (cut > 0) styleWords.push(...words.splice(cut));
  while (words.length > 1 && STYLE_WORDS.has(words[words.length - 1].toLowerCase())) styleWords.unshift(words.pop());
  return { family: words.join(' '), styleWords };
}

function fileBase(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    return p.split('/').pop().replace(/(\.(woff2|woff|otf|ttf|eot))+$/i, '');
  } catch {
    return '';
  }
}

function weightFromWords(words) {
  const w = words.map((x) => x.toLowerCase());
  const joined = w.join('');
  for (const key of ['extralight', 'ultralight', 'semibold', 'demibold', 'extrabold', 'ultrabold']) if (joined.includes(key)) return WEIGHT_WORDS[key];
  for (const x of w) if (x in WEIGHT_WORDS && x !== 'ultra' && x !== 'demi') return WEIGHT_WORDS[x];
  return null;
}

const WEIGHT_LABEL = { 100: 'Thin', 200: 'Extralight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black' };

function keyOf(family) {
  return family.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugOf(family) {
  return family.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function looksObfuscated(name) {
  return /^(font|f|ff|typeface|webfont|fonts?\s?\d+)\d*$/i.test(name) || !/[a-z]{2}/i.test(name) || /^(?=[a-f0-9]*\d)[a-f0-9]{6,}/i.test(name.replace(/\s/g, "")) || /^[a-f0-9]{8,}$/i.test(name) || name.length < 2;
}

function describeFace(face) {
  const declared = face.family ? analyseName(face.family) : null;
  const fromFile = analyseName(fileBase(face.url));
  const fileOk = fromFile.family && !looksObfuscated(fromFile.family) && !STYLE_WORDS.has(fromFile.family.toLowerCase());
  const declaredOk = declared && declared.family && !looksObfuscated(declared.family);
  // File names are usually the most honest ("GT-Alpina-Thin.woff2"); CSS names are often abbreviated ("Alp-Thin").
  const useDeclared = declaredOk && !fileOk;
  let family = fileOk ? fromFile.family : declaredOk ? declared.family : fromFile.family;
  // "founders grotesk" → "Founders Grotesk", "CALIBRE" → "Calibre" (keep short prefixes like "GT", "ABC")
  family = family
    .split(' ')
    .map((w) => (w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 4) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
  let styleWords = useDeclared ? declared.styleWords : fromFile.styleWords.length ? fromFile.styleWords : declared?.styleWords || [];

  const lower = styleWords.map((w) => w.toLowerCase());
  const weightStr = (face.weight || '').trim();
  const range = weightStr.match(/^(\d{1,3})\s+(\d{1,3})$/);
  const variable = !!range || lower.some((w) => w === 'vf' || w === 'variable' || w === 'var');
  const italic = /italic|oblique/i.test(face.style || '') || lower.some((w) => ['italic', 'oblique', 'kursiv', 'slanted', 'slant', 'it', 'ital', 'backslant'].includes(w));

  let weight = weightFromWords(styleWords);
  if (weight == null) {
    if (range) weight = 400;
    else if (/^\d{3}$/.test(weightStr)) weight = +weightStr;
    else if (/bold/i.test(weightStr)) weight = 700;
    else weight = 400;
  }

  const shown = styleWords.filter((w) => !['vf', 'web', 'webfont', 'trial', 'var', 'lcgv', 'subset', 'latin', 'min', 'woff', 'woff2', 'otf', 'ttf'].includes(w.toLowerCase()));
  let style = shown.join(' ');
  if (!style) style = (variable ? 'Variable' : WEIGHT_LABEL[Math.round(weight / 100) * 100] || 'Regular') + (italic && !variable ? ' Italic' : italic ? ' Italic' : '');
  if (italic && !/italic|oblique|kursiv|slant/i.test(style)) style += ' Italic';

  return {
    family,
    style,
    weight,
    weightRange: range ? [+range[1], +range[2]] : null,
    italic,
    variable,
    url: face.url,
  };
}

// ------------------------------------------------------------
// specimen matching

function specimenSlug(url, origin) {
  try {
    const u = new URL(url);
    if (baseDomain(u.hostname) !== baseDomain(new URL(origin).hostname)) return null;
    const m = u.pathname.match(SPECIMEN_PATH);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (NON_SPECIMEN_SLUGS.has(slug) || /^\d+$/.test(slug) || /\.(html?|php|xml|json|pdf|zip)$/.test(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

function matchSpecimen(family, specimens) {
  const words = family.split(' ');
  const compact = keyOf(family);
  // foundry prefixes like "ABC Camera", "PP Mori", "GT Alpina", "KMR Apparat"
  const noPrefix = words.length > 1 && /^[A-Z]{2,4}$/.test(words[0]) ? keyOf(words.slice(1).join(' ')) : null;
  let best = null;
  let bestScore = 0;
  for (const [slug, url] of specimens) {
    const s = slug.replace(/[^a-z0-9]/g, '');
    if (s.length < 2) continue;
    let score = 0;
    if (s === compact || s === noPrefix) score = 1000;
    else if (compact.startsWith(s) || (noPrefix && noPrefix.startsWith(s))) score = s.length * 2;
    else if (s.startsWith(compact) || (noPrefix && noPrefix.length > 3 && s.startsWith(noPrefix))) score = compact.length;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

// ------------------------------------------------------------
// main

export async function scanFoundry(input) {
  const timeLeft = deadlineFrom(TOTAL_BUDGET_MS);
  let startUrl = input.trim();
  if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
  const start = new URL(startUrl);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(start.hostname)) throw new Error('That does not look like a public website.');

  const home = await fetchText(start.href).catch((e) => {
    throw new Error(`Could not open ${start.hostname} (${e.message}). Some foundries block automated visits.`);
  });
  const origin = new URL(home.finalUrl).origin;
  const pages = [parsePage(home.text, home.finalUrl)];

  const specimens = new Map(); // slug -> url
  const addLinks = (page) => {
    for (const l of page.links) {
      const slug = specimenSlug(l, origin);
      if (slug && !specimens.has(slug)) specimens.set(slug, l);
    }
  };
  addLinks(pages[0]);

  // look for an "all typefaces" index page
  const indexCandidates = new Set();
  for (const l of pages[0].links) {
    try {
      const u = new URL(l);
      if (baseDomain(u.hostname) === baseDomain(start.hostname) && INDEX_PATH.test(u.pathname)) indexCandidates.add(u.origin + u.pathname);
    } catch {}
  }
  if (start.pathname !== '/' && start.pathname !== '') indexCandidates.add(start.href); // user pasted a specific page
  for (const p of ['/typefaces', '/fonts', '/collections/fonts']) if (indexCandidates.size < 3) indexCandidates.add(origin + p);

  const indexPages = await pool([...indexCandidates].slice(0, 3), 3, async (u) => {
    if (u === home.finalUrl) return null;
    const r = await fetchText(u, { referer: origin + '/' });
    return parsePage(r.text, r.finalUrl);
  }, timeLeft);
  for (const p of indexPages) if (p) { pages.push(p); addLinks(p); }

  // visit specimen pages
  const specimenUrls = [...new Set(specimens.values())].slice(0, MAX_SPECIMEN_PAGES);
  const specimenPages = await pool(specimenUrls, CONCURRENCY, async (u) => {
    const r = await fetchText(u, { referer: origin + '/', timeout: 10_000 });
    return parsePage(r.text, r.finalUrl);
  }, timeLeft);
  for (const p of specimenPages) if (p) pages.push(p);

  // stylesheets (deduped across all pages) → @font-face
  const cssToPages = new Map();
  for (const p of pages) for (const c of p.cssUrls) {
    if (!cssToPages.has(c)) cssToPages.set(c, new Set());
    cssToPages.get(c).add(p.url);
  }
  const rawFaces = []; // { family, url, weight, style, page }
  for (const p of pages) for (const css of p.inlineCss) for (const f of parseFontFaces(css, p.url)) rawFaces.push({ ...f, page: p.url });

  const cssList = [...cssToPages.keys()].slice(0, MAX_STYLESHEETS);
  const imported = [];
  await pool(cssList, CONCURRENCY, async (cssUrl) => {
    const r = await fetchText(cssUrl, { referer: origin + '/' });
    const pagesUsing = cssToPages.get(cssUrl);
    const onePage = pagesUsing.size === 1 ? [...pagesUsing][0] : null;
    for (const f of parseFontFaces(r.text, r.finalUrl)) rawFaces.push({ ...f, page: onePage });
    for (const i of findImports(r.text, r.finalUrl)) if (!cssToPages.has(i)) imported.push(i);
  }, timeLeft);
  await pool([...new Set(imported)].slice(0, 10), CONCURRENCY, async (cssUrl) => {
    const r = await fetchText(cssUrl, { referer: origin + '/' });
    for (const f of parseFontFaces(r.text, r.finalUrl)) rawFaces.push({ ...f, page: null });
  }, timeLeft);

  // loose font files without an @font-face rule
  const declaredUrls = new Set(rawFaces.map((f) => f.url.split('?')[0]));
  for (const p of pages) for (const u of p.fontUrls) {
    if (!declaredUrls.has(u.split('?')[0])) {
      declaredUrls.add(u.split('?')[0]);
      rawFaces.push({ family: null, url: u, weight: null, style: null, page: p.url });
    }
  }

  // group into families
  const families = new Map();
  for (const raw of rawFaces) {
    const d = describeFace(raw);
    if (!d.family || JUNK_FAMILY.test(d.family) || JUNK_FAMILY.test(fileBase(d.url))) continue;
    const key = keyOf(d.family);
    if (!key || key.length < 2) continue;
    if (/^[A-Z]{1,4}$/.test(d.family)) continue; // just a prefix like "GT" or "ABC"
    if (!families.has(key)) families.set(key, { key, name: d.family, styles: new Map(), pages: new Set() });
    const fam = families.get(key);
    if (raw.page) fam.pages.add(raw.page);
    // prefer the nicest-looking spelling of the name (with spaces / capitals)
    if (d.family.includes(' ') && !fam.name.includes(' ')) fam.name = d.family;
    else if (/[^\x00-\x7f]/.test(d.family) && !/[^\x00-\x7f]/.test(fam.name) && d.family.split(' ').length === fam.name.split(' ').length) fam.name = d.family;
    const sKey = `${d.style.toLowerCase()}|${d.italic}`;
    const existing = fam.styles.get(sKey);
    if (!existing || (/\.woff2/i.test(d.url) && !/\.woff2/i.test(existing.url))) fam.styles.set(sKey, d);
  }

  const specimenUrlSet = new Set(specimenUrls);
  const generic = (s) => !s || s.length < 3 || /^(page|home|index|shop|store|untitled)$/i.test(s.trim());
  const foundryName = cleanSiteName([pages[0].siteName, pages[0].title].map((s) => s && cleanSiteName(s)).find((s) => !generic(s)) || start.hostname.replace(/^www\./, ''));
  const indexUrl = indexPages.find(Boolean)?.url || origin + '/';

  const result = [];
  for (const fam of families.values()) {
    const styles = [...fam.styles.values()].sort((a, b) => a.weight - b.weight || a.italic - b.italic || a.style.localeCompare(b.style));
    let specimenUrl = matchSpecimen(fam.name, specimens);
    if (!specimenUrl) {
      const seenOn = [...fam.pages].filter((p) => specimenUrlSet.has(p));
      if (seenOn.length >= 1 && seenOn.length <= 2) specimenUrl = seenOn[0];
    }
    const weights = styles.flatMap((s) => (s.weightRange ? s.weightRange : [s.weight]));
    result.push({
      id: `${baseDomain(start.hostname)}:${fam.key}`,
      name: fam.name,
      foundry: foundryName,
      foundryUrl: origin,
      specimenUrl: specimenUrl || indexUrl,
      specimenMatched: !!specimenUrl,
      variable: styles.some((s) => s.variable),
      hasItalic: styles.some((s) => s.italic),
      weightMin: Math.min(...weights),
      weightMax: Math.max(...weights),
      styles: styles.map(({ style, weight, weightRange, italic, variable, url }) => ({ name: style, weight, weightRange, italic, variable, url })),
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));

  return {
    foundry: { name: foundryName, url: origin, host: new URL(origin).hostname.replace(/^www\./, ''), icon: pages[0].icon },
    families: result,
    stats: {
      pagesScanned: pages.length,
      specimenLinks: specimens.size,
      stylesheets: cssList.length,
      fontFiles: declaredUrls.size,
      ms: TOTAL_BUDGET_MS - timeLeft(),
    },
    scannedAt: new Date().toISOString(),
  };
}

function cleanSiteName(s) {
  let name = s.replace(/^(welcome to|home)\s*[:\-–—|]?\s*/i, '').split(/\s+[|–—·•]\s+|\s+-\s+/)[0].trim();
  if (name.length > 40) name = name.slice(0, 40);
  return name || s;
}
