import { html, useState, useEffect, useRef } from './vendor/preact-htm.module.js';

export function SoundSettings({ api }) {
  const [volume, setVolume] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('读取扬声器音量…');
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const load = async () => {
    try {
      const r = await api('/api/speaker-volume');
      if (!r.ok) throw new Error(r.error || '读取音量失败');
      if (!alive.current) return;
      setVolume(r.percent); setFailed(false);
      setMessage(r.saved ? '已保存，重启后保持' : '拖动滑块，松开后应用并保存');
    } catch (e) {
      if (alive.current) { setMessage(e.message); setFailed(true); setVolume(null); }
    }
  };
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, []);
  const save = async (percent) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setMessage('正在保存…');
    try {
      const r = await api('/api/speaker-volume', { percent });
      if (!r.ok) throw new Error(r.error || '保存音量失败');
      if (!alive.current) return;
      setVolume(r.percent); setMessage('已保存，立即生效，重启后保持');
    } catch (e) {
      if (alive.current) { setFailed(true); setMessage(`${e.message}；请重新读取音量`); setVolume(null); }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return html`<section class="board" aria-label="声音" style="padding:16px 20px">
    <h2 style="margin:0 0 14px;font-size:15px;font-weight:600">声音</h2>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
      <label for="speaker-volume" style="font-size:14px;flex:1">鸭子扬声器音量</label>
      <output for="speaker-volume" class="num">${volume === null ? '—' : volume === 0 ? '静音' : `${volume}%`}</output>
    </div>
    <input id="speaker-volume" type="range" min="0" max="100" step="1"
      value=${volume ?? 0} disabled=${volume === null || busy} aria-valuetext=${volume === 0 ? '静音' : `${volume ?? 0}%`}
      onInput=${e => setVolume(Number(e.currentTarget.value))}
      onChange=${e => save(Number(e.currentTarget.value))}
      style="width:100%;margin:0;height:32px;accent-color:var(--blue)" />
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-2)"><span>静音</span><span>100%</span></div>
    <p role="status" style=${`font-size:13px;margin:12px 0 0;color:${failed ? 'var(--danger)' : 'var(--text-2)'}`}>${message}</p>
    ${failed ? html`<button type="button" onClick=${load} disabled=${busy} style="margin-top:10px">重新读取</button>` : null}
  </section>`;
}
