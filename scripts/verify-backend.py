#!/usr/bin/env python3
"""Operator verification: real signed HTTPS protocol and one safe read canary.

The build account does not run this script. Use existing authorized operator
credentials; no key/signature/request or result contents are printed.
"""
import hashlib
import hmac
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

base, commit = sys.argv[1:]
if not base.startswith('https://'):
    sys.exit('HTTPS backend URL required')
key = subprocess.check_output([
    'gcloud', 'secrets', 'versions', 'access', 'latest',
    '--secret=MCP_PROXY_BACKEND_KEY_ME', '--project=altegio-mcp'], text=True).strip().split(',')[0].strip()
if len(key) < 32:
    sys.exit('Proxy key unavailable or malformed')


def request(path, payload=None, signed=True):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if payload is not None and signed:
        request_id = str(uuid.uuid4())
        headers['x-mcp-auth-request-id'] = request_id
        seconds = int(time.time())
        mac = hmac.new(key.encode(), f'mcp-proxy-auth/v1\n{seconds}\nPOST\n{path}\nx-mcp-auth-request-id:{request_id}'.encode(), hashlib.sha256).hexdigest()
        headers['x-mcp-proxy-auth'] = f'v1:{seconds}:{mac}'
    req = urllib.request.Request(base.rstrip('/') + path, headers=headers,
                                 data=None if payload is None else json.dumps(payload).encode())
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            if payload is not None and signed:
                assert response.headers.get('x-request-id') == headers['x-mcp-auth-request-id'], 'signed correlation mismatch'
            return response.status, response.headers, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, {}


status, _, health = request('/health')
assert status == 200 and health.get('status') == 'ok' and health.get('commit') == commit, 'liveness/commit failed'
expected = ['book_check', 'business_get', 'business_list_dates', 'business_list_services',
            'business_list_team_members', 'business_list_time_slots', 'me_book', 'me_list_bookings',
            'me_list_places']
for i, (method, params) in enumerate([
    ('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                    'clientInfo': {'name': 'operator-read-canary', 'version': '1'}}),
    ('tools/list', {}),
    ('tools/call', {'name': 'business_get', 'arguments': {'location_id': 722227}}),
]):
    status, headers, body = request('/mcp', {'jsonrpc': '2.0', 'id': i + 1, 'method': method, 'params': params})
    assert status == 200 and 'result' in body and 'error' not in body, method + ' failed'
    assert not headers.get('mcp-session-id'), 'stateful response'
    result = body['result']
    if method == 'initialize':
        assert result.get('protocolVersion') == '2025-11-25', 'protocol mismatch'
    elif method == 'tools/list':
        assert sorted(tool['name'] for tool in result.get('tools', [])) == expected, 'tool catalog mismatch'
    else:
        assert result.get('isError') is not True and result.get('structuredContent'), 'functional canary failed'
    print(f'PASS: {method} HTTP 200 stateless valid result')
status, _, _ = request('/mcp', {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list'}, signed=False)
assert status == 401, 'unsigned direct request accepted'
print('PASS: deployed commit/liveness, tool protocol, business_get(722227), unsigned 401')
