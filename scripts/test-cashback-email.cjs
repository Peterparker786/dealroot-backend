const BASE = "http://localhost:5000";

(async () => {
  const jwt = require("jsonwebtoken");
  const adminToken = jwt.sign(
    { role: "admin", email: process.env.ADMIN_EMAIL },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const email = `cbmail${Date.now()}@example.com`;
  const signup = await fetch(BASE + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Email Test", email, password: "test12345" }),
  });
  const su = await signup.json();
  if (!su.success) throw new Error("signup: " + su.message);

  const apply = await fetch(BASE + "/api/tryouts/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + su.token },
    body: JSON.stringify({
      name: "Email Test",
      phone: "9876543210",
      city: "Kanpur",
      state: "Uttar Pradesh",
      pincode: "208001",
      reason: "email test",
    }),
  });
  const ap = await apply.json();
  const appId = ap.application._id;

  await fetch(BASE + "/api/tryouts/" + appId + "/approve", {
    method: "POST",
    headers: { Authorization: "Bearer " + adminToken },
  });

  const add = await fetch(BASE + "/api/tryouts/" + appId + "/cashback", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
    body: JSON.stringify({ amount: 250, note: "Purchase of Face Mask" }),
  });
  const addData = await add.json();
  if (!addData.success) throw new Error("add cashback: " + addData.message);

  const app = addData.application;
  console.log("EMAIL=" + email);
  console.log("cashbackAvailable:", app.cashbackAvailable);
  console.log("history[0]:", JSON.stringify(app.cashbackHistory[0]));
  console.log("APPLICATION_EMAIL_FIELD=" + app.email);
  console.log("OK");
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
