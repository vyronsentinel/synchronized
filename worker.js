// Cloudflare Worker: the SYNC CHECK ranking.
// Bindings: KV namespace LB, secret SALT, variable ORIGIN (your site, e.g. https://example.com).
// The visitor's IP is read here on the server, scrambled with SALT, and only the scramble is stored.
const KEEP = 100, enc = new TextEncoder();

async function scramble(ip, salt) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(salt + '|' + ip));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 16);

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ORIGIN,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const send = (o, s = 200) => new Response(JSON.stringify(o), {
      status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const ip = req.headers.get('CF-Connecting-IP');
    if (!ip) return send({ error: 'No address' }, 400);
    const me = await scramble(ip, env.SALT);
    const board = JSON.parse((await env.LB.get('board')) || '[]'); // sorted: best score first, earlier wins ties

    const view = () => {
      const i = board.findIndex(e => e.h === me);
      return {
        top: board.slice(0, 10).map(e => ({ name: e.name, score: e.score, me: e.h === me })),
        you: i >= 0 ? { rank: i + 1, score: board[i].score } : null,
        total: board.length
      };
    };

    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/top') return send(view());

    if (req.method === 'POST' && path === '/score') {
      if (req.headers.get('Origin') !== env.ORIGIN) return send({ error: 'Not allowed' }, 403);
      let b; try { b = await req.json(); } catch { return send({ error: 'Bad request' }, 400); }
      const score = Number(b.score), name = cleanName(b.name);
      if (!Number.isInteger(score) || score < 0 || score > 100) return send({ error: 'Bad score' }, 400);
      if (!name) return send({ error: 'Add a name first.' }, 400);

      const i = board.findIndex(e => e.h === me);
      if (i >= 0 && score <= board[i].score) {
        return send({ error: 'Your score must beat your personal best to update the ranking.' }, 409);
      }

      if (await env.LB.get('rl:' + me)) return send({ error: 'Slow down. Try again in a minute.' }, 429);
      await env.LB.put('rl:' + me, '1', { expirationTtl: 60 });

      if (i < 0) board.push({ h: me, name, score, t: Date.now() });
      else board[i] = { h: me, name, score, t: Date.now() };
      board.sort((a, c) => c.score - a.score || a.t - c.t);
      await env.LB.put('board', JSON.stringify(board.slice(0, KEEP)));
      return send(view());
    }
    return send({ error: 'Not found' }, 404);
  }
};
