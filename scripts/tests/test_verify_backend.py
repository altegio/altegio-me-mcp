"""Operator verification must fail closed even with Python optimization enabled."""
import io
from pathlib import Path
import unittest
from unittest.mock import patch


class VerificationTests(unittest.TestCase):
    def test_wrong_revision_is_rejected_under_optimization(self):
        script = Path(__file__).parents[1] / 'verify-backend.py'
        code = compile(script.read_text(), str(script), 'exec', optimize=2)
        response = io.BytesIO(b'{"status":"ok","commit":"wrong"}')
        response.status = 200
        response.headers = {}
        with patch('sys.argv', [str(script), 'https://fixture.invalid', '0123abc']), \
                patch('subprocess.check_output', return_value='synthetic-token-' * 4), \
                patch('urllib.request.urlopen', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'liveness/commit failed'):
                exec(code, {'__name__': '__main__'})
