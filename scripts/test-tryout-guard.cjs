/* Negative: non-approved user must NOT be able to create a payment session with a tryout product. */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BASE = "http://localhost:5000/api";
const SECRET = process.env.JWT_SECRET;
const uniq = Date.now().toString().slice(-7);

async function api(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const email = `tryguard-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;

  const signup = await api("/auth/signup", { method: "POST", body: { name: "Guard Test", email, password: "password123", phone } });
  if (signup.status !== 201 && signup.status !== 200) { console.error("Signup failed", signup.data); process.exit(1); }
  const userToken = signup.data.token;

  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });
  const tryout = await api("/products", { method: "POST", body: { title: `Guard Tryout ${uniq}`, brand: "TestBrand", category: "Test", price: 30, mrp: 99, stock: 100, description: "tryout", image: "", images: [], tryoutOnly: true } }, adminToken);
  const tryoutId = tryout.data.product?._id || tryout.data._id;

  const customer = { name: "Guard Test", email, phone, state: "Uttar Pradesh", city: "Kanpur", address: "Test Street 12", pincode: "208001" };

  // Direct order path (should FAIL — not approved)
  const direct = await api("/orders", { method: "POST", body: { customer, items: [{ productId: tryoutId, quantity: 1 }], paymentMethod: "cod" } }, userToken);
  console.log("Direct /api/orders with tryout (non-approved):", direct.status, direct.data?.message || "");

  // Payment session path (should also FAIL — new guard)
  const session = await api("/payments/razorpay/create-order", { method: "POST", body: { customer, items: [{ productId: tryoutId, quantity: 1 }], paymentMethod: "cod" } }, userToken);
  console.log("Payment session with tryout (non-approved):", session.status, session.data?.message || "");

  const pass = direct.status === 400 && session.status === 400;
  console.log(pass ? "PASS ✅ — both paths blocked for non-approved user" : "FAIL ❌");

  await db.collection("products").deleteMany({ _id: new mongoose.Types.ObjectId(tryoutId) });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
