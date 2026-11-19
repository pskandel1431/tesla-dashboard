# tesla-dashboard

Personal dashboard for the Tesla in-car browser: next-appointment countdown, today/tomorrow calendar with tap-to-Maps, Todoist priorities and to-dos, weather, sunrise/sunset, custom countdowns.

Runs as one Cloudflare Worker (free tier). The Worker serves the page behind a password, fetches Google Calendar (private iCal links) and Todoist server-side, and never stores calendar data in this repo. Weather comes from Open-Meteo (no key).

## Setup (one time)

1. **Reset your iCal links.** Google Calendar → Settings → each calendar → *Integrate calendar* → *Reset* next to "Secret address in iCal format". Copy the new links. (The old ones were public in this repo's history.)
2. **Todoist token.** Todoist → Settings → Integrations → Developer → copy API token.
3. **Deploy.** Cloudflare dashboard → Workers & Pages → Create → *Import a repository* → pick `tesla-dashboard`, branch `main`. Leave build command empty; deploy command `npx wrangler deploy`.
4. **Secrets.** In the Worker → Settings → Variables and Secrets, add these as type *Secret*:
   - `DASH_PASSWORD`: what you'll type in the car
   - `SESSION_SECRET`: any long random string (e.g. 40+ characters)
   - `TODOIST_TOKEN`: from step 2
   - `CALENDARS`: JSON list, e.g.
     ```json
     [{"name":"Personal","url":"https://calendar.google.com/calendar/ical/.../basic.ics","color":"blue"},
      {"name":"Family","url":"...","color":"green"},
      {"name":"Kenyon","url":"...","color":"orange"}]
     ```
     Colors: `blue`, `green`, `orange`, `red`.
5. Open `https://tesla-dashboard.<your-subdomain>.workers.dev` in the car, log in once. The login lasts a year.

Location for weather/sun is set in `wrangler.toml` (`LAT`, `LON`, `PLACE`).

## Local dev

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # http://localhost:8787
```

## Notes

- Tapping a to-do completes it in Todoist (tap again to undo). P1 tasks show under High priority; the to-do list shows P2 plus anything due within 7 days.
- Custom countdowns are saved in the car browser's local storage.
- The browser can open Google Maps, but can't send a destination to the car's built-in navigation.
