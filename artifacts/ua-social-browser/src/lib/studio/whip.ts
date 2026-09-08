/**
 * WHIP publisher — the Studio's one upstream.
 *
 * WHIP (WebRTC-HTTP Ingestion Protocol, RFC 9725) is three HTTP calls around a
 * WebRTC session: POST an SDP offer, receive an SDP answer plus a `Location`
 * for the session, DELETE that location to stop. mediamtx on the VPS speaks it
 * natively and fans out to RTMP/HLS from there, so the creator's machine sends
 * ONE stream and the server does the rest.
 *
 * Every failure names itself: HTTP status and body from the server, the ICE
 * state that broke, the missing Location. Nothing here retries silently — a
 * stream that "reconnects" without telling the operator is a stream that
 * dropped frames without telling the operator.
 */

export type WhipState =
  | { kind: 'idle' }
  | { kind: 'connecting'; detail: string }
  | { kind: 'live'; since: number; sessionUrl: string; ice: string }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; message: string; raw?: string };

/**
 * How the publisher proves it may publish.
 * - `basic`: mediamtx's `authMethod: internal` — user + password. A bare Bearer
 *   password is NOT accepted there (verified: 401 vs Basic's pass-through).
 * - `bearer`: JWT deployments (`authMethod: jwt`) or any server that takes a token.
 */
export type WhipAuth = { kind: 'basic'; user: string; pass: string } | { kind: 'bearer'; token: string } | { kind: 'none' };

/** Pure; tested. Builds the Authorization header value, or null for none. */
export function authorizationHeader(auth: WhipAuth | undefined): string | null {
  if (!auth || auth.kind === 'none') return null;
  if (auth.kind === 'bearer') return auth.token ? `Bearer ${auth.token}` : null;
  const raw = `${auth.user}:${auth.pass}`;
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(raw))) : Buffer.from(raw, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

export type WhipOptions = {
  /** e.g. https://live.example.com/whip/<path>  (mediamtx: http(s)://host:8889/<path>/whip) */
  endpoint: string;
  auth?: WhipAuth;
  /** Extra ICE servers (TURN) for creators behind hostile NAT. */
  iceServers?: RTCIceServer[];
  /** Target video bitrate in bits/s; applied via sender parameters when supported. */
  maxVideoBitrate?: number;
  onState?: (state: WhipState) => void;
};

/** Resolve the session URL from a WHIP POST response (RFC 9725 §4.2). Pure; tested. */
export function resolveSessionUrl(endpoint: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, endpoint).toString();
  } catch {
    return null;
  }
}

/**
 * Prefer the codecs mediamtx transcodes/relays most predictably (H264 for
 * RTMP fan-out; Opus). Pure SDP munging kept minimal and tested: it only
 * reorders payload types in the m= line, never rewrites attributes.
 */
export function preferCodec(sdp: string, kind: 'video' | 'audio', codec: string): string {
  const lines = sdp.split(/\r?\n/);
  const mIndex = lines.findIndex((l) => l.startsWith(`m=${kind} `));
  if (mIndex === -1) return sdp;
  const wanted = new Set<string>();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
    if (m && m[2].toLowerCase() === codec.toLowerCase()) wanted.add(m[1]);
  }
  if (wanted.size === 0) return sdp;
  const parts = lines[mIndex].split(' ');
  const header = parts.slice(0, 3);
  const pts = parts.slice(3);
  const reordered = [...pts.filter((p) => wanted.has(p)), ...pts.filter((p) => !wanted.has(p))];
  lines[mIndex] = [...header, ...reordered].join(' ');
  return lines.join('\r\n');
}

export class WhipPublisher {
  private pc: RTCPeerConnection | null = null;
  private sessionUrl: string | null = null;
  private state: WhipState = { kind: 'idle' };
  private readonly opts: WhipOptions;

  constructor(opts: WhipOptions) {
    this.opts = opts;
  }

  getState(): WhipState {
    return this.state;
  }

  private setState(next: WhipState): void {
    this.state = next;
    this.opts.onState?.(next);
  }

