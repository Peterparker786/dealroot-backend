const BASE = "http://localhost:5000";

(async () => {
  const signup = await fetch(BASE + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Email Test",
      email: "emailtest@example.com",
      password: "test12345",
    }),
  });
  const su = await signup.json();
  if (!su.success) throw new Error("signup: " + su.message);

  await fetch(BASE + "/api/auth/me", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + su.token,
    },
    body: JSON.stringify({ name: "Email Test", phone: "9876543210" }),
  });

  console.log("USER_TOKEN=" + su.token);
  console.log("READY");
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
