require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BASE = "http://localhost:5000/api";
const SECRET = process.env.JWT_SECRET;
const uniq = Date.now().toString().slice(-7);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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
  const email = `resp-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Riya Sharma";

  const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password: "password123", phone }) });
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "8h" });

  await api("/tryouts/apply", { method: "POST", body: JSON.stringify({ name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "T", reason: "test" }) }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: "{}", json: false }, adminToken);

  // Purchase form
  const fd1 = new FormData();
  fd1.append("phoneAtStore", phone);
  fd1.append("profileName", "riya.sharma09");
  fd1.append("otherInfo", "Order ORD11111");
  fd1.append("screenshot", new Blob([PNG], { type: "image/png" }), "p.png");
  await api("/tryouts/purchase-form", { method: "POST", body: fd1, json: false }, userToken);

  // Refund form
  const fd2 = new FormData();
  fd2.append("orderId", "ORD22222");
  fd2.append("otherInfo", "Live review: youtu.be/x");
  fd2.append("deliveryScreenshot", new Blob([PNG], { type: "image/png" }), "d.png");
  fd2.append("reviewFiles", new Blob([PNG], { type: "image/png" }), "r1.png");
  await api("/tryouts/refund-form", { method: "POST", body: fd2, json: false }, userToken);

  console.log("TOKEN=" + userToken);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
