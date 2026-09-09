/* Sets up a live user: 1 normal order + 1 tryout order, returns login token. */
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
  const email = `ordcount-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;
  const name = "Order Count Test";

  // signup
  const signup = await api("/auth/signup", { method: "POST", body: { name, email, password: "password123", phone } });
  if (signup.status !== 201 && signup.status !== 200) { console.error("Signup failed", signup.data); process.exit(1); }
  const userToken = signup.data.token;

  // admin token
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  // products
  const normal = await api("/products", { method: "POST", body: { title: `Normal ${uniq}`, brand: "TestBrand", category: "Test", price: 50, mrp: 99, stock: 100, description: "normal", image: "", images: [] } }, adminToken);
  const tryout = await api("/products", { method: "POST", body: { title: `Tryout ${uniq}`, brand: "TestBrand", category: "Test", price: 30, mrp: 99, stock: 100, description: "tryout", image: "", images: [], tryoutOnly: true } }, adminToken);
  const normalId = normal.data.product?._id || normal.data._id;
  const tryoutId = tryout.data.product?._id || tryout.data._id;

  const customer = { name, email, phone, state: "Uttar Pradesh", city: "Kanpur", address: "Test Street 12", pincode: "208001" };

  // normal order
  await api("/orders", { method: "POST", body: { customer, items: [{ productId: normalId, quantity: 1 }], paymentMethod: "cod" } }, userToken);

  // apply + approve
  const apply = await api("/tryouts/apply", { method: "POST", body: { name, phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "Test", reason: "live verify" } }, userToken);
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  await api(`/tryouts/${app._id}/approve`, { method: "POST" }, adminToken);

  // tryout order
  await api("/orders", { method: "POST", body: { customer, items: [{ productId: tryoutId, quantity: 1 }], paymentMethod: "cod" } }, userToken);

  // report
  const dash = await api("/tryouts/my", {}, userToken);
  console.log("DASHBOARD totalOrders:", dash.data?.dashboard?.totalOrders, "(should be 1)");
  console.log("TOKEN=" + userToken);
  console.log("EMAIL=" + email);
  console.log("PHONE=" + phone);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
