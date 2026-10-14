"""
Local stand-in for the Lambda Python runtime: keeps one warm process per
function and runs its handler for each request, as a warm Lambda container
does. Requests and replies are one JSON object per line on stdin/stdout.
Anything the handler prints goes to stderr, so it cannot corrupt the replies.

    python local/python-lambda.py <function folder> <module.function>
"""
import importlib
import json
import sys
import traceback

folder, entry = sys.argv[1], sys.argv[2]
module_name, function_name = entry.rsplit(".", 1)
sys.path.insert(0, folder)
reply = sys.stdout
sys.stdout = sys.stderr
handler = getattr(importlib.import_module(module_name), function_name)

for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    try:
        result = handler(request.get("event"), None)
        message = {"id": request["id"], "ok": True, "result": result}
    except Exception as e:  # reported like the Lambda runtime reports an unhandled error
        traceback.print_exc(file=sys.stderr)
        message = {"id": request["id"], "ok": False, "errorType": type(e).__name__, "errorMessage": str(e)}
    reply.write(json.dumps(message) + "\n")
    reply.flush()