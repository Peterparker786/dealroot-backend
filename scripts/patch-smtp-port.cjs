/* Switches the Gmail transporter from nodemailer's implicit service config
   (which uses smtp.gmail.com:465 SSL) to an explicit smtp.gmail.com:587
   STARTTLS setup with bounded connection timeouts. Port 587/TLS is
   generally more reliably reachable from cloud hosts (e.g. Render
   Singapore) than 465. */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "src", "server.js");
let src = fs.readFileSync(file, "utf8");

const oldBlock = `const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});`;

const newBlock = `const transporter = nodemailer.createTransport({
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

if (src.includes(newBlock)) {
  console.log("SKIP: already patched");
} else if (!src.includes(oldBlock)) {
  console.error("SKIP: could not find the transporter block to replace");
  process.exit(1);
} else {
  src = src.replace(oldBlock, newBlock);
  fs.writeFileSync(file, src);
  console.log("OK: transporter now uses smtp.gmail.com:587 STARTTLS with timeouts");
}
