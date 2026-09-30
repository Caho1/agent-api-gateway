"""Standard-library REST example; running it can consume one authorized call unit."""
import json
import os
import urllib.error
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:8787/v1/invoke",
    data=json.dumps({"operation": "posts.list", "account": os.environ["AGENT_ACCOUNT"], "args": {}}).encode(),
    headers={"Authorization": "Bearer " + os.environ["AGENT_GRANT"], "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        print(json.dumps(json.load(response)["data"], ensure_ascii=False, indent=2))
except urllib.error.HTTPError as error:
    # Gateway error codes contain no upstream response or credentials.
    print(json.dumps({"status": error.code, "error": json.load(error)["error"]}))
