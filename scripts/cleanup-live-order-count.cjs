require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("No MONGO_URI/MONGODB_URI"); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const email = "ordcount-3044534@example.com";

  const user = await db.collection("users").findOne({ email });
  const res = await db.collection("orders").deleteMany({ "customer.email": email });
  await db.collection("products").deleteMany({ title: { $regex: /(Normal|Tryout) 3044534/ } });
  if (user) await db.collection("tryoutapplications").deleteMany({ user: user._id });
  await db.collection("users").deleteMany({ email });
  console.log("Cleaned:", res.deletedCount, "orders + user + tryout app + products");
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
