/* Adds /api/admin/net-test — admin-only endpoint that runs raw TCP
   connections to smtp.gmail.com on 465/587 and to google.com:443 so we
   can see exactly where Render's outbound connectivity fails. */
const fs = require("fs");
const path = require("path");
const net = require("net");

const file = path.join(__dirname, "..", "src", "server.js");
let src = fs.readFileSync(file, "utf8");

const marker = 'app.get("/api/admin/email-status", requireAdmin, async (req, res) => {';

if (!src.includes('app.get("/api/admin/net-test"')) {
  const block = `
// Admin-only: raw TCP reachability probe from this server. Helps diagnose
// why SMTP connections hang on some cloud hosts (e.g. Render Singapore).
app.get("/api/admin/net-test", requireAdmin, async (req, res) => {
  const probe = (host, port, timeoutMs) =>
    new Promise((resolve) => {
      const sock = new net.Socket();
      const done = (result) => {
        sock.destroy();
        resolve(result);
      };
      sock.setTimeout(timeoutMs || 5000);
      sock.once("connect", () => done({ host, port, ok: true, ms: 0 }));
      sock.once("timeout", () => done({ host, port, ok: false, error: "timeout" }));
      sock.once("error", (e) => done({ host, port, ok: false, error: e.code || e.message }));
      sock.connect(port, host);
    });

  (async () => {
    const results = await Promise.all([
      probe("smtp.gmail.com", 465),
      probe("smtp.gmail.com", 587),
      probe("smtp-relay.gmail.com", 465),
      probe("smtp-relay.gmail.com", 587),
      probe("google.com", 443),
    ]);
    res.json({ success: true, results });
  })();
});

`;

  src = src.replace(marker, block + marker);
  fs.writeFileSync(file, src);
  console.log("OK: net-test endpoint added");
} else {
  console.log("SKIP: already present");
}
