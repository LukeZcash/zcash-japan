// netlify/functions/note-feed.js
// Fetches RSS feed from note.com/zcashjapan and returns parsed article data as JSON.
// CORS-safe: runs server-side on Netlify, browser fetches /.netlify/functions/note-feed.

const RSS_URL = 'https://note.com/zcashjapan/rss';

function pick(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  // Strip CDATA wrapper if present
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

exports.handler = async () => {
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'ZcashJapan-NetlifyFunction/1.0' }
    });
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Upstream returned ${res.status}` })
      };
    }
    const xml = await res.text();

    // Split into <item>...</item> blocks
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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Cache for 10 minutes at the CDN edge so we don't hammer note.com
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      },
      body: JSON.stringify({ items })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Unknown error' })
    };
  }
};
