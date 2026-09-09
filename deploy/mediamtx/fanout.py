#!/usr/bin/env python3
"""
RTMP fan-out for the Studio's Go Live — one ffmpeg, many destinations.

mediamtx runs this on `runOnReady` for every `marquee/*` path. It reads the
stream back from mediamtx over loopback RTSP and pushes it, WITHOUT
re-encoding (`-c copy`), to every destination configured in an env file, using
ffmpeg's `tee` muxer so the source is read once.

Stream keys live in the env file on the VPS, owner-readable, and nowhere else:
not in mediamtx.yml (which is committed), not in the Studio (which is a page).

Env file (default ~/.config/marquee/fanout.env, override FANOUT_ENV):

    # one line per destination; the value is the FULL rtmp(s) URL incl. key
    FANOUT_TWITCH=rtmp://live.twitch.tv/app/live_xxxxxxxx
    FANOUT_YOUTUBE=rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx
    FANOUT_KICK=rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/sk_us-west-2_xxx
    # optional: only these paths fan out (glob); default = every marquee/* path
    FANOUT_PATHS=marquee/*

Usage (from mediamtx.yml):
    runOnReady: python3 /home/you/mediamtx/fanout.py $MTX_PATH
    runOnReadyRestart: yes

    python3 fanout.py marquee/me --print      # show the ffmpeg argv, do not run

Every refusal names itself on stderr: no env file, no destinations, a path
outside FANOUT_PATHS, ffmpeg missing.

"Nothing to do" PARKS instead of exiting: with `runOnAvailableRestart: yes`
mediamtx re-runs the command on ANY exit, so an early exit 0 becomes a
five-second log loop for every idle path (seen live). The script says why once
and then sleeps until mediamtx ends it when the path goes away. `--print` mode
still exits immediately so it stays scriptable/testable.
"""

from __future__ import annotations

import fnmatch
import os
import shutil
import sys
from pathlib import Path

DEFAULT_ENV = Path(os.environ.get("FANOUT_ENV") or Path.home() / ".config" / "marquee" / "fanout.env")
RTSP_BASE = os.environ.get("FANOUT_RTSP_BASE", "rtsp://127.0.0.1:8554")


def parse_env(text: str) -> dict[str, str]:
    """KEY=VALUE per line; `#` comments; blank lines ignored; quotes stripped."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def destinations(env: dict[str, str]) -> list[tuple[str, str]]:
    """(name, url) for every FANOUT_<NAME> that is an rtmp(s) URL, stable order."""
    found: list[tuple[str, str]] = []
    for key in sorted(env):
        if not key.startswith("FANOUT_") or key in ("FANOUT_PATHS", "FANOUT_ENV", "FANOUT_RTSP_BASE"):
            continue
        url = env[key]
        if not url:
            continue
        if not (url.startswith("rtmp://") or url.startswith("rtmps://")):
            sys.stderr.write(f"fanout: ignoring {key}: not an rtmp:// or rtmps:// URL\n")
            continue
        found.append((key[len("FANOUT_"):].lower(), url))
    return found


def path_allowed(path: str, env: dict[str, str]) -> bool:
    patterns = [p.strip() for p in (env.get("FANOUT_PATHS") or "marquee/*").split(",") if p.strip()]
    return any(fnmatch.fnmatchcase(path, p) for p in patterns)


def tee_target(dests: list[tuple[str, str]]) -> str:
    """ffmpeg tee muxer spec: each output is [f=flv:onfail=ignore]url, joined by |.

    `onfail=ignore` keeps the other platforms up when one rejects the key —
    a dead Twitch key must not take YouTube down with it.
    """
    return "|".join(f"[f=flv:onfail=ignore]{url}" for _, url in dests)


def build_argv(path: str, dests: list[tuple[str, str]], ffmpeg: str = "ffmpeg", rtsp_base: str = RTSP_BASE) -> list[str]:
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "warning",
        "-rtsp_transport", "tcp",
        "-i", f"{rtsp_base.rstrip('/')}/{path}",
        # No re-encode: the Studio already sends H264/opus. Platforms want AAC,
        # so audio alone is transcoded; video passes through untouched.
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-map", "0:v:0", "-map", "0:a:0?",
        "-flags", "+global_header",
        "-f", "tee",
        tee_target(dests),
    ]


def redact(argv: list[str]) -> list[str]:
    """For logs: hide everything after the last `/` of each rtmp URL (the key)."""
    out = []
    for a in argv:
        if "rtmp" in a:
            parts = a.split("|")
            parts = [p.rsplit("/", 1)[0] + "/<key>" if "/" in p else p for p in parts]
            a = "|".join(parts)
        out.append(a)
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write("usage: fanout.py <mediamtx path> [--print]\n")
        return 2
    path = argv[1]
    dry = "--print" in argv[2:]

    def park(reason: str) -> int:
        sys.stderr.write(f"fanout: {reason}\n")
        if dry:
            return 0
        # Hold the slot so mediamtx does not restart-loop; it kills us when the
        # path goes away. `exec` so there is no Python parent lingering.
        sys.stderr.flush()
        os.execvp("sleep", ["sleep", "infinity"])
        return 0  # unreachable

    if not DEFAULT_ENV.exists():
        return park(f"no destinations file at {DEFAULT_ENV}; nothing to fan out for {path} (parked)")
    env = parse_env(DEFAULT_ENV.read_text())
    if not path_allowed(path, env):
        return park(f"{path} is outside FANOUT_PATHS={env.get('FANOUT_PATHS') or 'marquee/*'}; skipping (parked)")
    dests = destinations(env)
    if not dests:
        return park(f"{DEFAULT_ENV} defines no FANOUT_<NAME>=rtmp(s)://... destinations; nothing to do for {path} (parked)")

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    cmd = build_argv(path, dests, ffmpeg)
    sys.stderr.write(f"fanout: {path} -> {', '.join(n for n, _ in dests)}\n")
    if dry:
        print(" ".join(redact(cmd)))
        return 0
    if not shutil.which("ffmpeg"):
        sys.stderr.write("fanout: ffmpeg is not on PATH; install it (apt install ffmpeg) — fan-out cannot run\n")
        return 1
    os.execvp(cmd[0], cmd)
    return 1  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv))
