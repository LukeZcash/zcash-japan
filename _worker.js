// _worker.js
// Cloudflare Workers entry for Zcash Japan (Workers + Static Assets mode)
// - Handles /api/note-feed by fetching note.com RSS
// - Falls through to static assets (index.html, etc.) for everything else

const RSS_URL = 'https://note.com/zcashjapan/rss';

function pick(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function pickAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
  }
  return out;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleNoteFeed() {
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const xml = await res.text();
    const itemBlocks = pickAll(xml, 'item');

    const items = itemBlocks.map(block => {
      const title = stripHtml(pick(block, 'title'));
      const link = pick(block, 'link');
      const pubDate = pick(block, 'pubDate');
      const description = stripHtml(pick(block, 'description'));
      const categories = pickAll(block, 'category').map(stripHtml);
      const thumbnail =
        pick(block, 'media:thumbnail') ||
        (block.match(/<media:content[^>]*url="([^"]+)"/i) || [])[1] ||
        (block.match(/<enclosure[^>]*url="([^"]+)"/i) || [])[1] ||
        '';

      return {
        title,
        url: link,
        pubDate,
        excerpt: description.length > 160 ? description.slice(0, 160) + '…' : description,
        category: categories[0] || '',
        thumbnail
      };
    }).filter(item => item.title && item.url);

    return new Response(
      JSON.stringify({ items }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600, s-maxage=600'
        }
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/note-feed' && request.method === 'GET') {
        return handleNoteFeed();
      }
      // Unknown API endpoint
      return new Response(
        JSON.stringify({ error: 'Not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Try to serve a static asset (index.html, CSS, images, etc.)
    const assetResponse = await env.ASSETS.fetch(request);

    // SPA fallback: if a "page-like" URL (e.g. /buy, /about) returned 404,
    // serve index.html instead so the client-side router can handle it.
    if (assetResponse.status === 404) {
      const hasFileExtension = /\.[a-z0-9]+$/i.test(url.pathname);
      if (!hasFileExtension) {
        const indexUrl = new URL('/', request.url);
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }
    }

    return assetResponse;
  }
};
