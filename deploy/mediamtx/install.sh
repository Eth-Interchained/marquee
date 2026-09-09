#!/usr/bin/env bash
#
# One command to stand up marquee's ingest server.
#
#   bash install.sh
#
# What it does, in your home directory, with no root and no /etc footprint:
#   1. downloads the mediamtx binary for this machine (skipped if present)
#   2. writes ~/marquee-ingest/mediamtx.yml from the repo config, with your
#      public IP filled into webrtcAdditionalHosts and a generated publisher
#      password — the two things that are wrong by default and silently break
#      the stream (an empty webrtcAdditionalHosts gives you a perfect 201 and
#      then an ICE timeout)
#   3. creates ~/.config/marquee/fanout.env (0600) if absent, for RTMP keys
#   4. starts it in a tmux session called `marquee-ingest`
#   5. VERIFIES it: reads its own API, and refuses to claim success otherwise
#   6. prints exactly what to type into the Studio
#
# Re-running is safe. It never overwrites an existing password or fanout.env.
#
set -euo pipefail

VERSION="${MEDIAMTX_VERSION:-1.21.0}"
DIR="${MARQUEE_INGEST_DIR:-$HOME/marquee-ingest}"
SESSION="marquee-ingest"
FANOUT_ENV="$HOME/.config/marquee/fanout.env"
API="http://127.0.0.1:9997"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. what are we on ───────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "Unsupported OS $(uname -s). Grab the binary yourself from https://github.com/bluenviron/mediamtx/releases and use mediamtx.yml from this directory." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU $(uname -m)." ;;
esac

command -v tmux >/dev/null || die "tmux is not installed. apt install tmux (or brew install tmux), then re-run."
command -v curl >/dev/null || die "curl is not installed."
command -v ffmpeg >/dev/null || warn "ffmpeg is not on PATH — RTMP fan-out will refuse until it is (apt install ffmpeg). Streaming to viewers still works."

mkdir -p "$DIR"

# ── 1. the binary ───────────────────────────────────────────────────────────
if [[ -x "$DIR/mediamtx" ]]; then
  say "mediamtx already present ($("$DIR/mediamtx" --version 2>/dev/null | head -1))"
else
  TARBALL="mediamtx_v${VERSION}_${OS}_${ARCH}.tar.gz"
  URL="https://github.com/bluenviron/mediamtx/releases/download/v${VERSION}/${TARBALL}"
  say "downloading $TARBALL"
  curl -fsSL --retry 3 -o "$DIR/$TARBALL" "$URL" || die "download failed: $URL"
  tar xzf "$DIR/$TARBALL" -C "$DIR" mediamtx || die "could not unpack $TARBALL"
  rm -f "$DIR/$TARBALL"
  chmod +x "$DIR/mediamtx"
  say "installed $("$DIR/mediamtx" --version 2>/dev/null | head -1)"
fi

