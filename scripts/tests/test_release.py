import copy
import importlib.util
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class FakeApi:
    def __init__(self):
        self.mutex = threading.Lock()
        self.state = {'etag': '0', 'annotations': {}, 'uri': 'https://production',
                      'traffic': [{'revision': 'good', 'percent': 100}], 'trafficStatuses': []}
        self.promotions = []

    def get(self):
        with self.mutex:
            return copy.deepcopy(self.state)

    def patch(self, service, **fields):
        with self.mutex:
            if service['etag'] != self.state['etag']:
                raise r.Conflict()
            self.state.update(copy.deepcopy(fields))
            self.state['etag'] = str(int(self.state['etag']) + 1)
            self.state['trafficStatuses'] = [dict(entry, uri='https://candidate')
                                            for entry in self.state['traffic'] if entry.get('tag')]
            if 'traffic' in fields:
                self.promotions.append([entry['revision'] for entry in fields['traffic']
                                        if entry.get('percent') == 100])

    def deploy(self, tag):
        state = self.get()
        self.patch(state, traffic=state['traffic'] + [{'revision': tag, 'tag': tag, 'percent': 0}])


def release(api, seq, deploy=None, smoke=None, sleep=lambda _: None):
    tag = 'b' + str(seq)
    return r.Release(api, str(seq), seq, 'commit' + str(seq), tag,
                     deploy or (lambda: api.deploy(tag)), smoke or (lambda _: None), sleep)


class ReleaseTests(unittest.TestCase):
    def test_out_of_order_old_build_never_deploys_or_overwrites(self):
        api = FakeApi()
        release(api, 2).run()
        release(api, 1, deploy=lambda: self.fail('stale build deployed')).run()
        self.assertEqual(api.state['traffic'][0]['revision'], 'b2')
        self.assertNotIn(r.LOCK, api.state['annotations'])

    def test_atomic_lock_serializes_overlapping_candidates(self):
        api = FakeApi()
        entered, finish, waiting = threading.Event(), threading.Event(), threading.Event()
        errors = []
        def slow():
            api.deploy('b1')
            entered.set()
            self.assertTrue(finish.wait(3))
        def wait(_):
            waiting.set()
            finish.wait(3)
            old.join(3)
        def run(item):
            try:
                item.run()
            except Exception as error:
                errors.append(error)
        old = threading.Thread(target=run, args=(release(api, 1, deploy=slow),))
        old.start()
        self.assertTrue(entered.wait(3))
        new = threading.Thread(target=run, args=(release(api, 2, sleep=wait),))
        new.start()
        self.assertTrue(waiting.wait(3))
        self.assertEqual(len(api.state['trafficStatuses']), 1)
        finish.set()
        old.join(3)
        new.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(api.state['traffic'][0]['revision'], 'b2')

    def test_candidate_health_failure_keeps_good_traffic_and_foreign_tag(self):
        api = FakeApi()
        api.deploy('foreign')
        def fail(_):
            raise RuntimeError('unhealthy')
        with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
            release(api, 1, smoke=fail).run()
        self.assertEqual(api.state['traffic'][0], {'revision': 'good', 'percent': 100})
        self.assertEqual(api.state['traffic'][1]['tag'], 'foreign')
        self.assertNotIn(r.LOCK, api.state['annotations'])
        self.assertNotIn(r.SEQUENCE, api.state['annotations'])

    def test_production_health_failure_rolls_back_and_blocks_stale_build(self):
        api = FakeApi()
        def smoke(url):
            if url.endswith('production'):
                raise RuntimeError('production unhealthy')
        with self.assertRaisesRegex(RuntimeError, 'production unhealthy'):
            release(api, 2, smoke=smoke).run()
        self.assertEqual(api.state['traffic'], [{'revision': 'good', 'percent': 100}])
        release(api, 1, deploy=lambda: self.fail('stale deploy after rollback')).run()
        self.assertEqual(api.state['annotations'][r.SEQUENCE], '2')

    def test_rollback_is_a_new_forward_release(self):
        api = FakeApi()
        release(api, 1).run()
        release(api, 2).run()
        self.assertEqual(api.state['traffic'][0]['revision'], 'b2')

    def test_sequence_collision_fails_closed(self):
        api = FakeApi()
        release(api, 1).run()
        candidate = release(api, 1)
        candidate.commit = 'different'
        with self.assertRaisesRegex(RuntimeError, 'collision'):
            candidate.run()

    def test_etag_rejects_stale_mutation(self):
        api = FakeApi()
        stale = api.get()
        api.patch(api.get(), annotations={r.LOCK: 'another'})
        with self.assertRaises(r.Conflict):
            api.patch(stale, traffic=[{'revision': 'bad', 'percent': 100}])
        self.assertEqual(api.state['traffic'][0]['revision'], 'good')

    def test_unknown_operation_retains_lock_and_does_not_steal(self):
        api = FakeApi()
        def timeout():
            raise TimeoutError('unknown')
        with self.assertRaises(TimeoutError):
            release(api, 1, deploy=timeout).run()
        self.assertEqual(api.state['annotations'][r.LOCK], '1')
        with self.assertRaisesRegex(RuntimeError, 'lock wait expired'):
            release(api, 2).run()
        self.assertEqual(api.state['annotations'][r.LOCK], '1')


class ApiPollingTests(unittest.TestCase):
    def test_build_uuid_tag_is_unique_and_fits_service_dns_label(self):
        first = r.tag_for_owner('5c3f284f-e917-45e2-b259-28b7dc58ca69')
        other = r.tag_for_owner('5c3f284f-e917-45e2-b259-28b7dc58ca68')
        self.assertNotEqual(first, other)
        self.assertEqual(len(first), 27)
        self.assertLessEqual(len(first + '---altegio-me-mcp-brg2k7l5ma-ew'), 63)


    def test_service_scoped_permission_never_reads_regional_operations(self):
        api = r.Api('project', 'region', 'service')
        calls = []
        states = iter([
            {'reconciling': True, 'generation': '2', 'observedGeneration': '1'},
            {'generation': '2', 'observedGeneration': '2',
             'annotations': {r.LOCK: 'owner'},
             'terminalCondition': {'state': 'CONDITION_SUCCEEDED'}},
        ])
        def request(method, url, data=None):
            calls.append((method, url))
            if method == 'PATCH':
                return {'name': 'projects/project/locations/region/operations/not-readable'}
            self.assertEqual(url, api.url)
            return next(states)
        api.request = request
        original_sleep = r.time.sleep
        r.time.sleep = lambda _: None
        try:
            api.patch({'etag': 'old'}, annotations={r.LOCK: 'owner'})
        finally:
            r.time.sleep = original_sleep
        self.assertEqual([method for method, _ in calls], ['PATCH', 'GET', 'GET'])
        self.assertTrue(all('/operations/' not in url for _, url in calls))

    def test_empty_annotation_map_can_be_omitted(self):
        self.assertTrue(r.field_matches('annotations', {}, None))
        self.assertFalse(r.field_matches('annotations', {r.LOCK: 'owner'}, None))

    def test_traffic_normalizes_omitted_zero_and_order(self):
        expected = [{'revision': 'good', 'percent': 100},
                    {'revision': 'candidate', 'tag': 'owner', 'percent': 0}]
        actual = [{'revision': 'candidate', 'tag': 'owner',
                   'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'},
                  {'revision': 'good', 'percent': 100,
                   'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'}]
        self.assertTrue(r.field_matches('traffic', expected, actual))
        actual[1]['percent'] = 99
        self.assertFalse(r.field_matches('traffic', expected, actual))


if __name__ == '__main__':
    unittest.main()
