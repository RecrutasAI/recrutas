"""Fixture application site + mock Recrutas API for testing submission detection.

  python3 tracking-fixture.py   # site on :8099 (map recrutas-bench.breezy.hr -> 127.0.0.1), API on :8098

The site imitates an application flow: a form page, and a confirmation page
reached either by navigation (/thanks) or by replacing the form in place.
The API records what the extension reports, and says the "qa" posting was
already applied to (to exercise the duplicate warning).
"""
import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FORM = """<!doctype html><html><head><title>Support Engineer - Bench Co</title>
<meta property="og:site_name" content="Bench Co"></head><body>
<h1>Support Engineer</h1>
<form id="f" action="{action}" method="get">
<label>First name <input name="first"></label><label>Email <input name="email" type="email"></label>
<label>Phone <input name="phone" type="tel"></label><button type="submit" id="go">Submit application</button>
</form>
<script>
if ({inplace}) document.getElementById('f').addEventListener('submit', e => {{
  e.preventDefault();
  document.getElementById('f').outerHTML = '<p>Thank you for applying! Your application has been submitted.</p>';
}});
</script></body></html>"""
THANKS = """<!doctype html><html><body><h1>Support Engineer</h1>
<p>Thank you for applying! We have received your application.</p></body></html>"""

class Site(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split('?')[0]
        if p.endswith('/thanks'):
            body = THANKS
        elif p.endswith('/apply'):
            inplace = 'true' if 'inplace' in p else 'false'
            body = FORM.format(action=p.replace('/apply', '/thanks'), inplace=inplace)
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
        self.wfile.write(body.encode())

REPORTS = []
class Api(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        body['_auth'] = (self.headers.get('Authorization') or '')[:7]
        REPORTS.append(body)
        with open('/root/ext-e2e/tracking-reports.jsonl', 'a') as fh: fh.write(json.dumps(body) + '\n')
        self._send({'applicationId': len(REPORTS), 'jobId': 1, 'tracked': True, 'duplicate': False, 'appliedAt': None})
    def do_GET(self):
        if self.path.startswith('/api/extension/applications/status'):
            applied = 'qa' in self.path
            self._send({'applied': True, 'appliedAt': '2026-09-12T10:00:00Z', 'jobId': 2} if applied else {'applied': False})
        else:
            self._send({})

threading.Thread(target=ThreadingHTTPServer(('0.0.0.0', 8099), Site).serve_forever, daemon=True).start()
ThreadingHTTPServer(('127.0.0.1', 8098), Api).serve_forever()
