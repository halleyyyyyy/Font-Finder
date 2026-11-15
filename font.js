// GET /api/font?u=<font file url>
// Browsers refuse to load fonts from other sites unless that site allows it (CORS),
// so we fetch the file on the server and hand it to the page. Preview use only.
const TYPES = { woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf' };
const MAX_BYTES = 12_000_000;

export default async function handler(req, res) {
  const target = new URL(req.url, 'http://localhost').searchParams.get('u');
  let u;
  try {
    u = new URL(target);
  } catch {
    res.statusCode = 400;
    return res.end('Bad font url');
  }
  const ext = (u.pathname.match(/\.(woff2|woff|otf|ttf)$/i) || [])[1]?.toLowerCase();
  const isPublicHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname);
  if (!/^https?:$/.test(u.protocol) || !ext || !isPublicHost) {
    res.statusCode = 400;
    return res.end('Only public .woff2 / .woff / .otf / .ttf files are allowed');
  }
  try {
    const upstream = await fetch(u.href, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        referer: u.origin + '/',
        origin: u.origin,
        accept: '*/*',
      },
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Font file too large');
    res.setHeader('content-type', TYPES[ext]);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.end('Could not fetch font: ' + err.message);
  }
}
