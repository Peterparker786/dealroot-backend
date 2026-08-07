const BASE = "http://localhost:5000";

(async () => {
  const jwt = require("jsonwebtoken");
  const adminToken = jwt.sign(
    { role: "admin", email: process.env.ADMIN_EMAIL },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const signup = await fetch(BASE + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Harsh Mishra",
      email: "livecb@example.com",
      password: "test12345",
    }),
  });
  const su = await signup.json();
  if (!su.success) throw new Error("signup: " + su.message);

  const apply = await fetch(BASE + "/api/tryouts/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + su.token,
    },
    body: JSON.stringify({
      name: "Harsh Mishra",
      phone: "9876543210",
      city: "Kanpur",
      state: "Uttar Pradesh",
      pincode: "208001",
      reason: "live preview",
    }),
  });
  const ap = await apply.json();
  const appId = ap.application._id;

  await fetch(BASE + "/api/tryouts/" + appId + "/approve", {
    method: "POST",
    headers: { Authorization: "Bearer " + adminToken },
  });

  await fetch(BASE + "/api/tryouts/" + appId + "/cashback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + adminToken,
    },
    body: JSON.stringify({ amount: 500, note: "Purchase of Glow Serum Trial Kit" }),
  });
  await fetch(BASE + "/api/tryouts/" + appId + "/cashback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + adminToken,
    },
    body: JSON.stringify({ amount: 1200, note: "Purchase of Hair Oil" }),
  });

  console.log("USER_TOKEN=" + su.token);
  console.log("READY");
})().catch((e) => {
  console.error("SETUP FAILED:", e.message);
  process.exit(1);
});
