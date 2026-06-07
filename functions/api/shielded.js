// functions/api/shielded.js
// Cloudflare Pages Function: fetches live Zcash shielded-pool balances
// from mainnet.zcashexplorer.app (the same upstream zecstats.com uses)
// and returns them as JSON. Endpoint: /api/shielded

const SHIELDED_URL = 'https://mainnet.zcashexplorer.app/api/v1/blockchain-info';

export async function onRequestGet() {
  try {
    const res = await fetch(SHIELDED_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const data = await res.json();
    const pools = {};
    for (const p of (data.valuePools || [])) pools[p.id] = p.chainValue;
    const body = {
      circulating: data.chainSupply ? data.chainSupply.chainValue : null,
      orchard: pools.orchard || 0,
      sapling: pools.sapling || 0,
      sprout: pools.sprout || 0,
      transparent: pools.transparent || 0,
      lockbox: pools.lockbox || 0,
      blocks: data.blocks || null,
      updated: new Date().toISOString()
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
