/* E2E: refund form submit (delivery screenshot + review files) → stored + admin verify. */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BASE = "http://localhost:5000/api";
const SECRET = process.env.JWT_SECRET;
const uniq = Date.now().toString().slice(-7);

async function api(path, opts = {}, token) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== false) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const email = `rform-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Refund Form Test";

  const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password: "password123", phone }) });
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  await api("/tryouts/apply", { method: "POST", body: JSON.stringify({ name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "T", reason: "e2e" }) }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: "{}", json: false }, adminToken);

  // Submit refund form: delivery screenshot + 2 review files
  const fd = new FormData();
  fd.append("orderId", "ORD77777");
  fd.append("orderAmount", "249");
  fd.append("otherInfo", "Live review link: https://youtu.be/test");
  fd.append("deliveryScreenshot", new Blob([PNG], { type: "image/png" }), "delivery.png");
  fd.append("reviewFiles", new Blob([PNG], { type: "image/png" }), "review1.png");
  fd.append("reviewFiles", new Blob([PNG], { type: "image/png" }), "review2.png");
  const submit = await api("/tryouts/refund-form", { method: "POST", body: fd, json: false }, userToken);
  console.log("Submit:", submit.status, submit.data?.message || "");

  // Validation: missing delivery screenshot
  const fd2 = new FormData();
  fd2.append("orderId", "ORD88888");
  const bad = await api("/tryouts/refund-form", { method: "POST", body: fd2, json: false }, userToken);
  console.log("Missing delivery screenshot:", bad.status, "|", bad.data?.message || "");

  // Validation: missing order amount
  const fd3 = new FormData();
  fd3.append("orderId", "ORD99999");
  fd3.append("deliveryScreenshot", new Blob([PNG], { type: "image/png" }), "d.png");
  fd3.append("reviewFiles", new Blob([PNG], { type: "image/png" }), "r.png");
  const badAmount = await api("/tryouts/refund-form", { method: "POST", body: fd3, json: false }, userToken);
  console.log("Missing order amount:", badAmount.status, "|", badAmount.data?.message || "");

  // Admin list + verify
  const list = await api("/tryouts/applications", {}, adminToken);
  const latest = list.data.applications.find((a) => a._id === String(app._id));
  const form = (latest?.refundForms || []).slice(-1)[0];
  console.log("Admin sees refund form:", !!form, "| status:", form?.status, "| deliveryShot:", !!form?.deliveryScreenshotUrl, "| reviewFiles:", form?.reviewFiles?.length, "| orderAmount:", form?.orderAmount);

  const verify = await api(`/tryouts/${app._id}/refund-form/${form._id}`, { method: "PATCH", body: JSON.stringify({ status: "verified" }) }, adminToken);
  console.log("Verify:", verify.status, verify.data?.message || "");

  const finalApp = await db.collection("tryoutapplications").findOne({ _id: app._id });
  console.log("Final status:", finalApp.refundForms.slice(-1)[0].status);

  const pass = submit.status === 201 && bad.status === 400 && badAmount.status === 400 && form && form.deliveryScreenshotUrl && form.reviewFiles.length === 2 && form.orderAmount === 249 && verify.status === 200;
  console.log(pass ? "PASS ✅" : "FAIL ❌");

  await db.collection("tryoutapplications").deleteMany({ user: me._id });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
