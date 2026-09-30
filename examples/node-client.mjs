// This calls a potentially billable upstream. Configure and explicitly authorize first.
// TikHub source API: https://docs.tikhub.io/186826223e0
// Service tikhub-demo: origin https://api.tikhub.io, header Authorization, prefix "Bearer ".
// Both service and grant need exact GET /api/v1/douyin/app/v3/fetch_user_post_videos.
const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const token = process.env.GATEWAY_TOKEN;
const secUserId = process.env.TIKHUB_SEC_USER_ID;
if (!token || !secUserId)
  throw new Error(
    "Set GATEWAY_TOKEN and TIKHUB_SEC_USER_ID; never provide the upstream API key",
  );
const endpoint = new URL("/v1/relay", base);
if (
  endpoint.protocol !== "https:" &&
  !(
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(endpoint.hostname)
  )
)
  throw new Error("Use HTTPS or a trusted loopback tunnel");
const response = await fetch(endpoint, {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(45000),
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    service: "tikhub-demo",
    method: "GET",
    path: "/api/v1/douyin/app/v3/fetch_user_post_videos",
    query: {
      sec_user_id: secUserId,
      max_cursor: "0",
      count: "20",
      sort_type: "0",
      channel: "normal",
    },
  }),
});
const envelope = await response.json();
if (!response.ok)
  throw new Error(`Gateway ${response.status}: ${envelope.error}`);
console.log("Upstream status:", envelope.data.status);
// JSON body retains the original upstream shape. For exact large integers use rawBodyBase64.
console.log(envelope.data.body);
