// Patch: Render free tier blocks SMTP ports (25/465/587) — switch production
// email sending to the Brevo HTTPS API (port 443) when BREVO_API_KEY is set.
// Local dev keeps using Gmail SMTP via nodemailer.
const fs = require("fs");
const f = "src/server.js";
let s = fs.readFileSync(f, "utf8");

// ---- 1. Replace the transporter definition ----
const oldTransporter = `const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // STARTTLS on port 587 (more cloud-friendly than 465)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
});`;

const newTransporter = `// Email transport — Render free tier blocks outbound SMTP ports (25/465/587),
// so production uses the Brevo HTTPS API (port 443) when BREVO_API_KEY is set.
// Local development falls back to Gmail SMTP via nodemailer.
const smtpTransporter =
  process.env.EMAIL_USER && process.env.EMAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false, // STARTTLS on port 587 (more cloud-friendly than 465)
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
      })
    : null;

async function brevoSendMail({ from, to, subject, html }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error("BREVO_API_KEY is not set");
  const https = require("https");
  const body = JSON.stringify({
    sender: {
      email: process.env.EMAIL_USER || "dealroot.store@gmail.com",
      name: "DEALROOT Beauty",
    },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          "api-key": key,
          "content-type": "application/json",
          accept: "application/json",
        },
        timeout: 20000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let msgId = "brevo:" + Date.now();
            try {
              msgId = JSON.parse(d).messageId || msgId;
            } catch (_) {}
            resolve({ messageId: msgId });
          } else {
            reject(
              new Error("Brevo API HTTP " + res.statusCode + ": " + d.slice(0, 300))
            );
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Brevo API timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function brevoVerify() {
  const key = process.env.BREVO_API_KEY;
  if (!key) return Promise.reject(new Error("BREVO_API_KEY is not set"));
  const https = require("https");
  return new Promise((resolve, reject) => {
    https
      .get(
        "https://api.brevo.com/v3/account",
        {
          headers: { "api-key": key, accept: "application/json" },
          timeout: 15000,
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (res.statusCode === 200) resolve(true);
            else
              reject(
                new Error(
                  "Brevo API key rejected (HTTP " + res.statusCode + ")"
                )
              );
          });
        }
      )
      .on("error", reject);
  });
}

// Provider-aware transport: same sendMail/verify interface used everywhere.
const transporter = {
  async sendMail(opts) {
    if (process.env.BREVO_API_KEY) return brevoSendMail(opts);
    if (!smtpTransporter)
      throw new Error(
        "No email transport configured (set BREVO_API_KEY or EMAIL_USER/EMAIL_PASS)"
      );
    return smtpTransporter.sendMail(opts);
  },
  async verify() {
    if (process.env.BREVO_API_KEY) return brevoVerify();
    if (!smtpTransporter)
      throw new Error("EMAIL_USER / EMAIL_PASS missing");
    return smtpTransporter.verify();
  },
};`;

if (!s.includes(oldTransporter)) {
  console.error("FAIL: transporter block not found");
  process.exit(1);
}
s = s.replace(oldTransporter, newTransporter);

// ---- 2. email-status: account for Brevo mode ----
const oldStatus = `    const status = {
      emailUserSet: Boolean(process.env.EMAIL_USER),
      emailPassSet: Boolean(process.env.EMAIL_PASS),
      adminEmailSet: Boolean(process.env.ADMIN_EMAIL),
      dryRun: process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true",
      from: process.env.EMAIL_USER ? String(process.env.EMAIL_USER).replace(/./g, (c, i) => (i < 3 ? c : "*")) : null,
    };

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      status.smtp = "not-configured: EMAIL_USER / EMAIL_PASS missing";
    } else {`;

const newStatus = `    const brevoMode = Boolean(process.env.BREVO_API_KEY);
    const status = {
      transport: brevoMode ? "brevo-api" : "gmail-smtp",
      emailUserSet: Boolean(process.env.EMAIL_USER),
      emailPassSet: Boolean(process.env.EMAIL_PASS),
      brevoKeySet: brevoMode,
      adminEmailSet: Boolean(process.env.ADMIN_EMAIL),
      dryRun: process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true",
      from: process.env.EMAIL_USER ? String(process.env.EMAIL_USER).replace(/./g, (c, i) => (i < 3 ? c : "*")) : null,
    };

    if (!process.env.EMAIL_USER) {
      status.smtp = "not-configured: EMAIL_USER missing";
    } else if (!brevoMode && !process.env.EMAIL_PASS) {
      status.smtp = "not-configured: EMAIL_PASS missing (set BREVO_API_KEY for production or EMAIL_PASS locally)";
    } else {`;

if (!s.includes(oldStatus)) {
  console.error("FAIL: email-status block not found");
  process.exit(1);
}
s = s.replace(oldStatus, newStatus);

// ---- 3. email-test: allow Brevo mode ----
const oldTest = `    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(400).json({
        success: false,
        message: "EMAIL_USER / EMAIL_PASS are not set on this server — add them to the deployment env and redeploy.",
      });
    }`;

const newTest = `    if (!process.env.EMAIL_USER || (!process.env.BREVO_API_KEY && !process.env.EMAIL_PASS)) {
      return res.status(400).json({
        success: false,
        message:
          "Email is not configured on this server — set EMAIL_USER + BREVO_API_KEY (production) or EMAIL_USER + EMAIL_PASS (local).",
      });
    }`;

if (!s.includes(oldTest)) {
  console.error("FAIL: email-test guard block not found");
  process.exit(1);
}
s = s.replace(oldTest, newTest);

fs.writeFileSync(f, s);
console.log("PATCHED: Brevo HTTPS transport + status/test updated");
