/**
 * marquee — audio mixer.
 *
 * Mixes N MediaStream audio sources (mic, screen/tab audio, later: alert
 * sounds) into one output MediaStream with per-source gain and a live
 * level meter. The output track is what goes into the broadcast stream.
 *
 * Browser reality, stated plainly: system/game audio via getDisplayMedia is
 * Chrome-tab/window audio only on macOS; whole-screen audio capture is
 * Windows/ChromeOS only. We surface that in the UI instead of pretending.
 */

export interface MixerSource {
  id: string;
  label: string;
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  muted: boolean;
}

export class Mixer {
  readonly ctx: AudioContext;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly master: GainNode;
  private readonly sources = new Map<string, MixerSource>();

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.master = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.master.connect(this.dest);
  }

  /** The mixed output — attach its audio track to the broadcast MediaStream. */
  get output(): MediaStream {
    return this.dest.stream;
  }

  /** Add a source; streams with no audio track are rejected loudly, not silently. */
  add(id: string, label: string, stream: MediaStream, gain = 1): MixerSource {
    if (stream.getAudioTracks().length === 0) {
      throw new Error(`[mixer] "${label}" has no audio track — nothing to mix (source id ${id})`);
    }
    this.remove(id);
    const node = this.ctx.createMediaStreamSource(stream);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    node.connect(g);
    g.connect(analyser);
    g.connect(this.master);
    const src: MixerSource = { id, label, stream, node, gain: g, analyser, muted: false };
    this.sources.set(id, src);
    return src;
  }

  remove(id: string): void {
    const s = this.sources.get(id);
    if (!s) return;
    s.node.disconnect();
    s.gain.disconnect();
    s.analyser.disconnect();
    this.sources.delete(id);
  }

  setGain(id: string, value: number): void {
    const s = this.sources.get(id);
    if (!s) throw new Error(`[mixer] setGain: unknown source ${id}`);
    s.gain.gain.value = s.muted ? 0 : value;
  }

  setMuted(id: string, muted: boolean, restoreGain = 1): void {
    const s = this.sources.get(id);
    if (!s) throw new Error(`[mixer] setMuted: unknown source ${id}`);
    s.muted = muted;
    s.gain.gain.value = muted ? 0 : restoreGain;
  }

  /** RMS level 0..1 for a source, for meters. */
  level(id: string): number {
    const s = this.sources.get(id);
    if (!s) return 0;
    const buf = new Uint8Array(s.analyser.fftSize);
    s.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const c = (v - 128) / 128;
      sum += c * c;
    }
    return Math.sqrt(sum / buf.length);
  }

  list(): MixerSource[] {
    return [...this.sources.values()];
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  async close(): Promise<void> {
    for (const id of [...this.sources.keys()]) this.remove(id);
    await this.ctx.close();
  }
}

/** Pure helper used by both the mixer UI and tests: dB → linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear gain → dB (floor at -60 so silence has a number). */
export function gainToDb(g: number): number {
  if (g <= 0) return -60;
  return Math.max(-60, 20 * Math.log10(g));
}
