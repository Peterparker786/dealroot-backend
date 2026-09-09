/* Adds admin-only email diagnostic endpoints to src/server.js */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "src", "server.js");
let src = fs.readFileSync(file, "utf8");

const marker = 'app.post("/api/auth/signup", customerAuthLimiter, async (req, res) => {';

if (!src.includes('app.get("/api/admin/email-status"')) {
  const block = `
// Admin-only email diagnostics — report SMTP config health WITHOUT exposing secrets.
app.get("/api/admin/email-status", requireAdmin, async (req, res) => {
  try {
    const status = {
      emailUserSet: Boolean(process.env.EMAIL_USER),
      emailPassSet: Boolean(process.env.EMAIL_PASS),
      adminEmailSet: Boolean(process.env.ADMIN_EMAIL),
      dryRun: process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true",
      from: process.env.EMAIL_USER ? String(process.env.EMAIL_USER).replace(/./g, (c, i) => (i < 3 ? c : "*")) : null,
    };

    let smtp = "untested";
    try {
      await transporter.verify();
      smtp = "ok";
    } catch (e) {
      smtp = "fail: " + (e.message || "SMTP error");
    }
    status.smtp = smtp;

    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ success: false, message: "Could not check email status" });
  }
});

// Admin-only: send a test email to the configured ADMIN_EMAIL so the owner can
// verify the SMTP credentials work from the deployed server.
app.post("/api/admin/email-test", requireAdmin, async (req, res) => {
  try {
    const to = String(process.env.ADMIN_EMAIL || process.env.EMAIL_USER || "").trim();
    if (!to) {
      return res.status(400).json({ success: false, message: "No ADMIN_EMAIL configured on this server" });
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(400).json({
        success: false,
        message: "EMAIL_USER / EMAIL_PASS are not set on this server — add them to the deployment env and redeploy.",
      });
    }

    const info = await transporter.sendMail({
      from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
      to,
      subject: "DEALROOT test email ✅",
      html:
        '<div style="font-family:Arial;padding:30px;text-align:center">' +
        '<h1 style="color:#e21c48">DEALROOT BEAUTY</h1>' +
        "<p>If you can read this, order confirmation emails are working correctly.</p>" +
        '<p style="color:#999;font-size:12px">Sent from the deployed server at ' +
        new Date().toLocaleString("en-IN") +
        "</p></div>",
    });

    res.json({
      success: true,
      message: "Test email sent to " + to + " (message id: " + info.messageId + ")",
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: "Email failed: " + (e.message || "unknown error"),
    });
  }
});

`;

  src = src.replace(marker, block + marker);
  fs.writeFileSync(file, src);
  console.log("OK: email-status + email-test endpoints added");
} else {
  console.log("SKIP: already present");
}
