#!/usr/bin/env python3
"""
Re-render the spoken regatta cues using the Gemini TTS API.

Usage:
    GEMINI_API_KEY=... python3 tools/gen_audio.py [--voice Kore] [--model ...]

Outputs MP3s into ./audio/, replacing existing files. Requires `ffmpeg` on PATH.
The API key is read from the environment and is never written to disk.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


PHRASES: dict[str, str] = {
    "minute_6": "Six minutes.",
    "minute_5": "Five minutes.",
    "minute_4": "Four minutes.",
    "minute_3": "Three minutes.",
    "minute_2": "Two minutes.",
    "minute_1": "One minute.",
    "sec_10":   "Ten.",
    "sec_9":    "Nine.",
    "sec_8":    "Eight.",
    "sec_7":    "Seven.",
    "sec_6":    "Six.",
    "sec_5":    "Five.",
    "sec_4":    "Four.",
    "sec_3":    "Three.",
    "sec_2":    "Two.",
    "sec_1":    "One.",
    "go":       "Read with enthusiasm and emphasis, like a starter at a race: Race started!",
    "sync":     "Sync.",
}

DEFAULT_MODEL = "gemini-3.1-flash-tts-preview"
DEFAULT_VOICE = "Kore"
LOUDNORM_FILTER = (
    "loudnorm=I=-14:LRA=7:TP=-2,"
    "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,"
    "silenceremove=stop_periods=-1:stop_silence=0.1:stop_threshold=-50dB:detection=peak"
)


def synthesize(text: str, *, api_key: str, model: str, voice: str) -> tuple[bytes, int]:
    """Return (raw PCM s16le bytes, sample_rate_hz) from Gemini TTS."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}
            },
        },
    }

    for attempt in range(5):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read())
                break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                # try to honour the server's RetryInfo, else exponential backoff
                err_body = e.read().decode("utf-8", errors="replace")
                wait = 20 * (attempt + 1)
                try:
                    parsed = json.loads(err_body)
                    for d in parsed.get("error", {}).get("details", []):
                        delay = d.get("retryDelay")
                        if delay and delay.endswith("s"):
                            wait = max(wait, int(float(delay[:-1])) + 2)
                except Exception:
                    pass
                print(f" [429 — retry in {wait}s]", end="", flush=True)
                time.sleep(wait)
                continue
            sys.exit(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}")
    else:
        sys.exit("Exhausted retries on 429")

    cand = payload["candidates"][0]
    part = cand["content"]["parts"][0]
    inline = part["inlineData"]
    audio = base64.b64decode(inline["data"])
    mime = inline.get("mimeType", "audio/L16;rate=24000")
    rate = 24000
    for kv in mime.split(";"):
        if "=" in kv:
            k, v = kv.split("=", 1)
            if k.strip() == "rate":
                rate = int(v)
    return audio, rate


def encode_mp3(pcm: bytes, rate: int, dest: str) -> None:
    """PCM s16le -> normalized mono 22 kHz 64 kbps MP3."""
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as tf:
        tf.write(pcm)
        raw = tf.name
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", raw,
                "-af", LOUDNORM_FILTER,
                "-ac", "1", "-ar", "22050", "-b:a", "64k",
                dest,
            ],
            check=True,
        )
    finally:
        os.unlink(raw)


# Cues placed at these track-time offsets (seconds) in the master file.
# Race-start mark is at 360s; the track runs slightly longer so "Race
# started!" finishes after that.
MASTER_LAYOUT: list[tuple[str, float]] = [
    ("minute_6",   0),
    ("minute_5",  60),
    ("minute_4", 120),
    ("minute_3", 180),
    ("minute_2", 240),
    ("minute_1", 300),
    ("sec_10",   350),
    ("sec_9",    351),
    ("sec_8",    352),
    ("sec_7",    353),
    ("sec_6",    354),
    ("sec_5",    355),
    ("sec_4",    356),
    ("sec_3",    357),
    ("sec_2",    358),
    ("sec_1",    359),
    ("go",       360),
]


def build_master(audio_dir: str) -> None:
    """Mix the per-cue MP3s into one continuous master track."""
    inputs: list[str] = []
    for name, _ in MASTER_LAYOUT:
        src = os.path.join(audio_dir, f"{name}.mp3")
        if not os.path.exists(src):
            sys.exit(f"missing cue {src} — generate it first")
        inputs += ["-i", src]

    chains = []
    labels = []
    for i, (_, offset_s) in enumerate(MASTER_LAYOUT):
        ms = int(offset_s * 1000)
        chains.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
        labels.append(f"[a{i}]")
    filtergraph = ";".join(chains) + ";" + "".join(labels) + \
        f"amix=inputs={len(MASTER_LAYOUT)}:duration=longest:normalize=0"

    dest = os.path.join(audio_dir, "master.mp3")
    print(f"  building master.mp3 from {len(MASTER_LAYOUT)} cues", flush=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         *inputs,
         "-filter_complex", filtergraph,
         "-ac", "1", "-ar", "22050", "-b:a", "64k",
         dest],
        check=True,
    )
    print(f"  -> {os.path.getsize(dest)} bytes")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--voice", default=DEFAULT_VOICE)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--only", nargs="*", help="generate only these keys")
    p.add_argument("--out", default="audio")
    p.add_argument("--throttle", type=float, default=7.0,
                   help="seconds to sleep between API calls (Gemini TTS free tier is 10 req/min)")
    p.add_argument("--master-only", action="store_true",
                   help="skip TTS regeneration; just rebuild master.mp3 from existing cues")
    p.add_argument("--no-master", action="store_true",
                   help="generate cues but skip the master rebuild")
    args = p.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")

    if not args.master_only:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            sys.exit("GEMINI_API_KEY not set")
        os.makedirs(args.out, exist_ok=True)
        targets = {k: PHRASES[k] for k in (args.only or PHRASES) if k in PHRASES}
        items = list(targets.items())
        for i, (name, text) in enumerate(items):
            dest = os.path.join(args.out, f"{name}.mp3")
            print(f"  {name:<10} {text!r}", end=" ", flush=True)
            pcm, rate = synthesize(text, api_key=api_key, model=args.model, voice=args.voice)
            encode_mp3(pcm, rate, dest)
            size = os.path.getsize(dest)
            print(f"-> {size} bytes")
            if args.throttle > 0 and i < len(items) - 1:
                time.sleep(args.throttle)

    if not args.no_master:
        build_master(args.out)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
