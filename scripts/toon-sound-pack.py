"""Dev only (Mac): runs cartoon-shorts' own synth (engine/audio.py, MIT) to write the comic sounds and music loops of the cartoon styles as WAV files.
Called by scripts/toon-sound-pack.ts. usage: python3 scripts/toon-sound-pack.py <upstream-clone> <out-dir>
audio.py is a script (it builds one episode), so its source is run up to the mix and its functions (the SFX table and section()) are used from there.
No Python runs in the app or its render container; the output is committed as mp3 files."""
import os, sys, tempfile, json, wave
import numpy as np

up, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
AUDIO = os.path.join(up, 'engine', 'audio.py')
SFX_NAMES = ['bell', 'bounce', 'buzzer', 'chop', 'chops', 'cymbal', 'ding', 'flash', 'heartbeat', 'hit', 'impact', 'kick', 'plop', 'pop', 'pour',
             'riser', 'rewind', 'sizzle', 'sparkle', 'squeak', 'sub', 'swish', 'taiko', 'tick', 'trumpet', 'typewriter', 'whoosh']
MOODS = ['groove', 'rise', 'tense', 'triumph', 'warm', 'end', 'sad', 'home', 'promise', 'epic']
LOOP_S = 30

ep = tempfile.mkdtemp()
json.dump({'lines': [], 'end_hold': 60.0}, open(os.path.join(ep, 'short.json'), 'w'))
sys.argv = [AUDIO, ep]
src = open(AUDIO).read()
ns = {'__file__': AUDIO, '__name__': 'audio_pack'}
exec(compile(src[:src.index('n_total = int(total * SR)')], AUDIO, 'exec'), ns)
SR, SFX, section, reverb, put = ns['SR'], ns['SFX'], ns['section'], ns['reverb'], ns['put']


def write(path, x):
    x = np.clip(x, -1, 1)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())


def trim(x, floor=6e-3):
    idx = np.nonzero(np.abs(x) > floor)[0]
    return x[:idx[-1] + int(.05 * SR)] if len(idx) else x


# one-shots: the same chain as an episode (the effect, then the effects reverb)
for name in SFX_NAMES:
    x = np.zeros(int(8 * SR))
    put(x, 0, SFX[name](1.0))
    x = trim(reverb(x, 1.6, .18))
    write(os.path.join(out, 'sfx', f'{name}.wav'), x / max(1e-6, np.abs(x).max()) * .9)
    print('sfx', name, round(len(x) / SR, 2), 's')

# music: one mood for LOOP_S seconds, the score's reverb, and the reverb tail folded onto the start so the loop is seamless
for mood in MOODS:
    ns['music'][:] = 0
    section(0, LOOP_S, mood, 1.0)
    m = reverb(ns['music'].copy(), 2.2, .22)
    loop = m[:LOOP_S * SR].copy()
    tail = m[LOOP_S * SR:(LOOP_S + 4) * SR]
    loop[:len(tail)] += tail
    write(os.path.join(out, 'music', f'{mood}.wav'), loop / max(1e-6, np.abs(loop).max()) * .9)
    print('music', mood)
