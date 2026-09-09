/* Reads EMAIL_USER + EMAIL_PASS from the local .env and pushes them to the
   Render service env vars via the Render API, then redeploys the service.
   Secrets are never printed to stdout. */
const fs = require("fs");
const path = require("path");

const RENDER_API = "https://api.render.com/v1";
const RENDER_KEY = "rnd_BPIihZvjMzdjETJnIdPRGW9FylOt";
const SERVICE_ID = "srv-d9fh2p7avr4c73c7vqh0";

function loadEnv(file) {
  const out = {};
  const txt = fs.readFileSync(file, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

async function api(method, url, body) {
  const res = await fetch(RENDER_API + url, {
    method,
    headers: {
      Authorization: "Bearer " + RENDER_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  const env = loadEnv(path.join(__dirname, "..", ".env"));
  const user = (env.EMAIL_USER || "").trim();
  const pass = (env.EMAIL_PASS || "").trim();

  if (!user || !pass) {
    console.log("FAIL: local .env missing EMAIL_USER or EMAIL_PASS");
    process.exit(1);
  }
  console.log("EMAIL_USER present:", user.length + " chars");
  console.log("EMAIL_PASS present:", pass.length + " chars (never printed)");

  // 1. Read current env vars (to keep everything else intact)
  const cur = await api("GET", "/services/" + SERVICE_ID + "/env-vars");
  const keep = [];
  if (Array.isArray(cur.data)) {
    for (const item of cur.data) {
      const ev = item.envVar || item;
      if (ev.key === "EMAIL_USER" || ev.key === "EMAIL_PASS") continue;
      keep.push({ key: ev.key, value: ev.value });
    }
  }
  console.log("Existing env vars to preserve:", keep.length);

  // 2. Replace ALL env vars (Render PUT replaces the whole set)
  const envVars = [
    ...keep,
    { key: "EMAIL_USER", value: user },
    { key: "EMAIL_PASS", value: pass },
  ];
  const put = await api("PUT", "/services/" + SERVICE_ID + "/env-vars", { envVars });
  console.log("PUT env-vars:", put.status === 200 ? "OK" : put.status + " " + JSON.stringify(put.data).slice(0, 200));

  // 3. Redeploy so the new vars take effect
  const dep = await api("POST", "/services/" + SERVICE_ID + "/deploys", {});
  console.log("Deploy triggered:", dep.status === 201 || dep.status === 200 ? "YES" : dep.status + " " + JSON.stringify(dep.data).slice(0, 200));
  if (dep.data && dep.data.id) console.log("Deploy id:", dep.data.id);
})().catch((e) => {
  console.log("ERROR:", e.message);
  process.exit(1);
});
