// functions/api/hashrate.js
// Cloudflare Pages Function: fetches the live Zcash network hashrate from
// Blockchair (api.blockchair.com/zcash/stats) server-side to avoid browser
// CORS issues, and returns it as JSON. Endpoint: /api/hashrate

const HASHRATE_URL = 'https://api.blockchair.com/zcash/stats';

export async function onRequestGet() {
  try {
    const res = await fetch(HASHRATE_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const data = await res.json();
    const hashrate =
      data && data.data && data.data.blockchain
        ? data.data.blockchain.hashrate_24h
        : null;
    return new Response(
      JSON.stringify({ hashrate: hashrate ? Number(hashrate) : null, updated: new Date().toISOString() }),
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
