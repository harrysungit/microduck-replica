import asyncio,copy,time,unittest
from unittest import mock
from tests import test_imu_backend as fixtures
from tests.test_imu_backend import commissioning_bus,factory_calib
from studio import helper
from studio.rpc import RpcError
from studio.imu import Refused
class StagedImuTest(unittest.TestCase):
 setUp=fixtures.ImuBackendTest.setUp
 tearDown=fixtures.ImuBackendTest.tearDown
 backend=fixtures.ImuBackendTest.backend
 def checked(self):
  b=self.backend(bus=commissioning_bus(),calib=factory_calib());q=[.5]*4
  b.last_result={'ok':True,'mode':'coarse','mount':q}
  result=asyncio.run(b.handle({'op':'verify','confirmed':True,'mount_wxyz':q}))
  self.assertTrue(result['verified']);self.assertFalse(result['saved'])
  return b
 def save(self,b,token='test-imu-proof'):
  return asyncio.run(b.handle({'op':'save-verified','confirmed':True,'verification_id':token}))
 def test_check_keeps_calibration_and_joints_unchanged_until_save(self):
  b=self.checked();self.assertFalse(b.rd.calib.value['calibration']['imu_mount_verified'])
  joints=copy.deepcopy(b.rd.calib.value['calibration']['joints'])
  with mock.patch.object(helper,'imu_recalibrate') as finish:
   self.assertTrue(self.save(b)['saved']);finish.assert_not_called()
  self.assertEqual(b.rd.calib.value['calibration']['joints'],joints)
 def test_expired_or_wrong_proof_never_calls_writer(self):
  for expired in (False,True):
   b=self.checked()
   if expired:b._pending_verification['deadline']=time.monotonic()-1
   with mock.patch.object(b.rd,'save_checked') as writer,self.assertRaises(Refused):self.save(b,'test-imu-proof' if expired else 'wrong')
   writer.assert_not_called()
 def test_transport_change_invalidates_proof_without_saving(self):
  b=self.checked();b.rd.bus.value['imu_bus']={'protocol':'dxl2','board':'sflp_124_12','identity':[9,8,7]}
  with mock.patch.object(b.rd,'save_checked') as writer,self.assertRaises(Refused):self.save(b)
  writer.assert_not_called()
 def test_new_daemon_generation_invalidates_proof(self):
  from studio.robotd import Sample
  b=self.checked();b.rd.hello=Sample();b.rd.hello.set({'api_version':44})
  with mock.patch.object(b.rd,'save_checked') as writer,self.assertRaises(Refused):self.save(b)
  writer.assert_not_called()
 def test_refused_parallel_operation_does_not_discard_pending_proof(self):
  b=self.checked();pending=b._pending_verification
  async def concurrent():
   async with b._verify_lock:
    with self.assertRaises(Refused):await b.handle({'op':'solve','samples':[]})
  asyncio.run(concurrent());self.assertIs(b._pending_verification,pending)
 def test_restore_failure_keeps_saved_state_for_retry_without_rewriting(self):
  b=self.backend(bus=commissioning_bus(),calib=factory_calib());q=[.5]*4;b.last_result={'ok':True,'mode':'coarse','mount':q}
  session={'active':True,'phase':'commissioning','session_id':'s'*32,'source':'bus','original_mode':'commissioning'}
  with mock.patch.object(helper,'imu_redo_state',return_value=session),mock.patch.object(helper,'imu_recalibrate',side_effect=[(False,'failed',{}),(True,'finished',{})]) as finish:
   asyncio.run(b.handle({'op':'verify','confirmed':True,'mount_wxyz':q}))
   with mock.patch.object(b.rd,'save_checked',wraps=b.rd.save_checked) as writer:
    with self.assertRaises(Refused):self.save(b)
    self.assertTrue(b._pending_verification['native_saved'])
    self.assertTrue(self.save(b)['saved']);self.assertEqual(writer.call_count,1)
   self.assertEqual(finish.call_count,2)
if __name__=='__main__':unittest.main()
