/* E2E: verify Tryout dashboard Total Orders counts ONLY tryout orders. */
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
  if (!SECRET) { console.error("No JWT_SECRET"); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const email = `tryord-${uniq}@example.com`;
  const phone = `98${uniq.padStart(8, "0")}`;

  // 1. Sign up user
  const signup = await api("/auth/signup", {
    method: "POST",
    body: { name: "Tryout Order Test", email, password: "password123", phone },
  });
  if (signup.status !== 201 && signup.status !== 200) {
    console.error("Signup failed", signup); process.exit(1);
  }
  const userToken = signup.data.token;

  // 2. Admin JWT (minted directly — same shape as /api/admin/login)
  if (!process.env.ADMIN_EMAIL) { console.error("No ADMIN_EMAIL"); process.exit(1); }
  const adminToken = jwt.sign({ role: "admin", email: process.env.ADMIN_EMAIL }, SECRET, { expiresIn: "1h" });

  // 3. Create normal + tryout products
  const normal = await api("/products", {
    method: "POST",
    body: { title: `Normal Test ${uniq}`, brand: "TestBrand", category: "Test", price: 50, mrp: 99, stock: 100, description: "normal", image: "", images: [] },
  }, adminToken);
  const tryout = await api("/products", {
    method: "POST",
    body: { title: `Tryout Test ${uniq}`, brand: "TestBrand", category: "Test", price: 30, mrp: 99, stock: 100, description: "tryout", image: "", images: [], tryoutOnly: true },
  }, adminToken);
  const normalId = normal.data.product?._id || normal.data._id;
  const tryoutId = tryout.data.product?._id || tryout.data._id;
  if (!normalId || !tryoutId) { console.error("Product create failed", normal.data, tryout.data); process.exit(1); }

  const customer = { name: "Tryout Order Test", email, phone, state: "Uttar Pradesh", city: "Kanpur", address: "Test Street 12", pincode: "208001" };

  // 4. Place NORMAL order (should NOT count)
  const n1 = await api("/orders", { method: "POST", body: { customer, items: [{ productId: normalId, quantity: 1 }], paymentMethod: "cod" } }, userToken);
  if (n1.status !== 201) { console.error("Normal order failed", n1); process.exit(1); }

  // 5. Apply + approve tryout
  const apply = await api("/tryouts/apply", { method: "POST", body: { name: "Tryout Order Test", phone, city: "Kanpur", state: "Uttar Pradesh", pincode: "208001", previousProgram: "Other", otherProgram: "Dealroot Test", reason: "e2e test" } }, userToken);
  if (apply.status !== 200 && apply.status !== 201) { console.error("Apply failed", apply); process.exit(1); }
  const me = await db.collection("users").findOne({ email });
  const app = await db.collection("tryoutapplications").findOne({ user: me._id });
  if (!app) { console.error("Application not found in DB"); process.exit(1); }
  await api(`/tryouts/${app._id}/approve`, { method: "POST" }, adminToken);

  // 6. Place TRYOUT order (should count)
  const n2 = await api("/orders", { method: "POST", body: { customer, items: [{ productId: tryoutId, quantity: 1 }], paymentMethod: "cod" } }, userToken);
  if (n2.status !== 201) { console.error("Tryout order failed", n2); process.exit(1); }

  // 7. Check dashboard
  const dash = await api("/tryouts/my", {}, userToken);
  const total = dash.data?.dashboard?.totalOrders;
  console.log("Total orders in dashboard:", total, "(expected 1 — only the tryout order)");
  if (total === 1) {
    console.log("PASS ✅ — normal order excluded, tryout order counted.");
  } else {
    console.log("FAIL ❌ — expected 1, got", total);
  }

  // Cleanup
  await db.collection("orders").deleteMany({ customer: { email } });
  await db.collection("products").deleteMany({ _id: { $in: [normalId, tryoutId].map((i) => new mongoose.Types.ObjectId(i)) } });
  await db.collection("users").deleteMany({ email });
  await mongoose.disconnect();
  process.exit(total === 1 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
