/* E2E: purchase form → admin sees it → verify + add cashback → both update. */
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

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const email = `verify-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Verify Test";

  const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password: "password123", phone }) });
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  await api("/tryouts/apply", { method: "POST", body: JSON.stringify({ name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "T", reason: "e2e" }) }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: "{}", json: false }, adminToken);

  // Member submits purchase form with screenshot
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("phoneAtStore", phone);
  fd.append("profileName", "VerifyUser");
  fd.append("otherInfo", "Order 123");
  fd.append("screenshot", new Blob([png], { type: "image/png" }), "o.png");
  const submit = await api("/tryouts/purchase-form", { method: "POST", body: fd, json: false }, userToken);
  if (submit.status !== 201) { console.error("Submit failed", submit.data); process.exit(1); }

  // Admin list — should include the purchase form
  const list = await api("/tryouts/applications", {}, adminToken);
  const latest = list.data.applications.find((a) => a._id === String(app._id));
  const form = (latest?.purchaseForms || []).slice(-1)[0];
  console.log("Admin sees purchase form:", !!form, "| status:", form?.status, "| screenshot:", !!form?.screenshotUrl);

  // Admin verifies the form + adds cashback
  const verify = await api(`/tryouts/${app._id}/purchase-form/${form._id}`, { method: "PATCH", body: JSON.stringify({ status: "verified" }) }, adminToken);
  console.log("Verify:", verify.status, verify.data?.message || "");
  const cb = await api(`/tryouts/${app._id}/cashback`, { method: "POST", body: JSON.stringify({ amount: 150, note: "Verified purchase" }) }, adminToken);
  console.log("Cashback add:", cb.status, "| available:", cb.data?.application?.cashbackAvailable);

  // Final state check
  const finalApp = await db.collection("tryoutapplications").findOne({ _id: app._id });
  const finalForm = finalApp.purchaseForms.slice(-1)[0];
  console.log("Final form status:", finalForm.status, "| cashbackAvailable:", finalApp.cashbackAvailable);

  const pass = form && verify.status === 200 && cb.status === 200 && finalForm.status === "verified" && finalApp.cashbackAvailable === 150;
  console.log(pass ? "PASS ✅" : "FAIL ❌");

  await db.collection("tryoutapplications").deleteMany({ user: me._id });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
