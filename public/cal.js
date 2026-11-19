// Calendar expansion runs in the browser: Cloudflare's free plan allows ~10 ms
// CPU per request, and Google feeds hold years of history.
import ICAL from "./vendor/ical.min.js";

// Cheap text pre-filter: Google feeds hold years of history. Keep timezones,
// recurring events (and their exceptions), and one-off events near the window.
export function prefilter(text, from, to) {
  const lo = ymd(new Date(from.getTime() - 2 * 864e5)), hi = ymd(new Date(to.getTime() + 2 * 864e5));
  const parts = text.split("BEGIN:VEVENT");
  const keep = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const isRecurring = p.includes("\nRRULE:") || p.includes("\nRECURRENCE-ID");
    if (isRecurring) {
      const until = /\nRRULE:[^\n]*UNTIL=(\d{8})/.exec(p);
      if (until && until[1] < lo) continue;
      keep.push(p); continue;
    }
    const ds = /\nDTSTART[^:\n]*:(\d{8})/.exec(p), de = /\nDTEND[^:\n]*:(\d{8})/.exec(p);
    if (!ds) continue;
    const s = ds[1], e = de ? de[1] : s;
    if (e >= lo && s <= hi) keep.push(p);
  }
  const out = keep.join("BEGIN:VEVENT");
  return out.includes("END:VCALENDAR") ? out : out + "\r\nEND:VCALENDAR\r\n";
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

export function expandIcs(text, from, to, cal) {
  const root = new ICAL.Component(ICAL.parse(prefilter(text, from, to)));
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
    const it = ev.iterator(fastForward(ev, from));
    let next, guard = 0;
    while ((next = it.next()) && guard++ < 20000) {
      const jd = next.toJSDate();
      if (jd >= to) break;
      if (jd.getTime() < from.getTime() - 3 * 864e5) continue; // far before window: skip costly details
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

// Jump a DAILY/WEEKLY rule's start forward by whole periods so we don't iterate
// years of history. Whole periods keep the weekday and time, so results match.
function fastForward(ev, from) {
  const rule = ev.component.getFirstPropertyValue("rrule");
  if (!rule || rule.count || !["DAILY", "WEEKLY"].includes(rule.freq)) return undefined;
  const periodDays = (rule.interval || 1) * 7; // a multiple of 7 is safe for both, even with BYDAY
  const start = ev.startDate;
  const gapDays = (from.getTime() - 8 * 864e5 - start.toJSDate().getTime()) / 864e5;
  const k = Math.floor(gapDays / periodDays);
  if (k <= 0) return undefined;
  const t = start.clone();
  t.adjust(k * periodDays, 0, 0, 0);
  return t;
}

