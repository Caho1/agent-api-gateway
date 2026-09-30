"""Potentially billable TikHub example; configure service/grant before running.
Original API docs: https://docs.tikhub.io/186826223e0
Service tikhub-demo uses https://api.tikhub.io and server-side Authorization: Bearer.
Both route policies require exact GET /api/v1/douyin/app/v3/fetch_user_post_videos.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Gateway redirect refused")


base = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8787")
parsed = urllib.parse.urlsplit(base)
if parsed.scheme != "https" and not (
    parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
):
    raise RuntimeError("Use HTTPS or a trusted loopback tunnel")
payload = {
    "service": "tikhub-demo", "method": "GET",
    "path": "/api/v1/douyin/app/v3/fetch_user_post_videos",
    "query": {"sec_user_id": os.environ["TIKHUB_SEC_USER_ID"],
              "max_cursor": "0", "count": "20", "sort_type": "0", "channel": "normal"},
}
request = urllib.request.Request(
    urllib.parse.urljoin(base, "/v1/relay"),
    data=json.dumps(payload).encode(),
    headers={"Authorization": "Bearer " + os.environ["GATEWAY_TOKEN"],
             "Content-Type": "application/json"}, method="POST",
)
opener = urllib.request.build_opener(NoRedirect())
with opener.open(request, timeout=45) as response:
    data = json.load(response)["data"]
print("Upstream status:", data["status"])
# Reparse exact raw JSON bytes to preserve Python arbitrary-precision integers.
if data["encoding"] == "json":
    print(json.loads(base64.b64decode(data["rawBodyBase64"])))
else:
    print(base64.b64decode(data["body"]))
