const COOKIE = "dash_session";
const SESSION_DAYS = 365;
const enc = new TextEncoder();

// ---------- auth ----------
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
}
async function validSession(req, env) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}
const loginPage = (err = "") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard login</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e13;color:#e9edf3;font:18px system-ui,sans-serif}
form{display:flex;flex-direction:column;gap:16px;width:min(420px,90vw)}
input,button{min-height:64px;border-radius:12px;font-size:22px;padding:0 18px;border:1px solid #262f40}
input{background:#141922;color:#e9edf3}button{background:#f2a33a;color:#1a1206;font-weight:700;border:0}
p{color:#ff5d5d;margin:0}</style></head><body><form method="post" action="/login">
<h1 style="margin:0">Dashboard</h1>${err ? `<p>${err}</p>` : ""}
<input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
<button type="submit">Unlock</button></form></body></html>`, { status: err ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } });

// ---------- calendars ----------
function getCalendars(env) {
  try {
    // Accept phone-typed curly quotes too.
    const raw = (env.CALENDARS || "[]").replace(/[\u201C\u201D\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'");
    const cals = JSON.parse(raw);
    return { cals: Array.isArray(cals) ? cals : [cals], errors: [] };
  } catch (e) {
    return { cals: [], errors: [`CALENDARS isn't valid JSON (${e.message})`] };
  }
}
// Stream one calendar's iCal feed through, so the secret URL never reaches the browser.
async function proxyCalendar(env, i) {
  const cal = getCalendars(env).cals[i];
  if (!cal?.url) return json({ error: "No such calendar" }, 404);
  const r = await fetch(cal.url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) return json({ error: `${cal.name}: HTTP ${r.status}` }, 502);
  return new Response(r.body, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=240" } });
}

// ---------- Todoist ----------
const TD_DEFAULT = "https://api.todoist.com/api/v1";
let TD = TD_DEFAULT;
async function getTasks(env) {
  if (!env.TODOIST_TOKEN) return { tasks: [], errors: ["Todoist token not set"] };
  const tasks = [];
  let cursor = null;
  try {
    do {
      const u = new URL(`${TD}/tasks`);
      u.searchParams.set("limit", "200");
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${env.TODOIST_TOKEN}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      for (const t of j.results || []) tasks.push({
        id: t.id, title: t.content, p: 5 - (t.priority || 1), // Todoist priority 4 = P1
        due: t.due?.date || null, recurring: !!t.due?.is_recurring,
      });
      cursor = j.next_cursor;
    } while (cursor && tasks.length < 1000);
    return { tasks, errors: [] };
  } catch (e) { return { tasks, errors: [`Todoist: ${e.message}`] }; }
}
async function setTask(env, id, action) {
  const r = await fetch(`${TD}/tasks/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${env.TODOIST_TOKEN}` },
  });
  return new Response(null, { status: r.ok ? 204 : 502 });
}

