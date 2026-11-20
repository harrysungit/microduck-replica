"""AIC3104 speaker volume; PCM gain plus line mute, never capture controls."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading


class VolumeError(Exception):
    pass


def volume_raw(percent):
    if type(percent) is not int or not 0 <= percent <= 100:
        raise ValueError('音量必须为 0–100 的整数')
    return max(0, min(127, round(127 + 40 * math.log10(max(1, percent) / 100))))


class SpeakerVolume:
    def __init__(self, state_dir, run=subprocess.run):
        self.path = Path(state_dir) / 'speaker-volume.json' if state_dir else None
        self.run = run
        self.lock = threading.Lock()

    def _command(self, *args):
        try:
            r = self.run(['amixer', '-c', 'aic3104', *args], capture_output=True,
                         text=True, timeout=3, env={**os.environ, 'LC_ALL':'C'})
            if r.returncode:
                raise VolumeError('无法访问扬声器，请检查声卡连接和音频权限')
            return r.stdout
        except (OSError, subprocess.TimeoutExpired) as e:
            raise VolumeError('无法访问扬声器，请检查声卡连接和音频权限') from e

    def _read(self):
        pcm = self._command('cget', 'name=PCM Playback Volume')
        line = self._command('cget', 'name=Line Playback Switch')
        p = re.search(r': values=(\d+),(\d+)', pcm)
        m = re.search(r': values=(on|off),(on|off)', line)
        if not p or not m or 'min=0,max=127' not in pcm:
            raise VolumeError('扬声器音量控制格式不受支持')
        values = tuple(map(int, p.groups()))
        if any(not 0 <= x <= 127 for x in values):
            raise VolumeError('扬声器返回了无效音量')
        return values, m.groups()

    def _saved(self):
        if not self.path or not self.path.exists():
            return None
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            value = data['percent']
            volume_raw(value)
            return value
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise VolumeError('已保存的音量设置无法读取') from e

    def _view(self, state):
        values, switches = state
        audible = [x for x, switch in zip(values, switches) if switch == 'on']
        percent = round(100 * 10 ** ((max(audible) - 127) / 40)) if audible else 0
        saved = self._saved()
        matches = saved is not None and ((saved == 0 and not audible) or
            (saved > 0 and values == (volume_raw(saved),) * 2 and switches == ('on', 'on')))
        return {'percent': saved if matches else percent, 'muted': not audible,
                'saved': matches, 'available': True}

    def view(self):
        with self.lock:
            return self._view(self._read())

    def _apply(self, percent):
        if percent == 0:
            self._command('cset', 'name=Line Playback Switch', 'off,off')
        else:
            raw = volume_raw(percent)
            self._command('cset', 'name=PCM Playback Volume', f'{raw},{raw}')
            self._command('cset', 'name=Line Playback Switch', 'on,on')
        state = self._read()
        if percent == 0:
            valid = state[1] == ('off','off')
        else:
            valid = state == ((volume_raw(percent),) * 2, ('on','on'))
        if not valid:
            raise VolumeError('音量未正确应用，请重试')
        return state

    def set(self, percent):
        volume_raw(percent)
        if self.path is None:
            raise VolumeError('音量保存目录未配置')
        with self.lock:
            before = self._read()
            temp = None
            try:
                state = self._apply(percent)
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                                 prefix='.speaker-volume-', delete=False) as f:
                    temp = f.name
                    json.dump({'percent':percent}, f)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp, self.path)
                temp = None
            except Exception as e:
                try:
                    self._command('cset', 'name=PCM Playback Volume', ','.join(map(str,before[0])))
                    self._command('cset', 'name=Line Playback Switch', ','.join(before[1]))
                except VolumeError:
                    raise VolumeError('保存失败且无法恢复原音量，请刷新检查当前音量') from e
                raise VolumeError('音量未保存，已恢复原音量') from e
            finally:
                if temp:
                    Path(temp).unlink(missing_ok=True)
            return self._view(state)

    def restore(self):
        with self.lock:
            percent = self._saved()
            if percent is not None:
                self._apply(percent)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Restore saved speaker volume after codec initialization')
    parser.add_argument('--restore', required=True, metavar='STATE_DIR')
    args = parser.parse_args()
    SpeakerVolume(args.restore).restore()

