// Attendance routes share the website's origin. Secrets only exist in Worker bindings.
const API = 'https://discord.com/api/v10';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const AUTH_PATH = '/auth/discord';
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const list = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
const redirect = (location, cookies = []) => {
  const headers = new Headers({ ...HEADERS, Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
};
const cookieName = (req, name) => `${new URL(req.url).protocol === 'https:' ? '__Host-' : ''}sync_${name}`;
function readCookie(req, name) {
  const prefix = `${cookieName(req, name)}=`;
  return (req.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) || '';
}
function cookie(req, name, value, maxAge) {
  return `${cookieName(req, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function settings(env) {
  const origin = new URL(env.ORIGIN).origin;
  const timeZone = env.ATTENDANCE_TIMEZONE || 'UTC';
  new Intl.DateTimeFormat('en', { timeZone }).format();
  return { origin, timeZone, guild: env.DISCORD_GUILD_ID, memberRole: env.DISCORD_MEMBER_ROLE_ID, admins: list(env.DISCORD_ADMIN_IDS) };
}
const configured = env => Boolean(env.ATTENDANCE_DB && env.ORIGIN && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID);
export function dayKey(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const previousDay = day => new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}
export function currentStreak(days, today) {
  const present = new Set(days);
  let cursor = present.has(today) ? today : previousDay(today), streak = 0;
  while (present.has(cursor)) { streak++; cursor = previousDay(cursor); }
  return streak;
}
async function discordMember(token, config) {
  const response = await fetch(`${API}/users/@me/guilds/${encodeURIComponent(config.guild)}/member`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) return { allowed: false, expired: true };
  if (response.status === 403 || response.status === 404) return { allowed: false };
  if (!response.ok) throw new Error('Discord membership unavailable');
  const member = await response.json();
  return { allowed: !member.pending && (!config.memberRole || (member.roles || []).includes(config.memberRole)), member };
}
async function getSession(req, db) {
  const token = readCookie(req, 'session');
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT s.token_hash, s.access_token, s.expires_at, m.discord_id, m.username, m.display_name, m.avatar
    FROM attendance_sessions s JOIN attendance_members m ON m.discord_id = s.discord_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await hash(token), Date.now()).first();
}
async function summary(db, session, config, now = new Date()) {
  const today = dayKey(now, config.timeZone);
  const history = await db.prepare('SELECT day, checked_in_at FROM attendance_checkins WHERE discord_id = ? ORDER BY day DESC').bind(session.discord_id).all();
  const rows = history.results;
  return {
    configured: true, today, timeZone: config.timeZone,
    user: { id: session.discord_id, username: session.username, displayName: session.display_name, avatar: session.avatar, isAdmin: config.admins.includes(session.discord_id) },
    checkedIn: rows.find(row => row.day === today) || null,
    totalDays: rows.length, streak: currentStreak(rows.map(row => row.day), today), history: rows.slice(0, 60)
  };
}

export async function handleAttendance(req, env) {
  const url = new URL(req.url), path = url.pathname;
  if (!['/auth/discord', '/auth/discord/callback', '/auth/logout', '/api/attendance/session', '/api/attendance/checkin', '/api/attendance/admin'].includes(path)) return null;
  if (!configured(env)) return json({ configured: false, error: 'Attendance is being set up. Discord sign-in will be available once the clan connects its Discord app and attendance database.' }, 503);
  try {
    const config = settings(env), db = env.ATTENDANCE_DB;
    // Cookies and OAuth redirects must use the canonical website origin, not workers.dev.
    if (url.origin !== config.origin) return json({ error: 'Use attendance on the SYNCHRONIZED website.' }, 403);
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (req.method === 'POST' && req.headers.get('Origin') !== config.origin) return json({ error: 'Request origin is not allowed.' }, 403);

    if (path === AUTH_PATH && req.method === 'GET') {
      const state = randomToken(), now = Date.now();
      await db.batch([
        db.prepare('DELETE FROM attendance_oauth_states WHERE expires_at <= ?').bind(now),
        db.prepare('DELETE FROM attendance_sessions WHERE expires_at <= ?').bind(now),
        db.prepare('INSERT INTO attendance_oauth_states (token_hash, expires_at) VALUES (?, ?)').bind(await hash(state), now + 600000)
      ]);
      const authorize = new URL('https://discord.com/oauth2/authorize');
      authorize.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: `${config.origin}${AUTH_PATH}/callback`, response_type: 'code', scope: 'identify guilds.members.read', state }).toString();
      return redirect(authorize.href, [cookie(req, 'oauth', state, 600)]);
    }

    if (path === `${AUTH_PATH}/callback` && req.method === 'GET') {
      const state = url.searchParams.get('state');
      if (!state || !/^[a-f0-9]{64}$/.test(state) || state !== readCookie(req, 'oauth')) return json({ error: 'Sign-in expired or could not be verified. Please try again from the website.' }, 400);
      const used = await db.prepare('DELETE FROM attendance_oauth_states WHERE token_hash = ? AND expires_at > ? RETURNING token_hash').bind(await hash(state), Date.now()).first();
      if (!used) return json({ error: 'This sign-in link has expired or was already used.' }, 400);
      const fail = reason => redirect(`${config.origin}/?attendance_error=${reason}#attendance`, [cookie(req, 'oauth', '', 0)]);
      if (url.searchParams.has('error')) return fail('cancelled');
      const code = url.searchParams.get('code');
      if (!code) return fail('failed');
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${config.origin}${AUTH_PATH}/callback` })
      });
      if (!tokenResponse.ok) return fail('failed');
      const token = await tokenResponse.json();
      if (!token.access_token || !(token.expires_in > 0)) return fail('failed');
      const profileResponse = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!profileResponse.ok) return fail('failed');
      const profile = await profileResponse.json();
      const membership = await discordMember(token.access_token, config);
      if (!membership.allowed) return fail('membership');
      if (!/^\d{1,25}$/.test(profile.id) || !profile.username) return fail('failed');
      const sessionToken = randomToken();
      const expires = Math.floor(Math.min(Number(token.expires_in), SESSION_SECONDS));
      const avatar = profile.avatar && /^[a-zA-Z0-9_]+$/.test(profile.avatar) ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : null;
      const oldToken = readCookie(req, 'session');
      await db.batch([
        db.prepare(`INSERT INTO attendance_members (discord_id, username, display_name, avatar, joined_at, joined_day) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar`)
          .bind(profile.id, profile.username, membership.member.nick || profile.global_name || profile.username, avatar, new Date().toISOString(), dayKey(new Date(), config.timeZone)),
        db.prepare('DELETE FROM attendance_sessions WHERE token_hash = ?').bind(await hash(oldToken)),
        db.prepare('INSERT INTO attendance_sessions (token_hash, discord_id, access_token, expires_at) VALUES (?, ?, ?, ?)')
          .bind(await hash(sessionToken), profile.id, token.access_token, Date.now() + expires * 1000)
      ]);
      return redirect(`${config.origin}/#attendance`, [cookie(req, 'session', sessionToken, expires), cookie(req, 'oauth', '', 0)]);
    }

    if (path === '/auth/logout' && req.method === 'POST') {
      const token = readCookie(req, 'session');
      if (token) await db.prepare('DELETE FROM attendance_sessions WHERE token_hash = ?').bind(await hash(token)).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { ...HEADERS, 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, 'session', '', 0) } });
    }

    const session = await getSession(req, db);
    if (path === '/api/attendance/session' && req.method === 'GET') {
      if (!session) return json({ configured: true, user: null, today: dayKey(new Date(), config.timeZone), timeZone: config.timeZone });
      return json(await summary(db, session, config));
    }
    if (!session) return json({ error: 'Sign in with Discord to continue.' }, 401);

    if (path === '/api/attendance/checkin' && req.method === 'POST') {
      // Recheck server membership and the optional member role on every check-in.
      const membership = await discordMember(session.access_token, config);
      if (!membership.allowed) {
        await db.prepare('DELETE FROM attendance_sessions WHERE token_hash = ?').bind(session.token_hash).run();
        return json({ error: membership.expired ? 'Your Discord connection expired. Please sign in again.' : 'Check-in is for approved clan members in our Discord server.' }, membership.expired ? 401 : 403);
      }
      const now = new Date(), today = dayKey(now, config.timeZone);
      const result = await db.prepare('INSERT INTO attendance_checkins (discord_id, day, checked_in_at) VALUES (?, ?, ?) ON CONFLICT(discord_id, day) DO NOTHING')
        .bind(session.discord_id, today, now.toISOString()).run();
      return json({ ...await summary(db, session, config, now), alreadyCheckedIn: result.meta.changes === 0 });
    }

    if (path === '/api/attendance/admin' && req.method === 'GET') {
      if (!config.admins.includes(session.discord_id)) return json({ error: 'Only clan attendance admins can view this list.' }, 403);
      const membership = await discordMember(session.access_token, config);
      if (!membership.allowed) return json({ error: 'Reconnect with an approved clan Discord account.' }, 403);
      const day = url.searchParams.get('day') || dayKey(new Date(), config.timeZone);
      if (!validDay(day) || day > dayKey(new Date(), config.timeZone)) return json({ error: 'Choose a valid date up to today.' }, 400);
      const roster = await db.prepare(`SELECT m.discord_id, m.username, m.display_name, c.checked_in_at
        FROM attendance_members m LEFT JOIN attendance_checkins c ON m.discord_id = c.discord_id AND c.day = ?
        WHERE m.joined_day <= ? OR m.discord_id IN (SELECT discord_id FROM attendance_checkins WHERE day <= ?)
        ORDER BY c.checked_in_at IS NULL, c.checked_in_at, m.display_name COLLATE NOCASE`).bind(day, day, day).all();
      return json({ day, timeZone: config.timeZone, members: roster.results });
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch {
    return json({ error: 'Attendance is temporarily unavailable. Please try again shortly. If this continues, ask a clan admin to check the Discord and database setup.' }, 503);
  }
}
