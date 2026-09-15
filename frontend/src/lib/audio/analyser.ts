export type LiveAnalyser = {
  analyser: AnalyserNode;
  /** 0–1 overall loudness for this instant, cheap to poll every animation frame. */
  getLevel(): number;
  /** Raw frequency-bin snapshot (0–255 per bin), for richer visualizations. */
  getFrequencyData(): Uint8Array;
  close(): void;
};

function getAudioCtx(): typeof AudioContext {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

function wrapAnalyser(audioCtx: AudioContext, analyser: AnalyserNode, onClose: () => void): LiveAnalyser {
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  return {
    analyser,
    getLevel() {
      analyser.getByteFrequencyData(freqData);
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i]!;
      return sum / freqData.length / 255;
    },
    getFrequencyData() {
      analyser.getByteFrequencyData(freqData);
      return freqData;
    },
    close() {
      onClose();
      analyser.disconnect();
      void audioCtx.close();
    },
  };
}

/** Wires a live mic stream into an AnalyserNode for real-time, audio-reactive visuals. */
export function createLiveAnalyser(stream: MediaStream, fftSize = 128): LiveAnalyser {
  const AudioCtx = getAudioCtx();
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  return wrapAnalyser(audioCtx, analyser, () => source.disconnect());
}

/**
 * Wires an <audio> element's own playback (a TTS clip, a preview sample) into an AnalyserNode so
 * a visual can react to it — routes the signal back to the speakers too, playback is unaffected.
 */
export function attachAnalyserToElement(audio: HTMLAudioElement, fftSize = 128): LiveAnalyser | null {
  try {
    const AudioCtx = getAudioCtx();
    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaElementSource(audio);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    return wrapAnalyser(audioCtx, analyser, () => source.disconnect());
  } catch {
    // Web Audio unavailable, or this element is already wired to a context — the audio still
    // plays fine without a reactive visual.
    return null;
  }
}
