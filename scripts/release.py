#!/usr/bin/env python3
"""Serialized, fail-closed Cloud Run release; no additional IAM or datastore."""
import copy
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PREFIX = 'altegio.io/'
LOCK = PREFIX + 'release-owner'
SEQUENCE = PREFIX + 'release-sequence'
COMMIT = PREFIX + 'release-commit'


class Conflict(Exception):
    pass


class Api:
    def __init__(self, project, region, service):
        self.name = f'projects/{project}/locations/{region}/services/{service}'
        self.url = 'https://run.googleapis.com/v2/' + self.name

    def request(self, method, url, data=None):
        token = subprocess.check_output(
            ['gcloud', 'auth', 'print-access-token'], text=True).strip()
        request = urllib.request.Request(url, method=method,
            headers={'Authorization': 'Bearer ' + token,
                     'Content-Type': 'application/json'},
            data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (409, 412):
                raise Conflict() from None
            # No response body: API errors may contain configuration values.
            raise RuntimeError(f'Cloud Run API {method} failed: HTTP {error.code}') from None

    def get(self):
        return self.request('GET', self.url)

    def patch(self, service, **fields):
        operation = self.request('PATCH', self.url + '?updateMask=' + ','.join(fields),
            {'name': self.name, 'etag': service['etag'], **fields})
        deadline = time.monotonic() + 900
        while not operation.get('done'):
            if time.monotonic() > deadline:
                # An unknown operation outcome must retain the lock for recovery.
                raise TimeoutError('Cloud Run operation unresolved; retain release lock')
            time.sleep(3)
            operation = self.request('GET', 'https://run.googleapis.com/v2/' + operation['name'])
        if 'error' in operation:
            raise RuntimeError('Cloud Run operation failed; inspect operation ' + operation['name'])


def annotations(service):
    return dict(service.get('annotations', {}))


def own_traffic(service, tag):
    return [entry for entry in service.get('trafficStatuses', []) if entry.get('tag') == tag]


class Release:
    def __init__(self, api, owner, sequence, commit, tag, deploy, smoke, sleep=time.sleep):
        self.api, self.owner, self.sequence = api, owner, sequence
        self.commit, self.tag, self.deploy, self.smoke = commit, tag, deploy, smoke
        self.sleep = sleep
        self.unresolved = False

    def acquire(self, attempts=120):
        for _ in range(attempts):
            service = self.api.get()
            meta = annotations(service)
            last = int(meta.get(SEQUENCE, '0'))
            if self.sequence < last:
                return False
            if self.sequence == last:
                if meta.get(COMMIT) == self.commit:
                    return False
                raise RuntimeError('Release sequence collision; increment release.json')
            if LOCK in meta or service.get('reconciling'):
                self.sleep(5)
                continue
            meta[LOCK] = self.owner
            try:
                self.api.patch(service, annotations=meta)
                return True
            except Conflict:
                continue
        raise RuntimeError('Release lock wait expired; inspect owner build, never steal a live lock')

    def owned(self):
        service = self.api.get()
        if annotations(service).get(LOCK) != self.owner:
            raise RuntimeError('Release ownership lost; refusing mutation')
        if service.get('reconciling'):
            raise TimeoutError('Unresolved reconciliation; retain release lock')
        return service

    def cleanup(self):
        # Retain ownership if an API operation could still be mutating the service.
        if self.unresolved:
            return
        for _ in range(10):
            service = self.owned()
            meta = annotations(service)
            del meta[LOCK]
            traffic = [entry for entry in service['traffic'] if entry.get('tag') != self.tag]
            try:
                self.api.patch(service, annotations=meta, traffic=traffic)
                return
            except Conflict:
                continue
        raise RuntimeError('Cleanup conflict; lock retained for recovery')

    def run(self):
        if not self.acquire():
            print('SKIP: release already superseded or completed')
            return
        try:
            previous = copy.deepcopy(self.owned()['traffic'])
            self.deploy()
            service = self.owned()
            candidates = own_traffic(service, self.tag)
            if len(candidates) != 1 or not candidates[0].get('uri'):
                raise RuntimeError('Candidate tag missing or ambiguous')
            candidate = candidates[0]
            self.smoke(candidate['uri'])
            service = self.owned()
            # Use a concrete candidate revision, never latestCreatedRevision.
            meta = annotations(service)
            meta.update({SEQUENCE: str(self.sequence), COMMIT: self.commit})
            traffic = [{**entry, 'percent': 0} for entry in service['traffic']
                       if entry.get('tag') and entry.get('tag') != self.tag]
            traffic.append({'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
                            'revision': candidate['revision'], 'percent': 100})
            self.api.patch(service, annotations=meta, traffic=traffic)
            try:
                self.smoke(self.owned()['uri'])
            except Exception:
                # Restore only while still owning this exact promotion. Sequence
                # remains advanced so a delayed older build cannot overwrite it.
                current = self.owned()
                if annotations(current).get(COMMIT) != self.commit:
                    raise RuntimeError('Promotion changed; refusing automatic rollback') from None
                self.api.patch(current, traffic=previous)
                raise
            print('PASS: release promoted and production health verified')
        except TimeoutError:
            self.unresolved = True
            raise
        finally:
            self.cleanup()


def main():
    project, region, service, owner, commit = sys.argv[1:6]
    command = sys.argv[6:]
    with open('release.json') as source:
        sequence = json.load(source)['sequence']
    if not isinstance(sequence, int) or sequence < 1:
        raise RuntimeError('Invalid release sequence')
    tag = 'b' + owner
    def deploy():
        subprocess.run(command + ['--tag=' + tag, '--revision-suffix=' + tag], check=True, timeout=600)
    def smoke(url):
        subprocess.run(['bash', 'scripts/smoke-url.sh', url, commit], check=True, timeout=90)
    Release(Api(project, region, service), owner, sequence, commit, tag, deploy, smoke).run()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