  /** Publish the given tracks. Resolves when the server answered and ICE connected. */
  async start(stream: MediaStream): Promise<void> {
    if (this.pc) throw new Error('WhipPublisher.start: already started; call stop() first.');
    const video = stream.getVideoTracks()[0];
    if (!video) throw new Error('WhipPublisher.start: the stream has no video track — nothing to publish.');

    this.setState({ kind: 'connecting', detail: 'creating peer connection' });
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? [], bundlePolicy: 'max-bundle' });
    this.pc = pc;

    for (const track of stream.getTracks()) {
      const sender = pc.addTransceiver(track, { direction: 'sendonly' }).sender;
      if (track.kind === 'video' && this.opts.maxVideoBitrate) {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = this.opts.maxVideoBitrate;
        try {
          await sender.setParameters(params);
        } catch (error) {
          console.warn('[whip] setParameters(maxBitrate) not honoured:', error);
        }
      }
    }

    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState;
      if (this.state.kind === 'live') {
        if (ice === 'failed' || ice === 'disconnected' || ice === 'closed') {
          this.setState({ kind: 'error', message: `ICE ${ice} — the connection to the ingest server dropped. Stop and go live again.` });
        } else {
          this.setState({ ...this.state, ice });
        }
      }
    };

    const offer = await pc.createOffer();
    let sdp = offer.sdp ?? '';
    sdp = preferCodec(sdp, 'video', 'H264');
    sdp = preferCodec(sdp, 'audio', 'opus');
    await pc.setLocalDescription({ type: 'offer', sdp });

    // Gather ICE before posting: WHIP servers answer once; late trickle is
    // optional and mediamtx does fine with a complete offer.
    await waitForIceGathering(pc, 2000);
    this.setState({ kind: 'connecting', detail: `posting offer to ${this.opts.endpoint}` });

    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    const authz = authorizationHeader(this.opts.auth);
    if (authz) headers.Authorization = authz;
    let response: Response;
    try {
      response = await fetch(this.opts.endpoint, { method: 'POST', headers, body: pc.localDescription?.sdp ?? sdp });
    } catch (error) {
      this.teardown();
      const message = `Could not reach the WHIP endpoint ${this.opts.endpoint}: ${error instanceof Error ? error.message : String(error)}`;
      this.setState({ kind: 'error', message });
      throw new Error(message);
    }
    if (response.status !== 201) {
      const body = await response.text().catch(() => '');
      this.teardown();
      const hint =
        response.status === 401
          ? ' — the ingest server refused the credentials. For mediamtx internal auth use Basic (user + password), not a bare Bearer token.'
          : response.status === 404
            ? ' — no such path on the ingest server; check the path segment of the endpoint.'
            : '';
      const message = `WHIP endpoint answered HTTP ${response.status} instead of 201 Created${hint}${body ? `: ${body.slice(0, 300)}` : ''}`;
      this.setState({ kind: 'error', message, raw: body });
      throw new Error(message);
    }
    const location = resolveSessionUrl(this.opts.endpoint, response.headers.get('Location'));
    const answer = await response.text();
    if (!answer.startsWith('v=0')) {
      this.teardown();
      const message = 'WHIP endpoint returned 201 but no SDP answer in the body.';
      this.setState({ kind: 'error', message, raw: answer.slice(0, 300) });
      throw new Error(message);
    }
    if (!location) {
      console.warn('[whip] server sent no Location header; stop() will not be able to DELETE the session.');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.sessionUrl = location;

    this.setState({ kind: 'connecting', detail: 'waiting for ICE to connect' });
    await waitForIceConnected(pc, 10_000);
    this.setState({ kind: 'live', since: Date.now(), sessionUrl: location ?? '(no Location header)', ice: pc.iceConnectionState });
  }

  /** Ends the session: DELETE the WHIP resource, close the peer connection. */
  async stop(reason = 'stopped by operator'): Promise<void> {
    const url = this.sessionUrl;
    this.teardown();
    if (url) {
      try {
        const headers: Record<string, string> = {};
        const authz = authorizationHeader(this.opts.auth);
        if (authz) headers.Authorization = authz;
        const r = await fetch(url, { method: 'DELETE', headers });
        if (!r.ok && r.status !== 404) console.warn(`[whip] DELETE ${url} answered HTTP ${r.status}`);
      } catch (error) {
        console.warn('[whip] DELETE failed (session may linger until the server times it out):', error);
      }
    }
    this.setState({ kind: 'ended', reason });
  }

  private teardown(): void {
    const pc = this.pc;
    this.pc = null;
    this.sessionUrl = null;
    if (pc) {
      pc.oniceconnectionstatechange = null;
      for (const s of pc.getSenders()) {
        try {
          pc.removeTrack(s);
        } catch {
          /* closed */
        }
      }
      pc.close();
    }
  }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve(); // proceed with what we have; WHIP allows it
    }, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function waitForIceConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  const ok = (s: RTCIceConnectionState) => s === 'connected' || s === 'completed';
  if (ok(pc.iceConnectionState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('iceconnectionstatechange', check);
      reject(new Error(`ICE did not connect within ${timeoutMs / 1000}s (state: ${pc.iceConnectionState}). The ingest server's UDP port may be unreachable — WebRTC media cannot ride Cloudflare's proxy; use a direct host or TURN.`));
    }, timeoutMs);
    const check = () => {
      if (ok(pc.iceConnectionState)) {
        clearTimeout(timer);
        pc.removeEventListener('iceconnectionstatechange', check);
        resolve();
      } else if (pc.iceConnectionState === 'failed') {
        clearTimeout(timer);
        pc.removeEventListener('iceconnectionstatechange', check);
        reject(new Error('ICE failed — no route to the ingest server.'));
      }
    };
    pc.addEventListener('iceconnectionstatechange', check);
  });
}

/** Viewer URLs mediamtx exposes for a path, given its public host. Pure; tested. */
export function viewerUrls(publicBase: string, path: string): { hls: string; webrtc: string } {
  const base = publicBase.replace(/\/+$/, '');
  const p = path.replace(/^\/+|\/+$/g, '');
  return {
    hls: `${base}:8888/${p}/index.m3u8`,
    webrtc: `${base}:8889/${p}`,
  };
}
