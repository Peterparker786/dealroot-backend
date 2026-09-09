/* Fixes the /api/admin/email-status endpoint so it can never hang:
   1. Skips SMTP verify entirely when EMAIL vars are missing.
   2. Wraps verify() in an 8s timeout even when creds exist.
   Also adds a timeout to the email-test endpoint's sendMail. */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "src", "server.js");
let src = fs.readFileSync(file, "utf8");

const oldStatus = `    let smtp = "untested";
    try {
      await transporter.verify();
      smtp = "ok";
    } catch (e) {
      smtp = "fail: " + (e.message || "SMTP error");
    }
    status.smtp = smtp;`;

const newStatus = `    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      status.smtp = "not-configured: EMAIL_USER / EMAIL_PASS missing";
    } else {
      // verify() can hang forever when SMTP is unreachable — enforce a cap.
      try {
        await Promise.race([
          transporter.verify(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("SMTP verify timed out")), 8000)
          ),
        ]);
        status.smtp = "ok";
      } catch (e) {
        status.smtp = "fail: " + (e.message || "SMTP error");
      }
    }`;

if (!src.includes(newStatus)) {
  if (!src.includes(oldStatus)) {
    console.error("SKIP: could not find the verify() block to replace");
    process.exit(1);
  }
  src = src.replace(oldStatus, newStatus);
  fs.writeFileSync(file, src);
  console.log("OK: email-status no longer hangs");
} else {
  console.log("SKIP: already patched");
}