async function snoozeTask(env, id) {
  const r = await fetch(`${TD}/tasks/${encodeURIComponent(id)}`, {
    method: "POST", headers: { Authorization: `Bearer ${env.TODOIST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ due_string: "tomorrow" }),
  });
  return new Response(null, { status: r.ok ? 204 : 502 });
}

// ---------- synced countdowns (one Durable Object holds the list) ----------
export class Store {
  constructor(state) { this.state = state; }
  async fetch(req) {
    if (req.method === "PUT") {
      const body = await req.text();
      let v; try { v = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
      if (!Array.isArray(v) || body.length > 20000) return new Response("bad list", { status: 400 });
      await this.state.storage.put("cds", v);
      return new Response(null, { status: 204 });
    }
    return Response.json((await this.state.storage.get("cds")) ?? null, { headers: { "cache-control": "no-store" } });
  }
}

// ---------- router ----------
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ---------- MassDOT work zones (CWZ / WZDx GeoJSON) ----------
// The key stays server-side. The feed is passed through untouched (no parsing: free-plan CPU limit);
// the browser keeps only zones near the car. The docs don't say how the key is sent, so try the
// common styles and remember the one that works.
const WZ_URL = "https://api.massdot-swzm.com/api/v1/cwz/work-zone-feed";
const WZ_PUBLIC = "https://feed.massdot-swzm.com/massdot_wzdx_v4.1_work_zone_feed.geojson"; // public WZDx 4.1 file, no key
let wzStyle = -1;
async function workZones(env, ctx) {
  const key = env.MASSDOT_WZ_KEY || "";
  const cache = caches.default, ck = new Request("https://cache.local/workzones");
  const hit = await cache.match(ck);
  if (hit) return hit;
  const styles = [
    () => [WZ_PUBLIC, {}],
    () => [WZ_URL, { "x-api-key": key }],
    () => [`${WZ_URL}?api_key=${encodeURIComponent(key)}`, {}],
    () => [WZ_URL, { Authorization: `Bearer ${key}` }],
    () => [`${WZ_URL}?apiKey=${encodeURIComponent(key)}`, {}],
    () => [`${WZ_URL}?key=${encodeURIComponent(key)}`, {}],
    () => [WZ_URL, { Authorization: key }],
    () => [`${WZ_URL}?api-key=${encodeURIComponent(key)}`, {}],
    () => [WZ_URL, { "Ocp-Apim-Subscription-Key": key }],
    () => [WZ_URL, { ApiKey: key }],
  ];
  const order = wzStyle >= 0 ? [wzStyle, ...styles.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...styles.keys()];
  const tried = [];
  for (const i of order) {
    const [u, h] = styles[i]();
    let r;
    try { r = await fetch(u, { headers: { accept: "application/geo+json, application/json", ...h } }); } catch (e) { tried.push(`${i}:${e.message}`); continue; }
    if (r.ok) {
      wzStyle = i;
      const out = new Response(r.body, { headers: { "content-type": "application/json", "cache-control": "private, max-age=120" } });
      ctx && ctx.waitUntil && ctx.waitUntil(cache.put(ck, out.clone()));
      return out;
    }
    tried.push(`${i}:${r.status}`);
    if (i === 0) { if (!key) break; continue; }
    if (r.status !== 401 && r.status !== 403 && r.status !== 400) break;
  }
  return json({ error: `MassDOT work zones unavailable (${tried.join(", ")})` }, 502);
}

// Tolerate stray spaces in secret names typed on a phone ("DASH_PASSWORD ").
// Home geofence: HOME_ADDRESS secret is a street address or "lat,lon". Address is geocoded once (US Census, then OSM) and cached.
let HOME_CACHE = null;
async function homeSpot(env, ctx) {
  const a = env.HOME_ADDRESS;
  if (!a) return null;
  if (HOME_CACHE && HOME_CACHE.a === a) return HOME_CACHE.v;
  const ll = a.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  let v = ll ? { lat: +ll[1], lon: +ll[2] } : null;
  if (!v) {
    const key = new Request("https://cache.local/home/" + encodeURIComponent(a));
    const hit = await caches.default.match(key).catch(() => null);
    if (hit) v = await hit.json();
    if (!v) {
      try {
        const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(a)}`);
        const m = (await r.json())?.result?.addressMatches?.[0]?.coordinates;
        if (m) v = { lat: m.y, lon: m.x };
      } catch {}
      if (!v) {
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(a)}`, { headers: { "user-agent": "tesla-dashboard/1.0" } });
          const m = (await r.json())?.[0];
          if (m) v = { lat: +m.lat, lon: +m.lon };
        } catch {}
      }
      if (v) ctx?.waitUntil?.(caches.default.put(key, new Response(JSON.stringify(v), { headers: { "cache-control": "max-age=2592000" } })));
    }
  }
  if (v) HOME_CACHE = { a, v };
  return v;
}

function cleanEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(env)) {
    const t = k.trim();
    if (t !== k && !(t in out)) out[t] = env[k];
  }
  for (const k of ["DASH_PASSWORD", "SESSION_SECRET", "CALENDARS", "TODOIST_TOKEN", "MASSDOT_WZ_KEY", "HOME_ADDRESS"]) {
    if (typeof out[k] === "string") out[k] = out[k].trim();
  }
  return out;
}

export default {
  // Show the real error instead of Cloudflare's generic 1101 page.
  async fetch(req, rawEnv, ctx) {
    try { return await handle(req, rawEnv, ctx); }
    catch (e) {
      console.error(e);
      const msg = `Dashboard error: ${e && e.message || e}\n${new URL(req.url).pathname}`;
      return new Response(msg, { status: 500, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
  },
};

async function handle(req, rawEnv, ctx) {
  {
    const env = cleanEnv(rawEnv);
    const url = new URL(req.url);
    TD = env.TODOIST_API || TD_DEFAULT; // override only for local testing
    if (!env.SESSION_SECRET || !env.DASH_PASSWORD) {
      // Names only, never values, to help debug setup.
      const seen = Object.keys(rawEnv).filter(k => k !== "ASSETS").map(k => JSON.stringify(k)).join(", ") || "none";
      return new Response(`Set DASH_PASSWORD and SESSION_SECRET secrets.\nSettings this Worker can see: ${seen}`, { status: 500, headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/login") {
      if (req.method !== "POST") return loginPage();
      const pw = String((await req.formData()).get("password") || "");
      const ok = safeEqual(await hmac(env.SESSION_SECRET, pw), await hmac(env.SESSION_SECRET, env.DASH_PASSWORD));
      if (!ok) return loginPage("Wrong password");
      return new Response(null, { status: 303, headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${await makeSession(env)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
      } });
    }

    if (!(await validSession(req, env))) {
      return url.pathname.startsWith("/api/") ? json({ error: "login required" }, 401) : Response.redirect(`${url.origin}/login`, 302);
    }

    if (url.pathname === "/api/data") {
      const { cals, errors } = getCalendars(env);
      const td = await getTasks(env);
      return json({
        calendars: cals.map((c, i) => ({ id: i, name: c.name || `Calendar ${i + 1}`, color: c.color || "blue" })),
        tasks: td.tasks, errors: [...errors, ...td.errors],
        place: { name: env.PLACE, lat: +env.LAT, lon: +env.LON }, home: await homeSpot(env, ctx), generated: new Date().toISOString(),
      });
    }
    const c = url.pathname.match(/^\/api\/cal\/(\d+)$/);
    if (c) return proxyCalendar(env, +c[1]);
    const m = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(close|reopen)$/);
    if (m && req.method === "POST") return setTask(env, m[1], m[2]);
    const sz = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/snooze$/);
    if (sz && req.method === "POST") return snoozeTask(env, sz[1]);
    if (url.pathname === "/api/workzones") return workZones(env, ctx);
    if (url.pathname === "/api/cds") {
      if (!env.STORE) return json(null);
      return env.STORE.get(env.STORE.idFromName("main")).fetch(req);
    }

    const assets = rawEnv.ASSETS || env.ASSETS;
    if (!assets) return new Response("Dashboard files are missing from this deploy. In Cloudflare, retry the latest build.", { status: 503, headers: { "cache-control": "no-store" } });
    return assets.fetch(req);
  }
}

