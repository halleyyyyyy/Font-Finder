// GET /api/arena?channel=<are.na channel slug>
// Reads a public Are.na channel and returns the foundry websites linked in it.
// Add a foundry to the board and it shows up in Font Finder automatically.

const NOT_FOUNDRIES = /(^|\.)(instagram\.com|freefaces\.gallery|scripts\.directory|are\.na|pinterest\.[a-z.]+|twitter\.com|x\.com|youtube\.com|vimeo\.com|google\.[a-z.]+|behance\.net|dribbble\.com|tiktok\.com|facebook\.com|linkedin\.com)$/i;

export default async function handler(req, res) {
  const channel = new URL(req.url, 'http://localhost').searchParams.get('channel') || '';
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!/^[a-z0-9_-]+$/i.test(channel)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Add ?channel=<are.na channel slug>' }));
  }
  try {
    const blocks = [];
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://api.are.na/v2/channels/${channel}/contents?per=100&page=${page}`, {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`Are.na said HTTP ${r.status}`);
      const data = await r.json();
      const contents = data.contents || [];
      blocks.push(...contents);
      if (contents.length < 100) break;
    }
    const seen = new Set();
    const foundries = [];
    for (const b of blocks) {
      const raw = b.source && b.source.url;
      if (!raw) continue;
      let u;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      const host = u.hostname.replace(/^www\./, '');
      if (NOT_FOUNDRIES.test(host) || seen.has(host)) continue;
      seen.add(host);
      foundries.push({ url: u.origin, host, title: (b.source.title || b.title || host).slice(0, 80) });
    }
    res.setHeader('cache-control', 'public, s-maxage=600, stale-while-revalidate=86400');
    res.end(JSON.stringify({ channel, foundries }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: err.message || 'Could not read the Are.na channel' }));
  }
}
