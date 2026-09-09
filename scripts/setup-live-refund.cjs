require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BASE = "http://localhost:5000/api";
const SECRET = process.env.JWT_SECRET;
const uniq = Date.now().toString().slice(-7);

async function api(path, opts = {}, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const email = `refundlive-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Riya Sharma";

  const signup = await api("/auth/signup", { method: "POST", body: { name, email, password: "password123", phone } });
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "8h" });

  await api("/tryouts/apply", { method: "POST", body: { name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "T", reason: "test" } }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: {}, json: false }, adminToken);

  console.log("TOKEN=" + userToken);
  console.log("EMAIL=" + email);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
