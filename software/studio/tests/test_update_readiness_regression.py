"""Exercise the actual app readiness closure without starting hardware services."""
import ast
from pathlib import Path
from types import SimpleNamespace as NS
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1] / 'studio' / 'app.py'

class UpdateReadinessRegression(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(APP.read_text(encoding='utf-8'))
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'update_readiness')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.native = {'active': False}
        self.marker = Path(self.tmp.name) / 'installing'
        self.servo = NS(state='closed')
        self.motion = NS(state='idle', session=None)
        self.pad = NS(motion_studio=self.motion, mapping=NS(blocked=False))
        self.imu = NS(_redo_busy=False, blocks_updates=lambda:False)
        self.commands, self.mapping_requests = set(), set()
        env = dict(updates=NS(marker=self.marker, native_state=lambda:dict(self.native),
                            installing=lambda:self.marker.exists() or self.native.get('active') is True),
                   update_commands=self.commands, model_upload_gate=NS(locked=lambda:False),
                   pad=self.pad, servo=self.servo, mapping_requests=self.mapping_requests, imu=self.imu)
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(APP), 'exec'), env)
        self.ready = env['update_readiness']

    def test_software_coordinator_marker_does_not_block_its_preflight(self):
        self.assertTrue(self.ready()['ready'])
        self.marker.write_text('coordinator-job-id')
        self.assertTrue(self.ready()['ready'])

    def test_native_update_blocks_software_even_without_marker(self):
        for phase in ('guarded', 'prepared', 'recovery_required'):
            self.native.update(active=True, phase=phase)
            self.assertFalse(self.ready()['ready'])

    def test_only_matching_prepared_native_transaction_can_recover(self):
        self.native.update(active=True, bundle_schema='microduck-controller-payload/1',
                           phase='prepared', transaction_id='a'*32)
        self.assertFalse(self.ready()['ready'])
        self.assertFalse(self.ready(native_transaction='b'*32)['ready'])
        self.assertTrue(self.ready(native_transaction='a'*32)['ready'])
        self.marker.touch()
        self.assertFalse(self.ready(native_transaction='a'*32)['ready'])

    def test_real_sessions_still_block_with_software_marker(self):
        self.marker.touch()
        cases = [(self.servo,'state','opening'), (self.motion,'state','playing'),
                 (self.motion,'session',object()), (self.pad.mapping,'blocked',True),
                 (self.imu,'_redo_busy',True), (self.imu,'blocks_updates',lambda:True)]
        for obj, key, value in cases:
            before = getattr(obj,key)
            with self.subTest(key=key, value=str(value)):
                setattr(obj,key,value)
                self.assertFalse(self.ready()['ready'])
                setattr(obj,key,before)
        task=type('Task',(),{'done':lambda self:False})()
        self.commands.add(task)
        self.assertFalse(self.ready()['ready'])
        self.commands.clear()
        self.mapping_requests.add('mapping')
        self.assertFalse(self.ready()['ready'])
        self.mapping_requests.clear()
        self.assertTrue(self.ready()['ready'])

if __name__ == '__main__': unittest.main()
