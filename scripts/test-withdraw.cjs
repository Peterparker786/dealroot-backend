/* E2E: member requests withdrawal → available→pending, admin marks paid/rejected. */
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
  const email = `with-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Withdraw Test";

  const signup = await api("/auth/signup", { method: "POST", body: { name, email, password: "password123", phone } });
  const userToken = signup.data.token;
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  await api("/tryouts/apply", { method: "POST", body: { name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "T", reason: "e2e" } }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST", body: {}, json: false }, adminToken);

  // Add cashback ₹500 first
  const cb = await api(`/tryouts/${app._id}/cashback`, { method: "POST", body: { amount: 500, note: "Purchase" } }, adminToken);
  console.log("Available after cashback:", cb.data?.application?.cashbackAvailable);

  // Withdraw ₹200 to UPI
  const wd = await api("/tryouts/withdraw", { method: "POST", body: { amount: 200, upiId: "harsh@upi" } }, userToken);
  console.log("Withdraw:", wd.status, wd.data?.message || "");
  console.log("Available:", wd.data?.application?.cashbackAvailable, "| Pending:", wd.data?.application?.cashbackPending);

  // Over-withdrawal should fail
  const over = await api("/tryouts/withdraw", { method: "POST", body: { amount: 99999, upiId: "harsh@upi" } }, userToken);
  console.log("Over-withdraw:", over.status, "|", over.data?.message || "");

  // Missing UPI should fail
  const noUpi = await api("/tryouts/withdraw", { method: "POST", body: { amount: 50 } }, userToken);
  console.log("No UPI:", noUpi.status, "|", noUpi.data?.message || "");

  // Admin marks paid
  const fresh = await db.collection("tryoutapplications").findOne({ _id: app._id });
  const entry = fresh.withdrawals.slice(-1)[0];
  const paid = await api(`/tryouts/withdraw/${entry._id}`, { method: "PATCH", body: { status: "paid" } }, adminToken);
  console.log("Mark paid:", paid.status, "| Available:", paid.data?.application?.cashbackAvailable, "| Pending:", paid.data?.application?.cashbackPending);

  const final = await db.collection("tryoutapplications").findOne({ _id: app._id });
  console.log("Final withdrawal status:", final.withdrawals.slice(-1)[0].status);

  const pass = wd.status === 201 && cb.data.application.cashbackAvailable === 500 && wd.data.application.cashbackAvailable === 300 && wd.data.application.cashbackPending === 200 && over.status === 400 && noUpi.status === 400 && paid.status === 200 && final.withdrawals.slice(-1)[0].status === "paid";
  console.log(pass ? "PASS ✅" : "FAIL ❌");

  await db.collection("tryoutapplications").deleteMany({ user: me._id });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
