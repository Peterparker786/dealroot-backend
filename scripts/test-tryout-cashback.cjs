const BASE = "http://localhost:5000";
const EMAIL = `cbtest${Date.now()}@example.com`;
const PASSWORD = "test12345";

async function jfetch(path, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  const jwt = require("jsonwebtoken");
  const adminToken = jwt.sign(
    { role: "admin", email: process.env.ADMIN_EMAIL },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  console.log("0. admin token minted");

  // 1. Signup
  const signup = await jfetch("/api/auth/signup", {
    method: "POST",
    body: { name: "Cashback Test", email: EMAIL, password: PASSWORD },
  });
  if (!signup.data.success) throw new Error("signup failed: " + signup.data.message);
  const userToken = signup.data.token;
  console.log("1. signup OK");

  // 2. Apply for tryouts
  const apply = await jfetch("/api/tryouts/apply", {
    method: "POST",
    token: userToken,
    body: {
      name: "Cashback Test",
      phone: "9876543210",
      city: "Kanpur",
      state: "Uttar Pradesh",
      pincode: "208001",
      previousProgram: "",
      reason: "Testing cashback flow",
    },
  });
  if (!apply.data.success) throw new Error("apply failed: " + apply.data.message);
  const appId = apply.data.application._id;
  console.log("2. applied OK", appId);

  // 3. Admin approve
  const approve = await jfetch(`/api/tryouts/${appId}/approve`, {
    method: "POST",
    token: adminToken,
  });
  if (!approve.data.success) throw new Error("approve failed: " + approve.data.message);
  console.log("3. approved OK");

  // 4. Admin add cashback
  const add = await jfetch(`/api/tryouts/${appId}/cashback`, {
    method: "POST",
    token: adminToken,
    body: { amount: 150, note: "Purchase of Glow Serum" },
  });
  if (!add.data.success) throw new Error("add cashback failed: " + add.data.message);
  const entryId = add.data.application.cashbackHistory[0]._id;
  console.log("4. cashback added, entry:", entryId);

  // 5. Move available -> pending
  const toPending = await jfetch(`/api/tryouts/cashback/${entryId}`, {
    method: "PATCH",
    token: adminToken,
    body: { status: "pending" },
  });
  if (!toPending.data.success) throw new Error("pending failed: " + toPending.data.message);
  console.log("5. moved to pending OK");

  // 6. Move pending -> received
  const toReceived = await jfetch(`/api/tryouts/cashback/${entryId}`, {
    method: "PATCH",
    token: adminToken,
    body: { status: "received" },
  });
  if (!toReceived.data.success) throw new Error("received failed: " + toReceived.data.message);
  console.log("6. moved to received OK");

  // 7. Member dashboard summary
  const dash = await jfetch("/api/tryouts/my", { token: userToken });
  const d = dash.data.dashboard;
  console.log("7. dashboard:", JSON.stringify(d));
  if (d.cashbackReceived !== 150 || d.cashbackAvailable !== 0) {
    throw new Error("dashboard totals wrong: " + JSON.stringify(d));
  }

  console.log("ALL TESTS PASSED ✅");
  console.log("TEST_APP_ID=" + appId);
  console.log("TEST_EMAIL=" + EMAIL);
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  console.log("TEST_EMAIL=" + EMAIL);
  process.exit(1);
});
