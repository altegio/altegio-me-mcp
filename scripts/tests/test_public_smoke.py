"""Exercise the operator's public probe against a synthetic authenticated proxy."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


class PublicSmokeTests(unittest.TestCase):
    def probe(self, token='synthetic-operator-token', metadata_status=200):
        calls = []

        class Proxy(BaseHTTPRequestHandler):
            def reply(self, status, body):
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                authorized = self.headers.get('Authorization') == 'Bearer synthetic-operator-token'
                calls.append((payload['method'], authorized))
                if not authorized:
                    return self.reply(401, {'error': 'authorization_required'})
                if payload['method'] == 'initialize':
                    self.reply(200, {'result': {'protocolVersion': '2025-11-25'}})
                else:
                    self.reply(200, {'result': {'tools': [{'name': 'business_get'}]}})

            def do_GET(self):
                calls.append((self.path, False))
                self.reply(metadata_status, {'resource': 'synthetic', 'authorization_servers': ['synthetic']})

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                token_file = Path(tmp) / 'partner-token'
                token_file.write_text(token)
                result = subprocess.run(['bash', str(Path(__file__).parents[1] / 'smoke-url.sh'),
                    '--public', f'http://127.0.0.1:{server.server_port}/me'],
                    env={**os.environ, 'ALTEGIO_OPERATOR_TOKEN_FILE': str(token_file)},
                    capture_output=True, text=True, timeout=15)
                self.assertNotIn(token, result.stdout + result.stderr)
                return result, calls
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_authenticated_stateless_route_and_metadata(self):
        result, calls = self.probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [('initialize', False), ('initialize', True),
            ('tools/list', True), ('/.well-known/oauth-protected-resource/me', False)])

    def test_invalid_partner_is_not_a_passing_probe(self):
        result, _ = self.probe(token='synthetic-invalid-token')
        self.assertNotEqual(result.returncode, 0)

    def test_missing_platform_metadata_fails(self):
        result, _ = self.probe(metadata_status=404)
        self.assertNotEqual(result.returncode, 0)
