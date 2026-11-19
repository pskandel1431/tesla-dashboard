import ICAL from "ical.js";

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
function expandIcs(text, from, to, cal) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch {}
  }
  const masters = new Map(), exceptions = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev); else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const out = [];
  const push = (item, s, e) => {
    if ((item.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") return;
    const start = s.toJSDate(), end = (e || s).toJSDate();
    if (end <= from || start >= to) return;
    const allDay = s.isDate; // all-day: send plain dates so the car shows them on the right local day
    out.push({
      title: item.summary || "(No title)",
      start: allDay ? s.toString() : start.toISOString(),
      end: allDay ? (e || s).toString() : end.toISOString(), allDay,
      location: item.location || "", notes: (item.description || "").slice(0, 600),
      cal: cal.name, color: cal.color || "blue",
    });
  };
  for (const ev of masters.values()) {
    if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate); continue; }
    const it = ev.iterator();
    let next, guard = 0;
    while ((next = it.next()) && guard++ < 20000) {
      const jd = next.toJSDate();
      if (jd >= to) break;
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

async function getEvents(env) {
  let cals;
  try {
    // Accept phone-typed curly quotes too.
    cals = JSON.parse((env.CALENDARS || "[]").replace(/[\u201C\u201D\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'"));
    if (!Array.isArray(cals)) cals = [cals];
  } catch (e) {
    return { events: [], errors: [`CALENDARS isn't valid JSON (${e.message})`] };
  }
  const from = new Date(Date.now() - 36 * 36e5), to = new Date(Date.now() + 4 * 864e5);
  const results = await Promise.all(cals.map(async cal => {
    try {
      const r = await fetch(cal.url, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { events: expandIcs(await r.text(), from, to, cal) };
    } catch (e) { return { events: [], error: `${cal.name}: ${e.message}` }; }
  }));
  return {
    events: results.flatMap(r => r.events).sort((a, b) => a.start.localeCompare(b.start)),
    errors: results.filter(r => r.error).map(r => r.error),
  };
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

// ---------- router ----------
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Tolerate stray spaces in secret names typed on a phone ("DASH_PASSWORD ").
function cleanEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(env)) {
    const t = k.trim();
    if (t !== k && !(t in out)) out[t] = env[k];
  }
  for (const k of ["DASH_PASSWORD", "SESSION_SECRET", "CALENDARS", "TODOIST_TOKEN"]) {
    if (typeof out[k] === "string") out[k] = out[k].trim();
  }
  return out;
}

export default {
  async fetch(req, rawEnv) {
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
      let cal, td;
      try {
        [cal, td] = await Promise.all([getEvents(env), getTasks(env)]);
      } catch (e) {
        return json({ error: `Server error: ${e.message}` }, 500);
      }
      return json({
        events: cal.events, tasks: td.tasks, errors: [...cal.errors, ...td.errors],
        place: { name: env.PLACE, lat: +env.LAT, lon: +env.LON }, generated: new Date().toISOString(),
      });
    }
    const m = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(close|reopen)$/);
    if (m && req.method === "POST") return setTask(env, m[1], m[2]);

    return env.ASSETS.fetch(req);
  },
};

export { expandIcs }; // for local tests