# ── 2. the config, with the two values that must not be left at defaults ────
PUBLIC_IP="${MARQUEE_PUBLIC_IP:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  # Several sources, because one being down should not stop an install.
  for probe in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    PUBLIC_IP="$(curl -fsS --max-time 5 "$probe" 2>/dev/null | tr -d '[:space:]')" || PUBLIC_IP=""
    [[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && break
    PUBLIC_IP=""
  done
fi
[[ -n "$PUBLIC_IP" ]] || die "Could not determine this machine's public IP. Re-run with MARQUEE_PUBLIC_IP=<ip> — WebRTC cannot work without it in the config."
say "public IP: $PUBLIC_IP"

if [[ -f "$DIR/mediamtx.yml" ]] && grep -q "^authInternalUsers:" "$DIR/mediamtx.yml"; then
  PUBLISH_PASS="$(awk '/user: marquee/{found=1} found && /pass:/{print $2; exit}' "$DIR/mediamtx.yml")"
  say "keeping the existing config and publisher password"
else
  [[ -f "$HERE/mediamtx.yml" ]] || die "mediamtx.yml is not next to this script ($HERE). Run it from the repo's deploy/mediamtx directory."
  PUBLISH_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  cp "$HERE/mediamtx.yml" "$DIR/mediamtx.yml"
  cp "$HERE/fanout.py" "$DIR/fanout.py"
  chmod +x "$DIR/fanout.py"
  # The three placeholders the committed config deliberately ships with.
  #  - the password, which must never live in git
  #  - webrtcAdditionalHosts, empty by default -> 201 then ICE timeout
  #  - the absolute fanout.py path, which is per-machine
  python3 - "$DIR/mediamtx.yml" "$PUBLISH_PASS" "$PUBLIC_IP" "$DIR/fanout.py" <<'PY'
import sys, pathlib
path, password, ip, fanout = sys.argv[1:5]
p = pathlib.Path(path); text = p.read_text()
subs = [
    ("change-me-before-going-live", password),
    ("webrtcAdditionalHosts: []", f"webrtcAdditionalHosts: ['{ip}']"),
    ("/home/CHANGE-ME/mediamtx/fanout.py", fanout),
]
for needle, value in subs:
    if needle not in text:
        sys.exit(f"install.sh: expected placeholder {needle!r} not found in {path} — config drifted, fix it by hand")
    text = text.replace(needle, value)
p.write_text(text)
PY
  chmod 600 "$DIR/mediamtx.yml"
  say "wrote $DIR/mediamtx.yml (0600) with your IP and a generated password"
fi

# ── 3. fan-out keys, never overwritten ──────────────────────────────────────
mkdir -p "$(dirname "$FANOUT_ENV")"; chmod 700 "$(dirname "$FANOUT_ENV")"
if [[ -f "$FANOUT_ENV" ]]; then
  say "keeping $FANOUT_ENV"
else
  cat > "$FANOUT_ENV" <<'EOF'
# marquee RTMP fan-out. One line per destination, the FULL url including the key.
# Uncomment and fill the ones you use, then restart the ingest server.
# FANOUT_TWITCH=rtmp://live.twitch.tv/app/live_xxxxxxxx
# FANOUT_YOUTUBE=rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx
# FANOUT_KICK=rtmps://xxxx.global-contribute.live-video.net:443/app/sk_xxx
FANOUT_PATHS=marquee/*
EOF
  chmod 600 "$FANOUT_ENV"
  say "created $FANOUT_ENV (0600) — put your stream keys there, nowhere else"
fi

# ── 4. run it ───────────────────────────────────────────────────────────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  say "restarting the existing tmux session"
  tmux kill-session -t "$SESSION"
  sleep 1
fi
tmux new-session -d -s "$SESSION" -c "$DIR" "./mediamtx ./mediamtx.yml"
say "started in tmux session '$SESSION'  (attach: tmux attach -t $SESSION)"

# ── 5. verify, do not assume ────────────────────────────────────────────────
for _ in $(seq 1 20); do
  sleep 0.5
  if curl -fsS --max-time 2 "$API/v3/paths/list" >/dev/null 2>&1; then READY=1; break; fi
done
if [[ "${READY:-}" != "1" ]]; then
  warn "mediamtx did not answer its API on $API within 10s. Its log:"
  tmux capture-pane -p -t "$SESSION" | tail -20 >&2
  die "not verified — fix the above before pointing the Studio at it."
fi
say "verified: the API answers and the listeners are up"
tmux capture-pane -p -t "$SESSION" | grep -E "listener|listeners" | sed 's/^/    /' || true

# ── 6. what to do with it ───────────────────────────────────────────────────
HOSTNAME_HINT="${MARQUEE_INGEST_HOST:-https://live.ne-db.com}"
cat <<EOF

$(printf '\033[32m✓ ingest is up\033[0m')

In marquee → Studio → Go Live:
    Ingest host        $HOSTNAME_HINT
    Path               marquee/<your handle>
    Publisher user     marquee
    Publisher password $PUBLISH_PASS

Viewers watch at:
    $HOSTNAME_HINT:8888/marquee/<your handle>/index.m3u8      (HLS)
    $HOSTNAME_HINT:8889/marquee/<your handle>                 (WebRTC, low latency)

Still needs doing OUTSIDE this script — it cannot do these for you:
  · open the firewall: TCP 8889 (WHIP/WHEP), TCP 8888 (HLS), UDP 8189 (ICE media)
  · point $HOSTNAME_HINT at $PUBLIC_IP on a GREY-CLOUD DNS record.
    WebRTC media cannot ride Cloudflare's proxy — orange cloud gives you a
    clean handshake and then silence.

  tmux attach -t $SESSION     watch it
  bash install.sh             re-run safely (keeps your password and keys)
EOF
