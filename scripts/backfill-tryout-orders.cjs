/* One-time backfill: mark existing orders as tryoutOrder if any item
   references a product with tryoutOnly: true. */
require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("No MONGO_URI in env");
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const orders = db.collection("orders");
  const products = db.collection("products");

  const tryoutIds = await products
    .find({ tryoutOnly: true }, { projection: { _id: 1 } })
    .toArray();
  const idSet = new Set(tryoutIds.map((p) => String(p._id)));

  if (!idSet.size) {
    console.log("No tryout products exist — nothing to backfill.");
    await mongoose.disconnect();
    return;
  }

  const all = await orders.find({ tryoutOrder: { $ne: true } }).toArray();
  let updated = 0;

  for (const order of all) {
    const hasTryout = (order.items || []).some(
      (item) => item && item.product && idSet.has(String(item.product))
    );
    if (hasTryout) {
      await orders.updateOne({ _id: order._id }, { $set: { tryoutOrder: true } });
      updated += 1;
    }
  }

  console.log(`Scanned ${all.length} orders, flagged ${updated} as tryout orders.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
