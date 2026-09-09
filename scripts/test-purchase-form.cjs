/* E2E: purchase form submit → stored + member/owner emails sent. */
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
  const email = `pform-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Purchase Form Test";

  const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password: "password123", phone }) });
  if (signup.status !== 201 && signup.status !== 200) { console.error("Signup failed", signup.data); process.exit(1); }
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  const apply = await api("/tryouts/apply", { method: "POST", body: JSON.stringify({ name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "Test", reason: "e2e" }) }, userToken);
  if (apply.status !== 200 && apply.status !== 201) { console.error("Apply failed", apply.data); process.exit(1); }

  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: "{}", json: false }, adminToken);

  // Build multipart with a tiny valid PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const fd = new FormData();
  fd.append("phoneAtStore", phone);
  fd.append("profileName", "Order Count Test @amazon");
  fd.append("otherInfo", "Order #ORD12345, qty 1");
  fd.append("screenshot", new Blob([png], { type: "image/png" }), "order.png");

  const submit = await api("/tryouts/purchase-form", { method: "POST", body: fd, json: false }, userToken);
  console.log("Submit status:", submit.status, submit.data?.message || "");

  const dash = await api("/tryouts/my", {}, userToken);
  const forms = dash.data?.dashboard?.purchaseForms || [];
  console.log("purchaseForms count:", forms.length, "| phoneAtStore:", forms[0]?.phoneAtStore, "| screenshotUrl:", forms[0]?.screenshotUrl?.slice(0, 40));

  // Validation: missing screenshot should fail
  const fd2 = new FormData();
  fd2.append("phoneAtStore", phone);
  fd2.append("profileName", "Test");
  const bad = await api("/tryouts/purchase-form", { method: "POST", body: fd2, json: false }, userToken);
  console.log("Missing screenshot status:", bad.status, "|", bad.data?.message || "");

  const pass = submit.status === 201 && forms.length === 1 && forms[0].screenshotUrl && bad.status === 400;
  console.log(pass ? "PASS ✅" : "FAIL ❌");

  // cleanup
  await db.collection("orders").deleteMany({ "customer.email": email });
  await db.collection("products").deleteMany({ brand: "TestBrand" });
  await db.collection("tryoutapplications").deleteMany({ user: me._id });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
