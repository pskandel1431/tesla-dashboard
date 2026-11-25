// Deploy the Worker, then push runtime secrets from build variables.
// Cloudflare Workers Builds passes Build "Variables and secrets" as env vars here.
import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

execSync("npx wrangler deploy", { stdio: "inherit" });

const NAMES = ["DASH_PASSWORD", "SESSION_SECRET", "CALENDARS", "TODOIST_TOKEN", "MASSDOT_WZ_KEY", "HOME_ADDRESS"];
const secrets = Object.fromEntries(NAMES.filter(n => process.env[n]?.trim()).map(n => [n, process.env[n].trim()]));
if (!Object.keys(secrets).length) {
  console.log("No secret build variables set; skipping secret upload.");
} else {
  const file = ".secrets.tmp.json";
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    execSync(`npx wrangler secret bulk ${file}`, { stdio: "inherit" });
    console.log(`Uploaded secrets: ${Object.keys(secrets).join(", ")}`);
  } finally {
    rmSync(file, { force: true });
  }
}
