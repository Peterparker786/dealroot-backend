require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const email = "liveadm-3820242@example.com";
  const user = await db.collection("users").findOne({ email });
  if (user) await db.collection("tryoutapplications").deleteMany({ user: user._id });
  await db.collection("users").deleteMany({ email });
  console.log("Cleaned admin-verify test data");
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
