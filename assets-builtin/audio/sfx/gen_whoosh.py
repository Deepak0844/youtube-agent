#!/usr/bin/env python3
"""Makes the four whoosh clips: white noise passed through a narrow band whose centre glides across the clip, with a smooth
swell. No third-party material. Usage: gen_whoosh.py <out dir>  (wav files; the catalog entries are mp3s made from them).
Deterministic (fixed seeds)."""
import sys, numpy as np, scipy.signal as sg, scipy.io.wavfile as wf

SR = 44100
# id: (seconds, start Hz, end Hz, band width in octaves, peak position 0..1, seed)
VOICES = {
    "whoosh-soft": (0.75, 500, 2600, 0.55, 0.45, 11),
    "whoosh-soft-2": (0.85, 350, 2000, 0.65, 0.40, 23),
    "whoosh-wind": (1.25, 300, 1300, 0.80, 0.50, 5),
    "whoosh-reverse": (0.95, 2800, 450, 0.55, 0.78, 31),
}

def make(dur, f0, f1, bw, peak, seed):
    n = int(SR * dur)
    x = np.random.default_rng(seed).standard_normal(n)
    fr, t, S = sg.stft(x, SR, nperseg=1024, noverlap=768)
    pos = np.clip(t / dur, 0, 1)
    fc = np.exp(np.log(f0) + (np.log(f1) - np.log(f0)) * (pos ** 1.3))  # glide, a little faster toward the end
    lf = np.log(np.maximum(fr, 20.0))[:, None]
    gain = np.exp(-0.5 * ((lf - np.log(fc)[None, :]) / (bw * np.log(2))) ** 2)
    _, y = sg.istft(S * gain, SR, nperseg=1024, noverlap=768)
    y = y[:n]
    p = np.arange(len(y)) / n
    env = np.where(p < peak, np.sin(0.5 * np.pi * p / peak) ** 2, np.cos(0.5 * np.pi * (p - peak) / (1 - peak)) ** 2)
    y = y * env
    return (y / (np.abs(y).max() + 1e-9) * 0.9).astype(np.float32)

if __name__ == "__main__":
    out = sys.argv[1]
    for name, v in VOICES.items():
        wf.write(f"{out}/{name}.wav", SR, make(*v))
        print(name)
