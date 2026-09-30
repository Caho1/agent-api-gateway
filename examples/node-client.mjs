// Any Node-based agent can use this REST contract. No TikHub credential needed here.
const token = process.env.AGENT_GRANT;
const account = process.env.AGENT_ACCOUNT;
if (!token || !account) throw new Error("Set AGENT_GRANT and AGENT_ACCOUNT");
const response = await fetch("http://127.0.0.1:8787/v1/invoke", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ operation: "posts.list", account, args: {} }),
  signal: AbortSignal.timeout(15_000),
});
const result = await response.json();
if (!response.ok)
  throw new Error(
    `Gateway rejected request (${response.status}): ${result.error}`,
  );
console.log(JSON.stringify(result.data, null, 2));
