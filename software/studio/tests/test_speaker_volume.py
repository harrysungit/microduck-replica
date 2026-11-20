import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from studio.speaker_volume import SpeakerVolume, VolumeError, volume_raw


class Mixer:
    def __init__(self):
        self.raw = '103,103'
        self.switch = 'on,on'
        self.calls = []
        self.fail = False

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if self.fail:
            return SimpleNamespace(returncode=1,stdout='')
        _, _, card, op, control, *values = args
        assert card == 'aic3104'
        assert control in ('name=PCM Playback Volume','name=Line Playback Switch')
        pcm = 'PCM' in control
        if op == 'cset':
            if pcm: self.raw = values[0]
            else: self.switch = values[0]
        return SimpleNamespace(returncode=0,stdout='min=0,max=127\n  : values=' + (self.raw if pcm else self.switch))


class SpeakerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mixer = Mixer()
        self.volume = SpeakerVolume(self.tmp.name, run=self.mixer)

    def test_actual_quarter_volume_is_read_without_writing(self):
        self.assertEqual(self.volume.view()['percent'],25)
        self.assertTrue(all(c[3]=='cget' for c in self.mixer.calls))

    def test_percent_is_amplitude_not_raw_alsa_percentage(self):
        self.assertEqual(volume_raw(100),127)
        self.assertEqual(volume_raw(25),103)
        self.assertEqual(volume_raw(50),115)
        self.assertEqual(self.volume.set(25)['percent'],25)
        self.assertEqual(self.mixer.raw,'103,103')

    def test_zero_really_mutes_and_nonzero_restores_speakers(self):
        self.assertTrue(self.volume.set(0)['muted'])
        self.assertEqual(self.mixer.switch,'off,off')
        self.assertFalse(self.volume.set(25)['muted'])
        self.assertEqual(self.mixer.switch,'on,on')

    def test_save_and_restore_after_hardware_reset(self):
        self.volume.set(25)
        self.mixer.raw = '127,127'
        self.assertFalse(self.volume.view()['saved'])
        SpeakerVolume(self.tmp.name,run=self.mixer).restore()
        self.assertEqual(self.mixer.raw,'103,103')
        self.assertTrue(self.volume.view()['saved'])

    def test_no_saved_setting_does_not_raise_volume_on_start(self):
        self.volume.restore()
        self.assertEqual(self.mixer.calls,[])

    def test_invalid_input_never_calls_hardware(self):
        for value in [-1,101,True,25.1,'25',None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.volume.set(value)
        self.assertEqual(self.mixer.calls,[])

    def test_disk_failure_rolls_back_hardware_and_preserves_saved_value(self):
        self.volume.set(25)
        with patch('studio.speaker_volume.os.replace',side_effect=OSError('disk full')):
            with self.assertRaises(VolumeError): self.volume.set(80)
        self.assertEqual(self.mixer.raw,'103,103')
        self.assertEqual(json.loads(self.volume.path.read_text())['percent'],25)
        self.assertEqual(list(Path(self.tmp.name).glob('.speaker-volume-*')),[])

    def test_unavailable_device_does_not_claim_success_or_save(self):
        self.mixer.fail = True
        with self.assertRaises(VolumeError): self.volume.set(25)
        self.assertFalse(self.volume.path.exists())
