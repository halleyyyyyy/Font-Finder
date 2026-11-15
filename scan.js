// GET /api/scan?url=https://abcdinamo.com  →  every typeface found on that foundry site
import { scanFoundry } from '../lib/scraper.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost').searchParams.get('url');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!url) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Add ?url=https://some-foundry.com' }));
  }
  try {
    const data = await scanFoundry(url);
    // let Vercel's CDN remember the result for a day so repeat scans are instant
    res.setHeader('cache-control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.end(JSON.stringify(data));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: err.message || 'Scan failed' }));
  }
}
