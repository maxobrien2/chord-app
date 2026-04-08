/**
 * Audio Key Detection Engine
 *
 * Pipeline:
 *  1. Decode audio via Web Audio API
 *  2. Mix to mono, trim to first 90 seconds
 *  3. Frame audio, apply Hann window, run radix-2 FFT
 *  4. Accumulate a 12-bin chromagram across all frames
 *  5. Apply Krumhansl–Schmuckler key profiles via Pearson correlation
 *  6. Return best key + confidence score (0–100)
 */

// ─── Key profile templates (Krumhansl–Schmuckler) ───────────────────────────

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ─── FFT (Cooley–Tukey radix-2, in-place) ───────────────────────────────────

function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wRe = Math.cos((2 * Math.PI) / len);
    const wIm = -Math.sin((2 * Math.PI) / len);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ─── Hann window ─────────────────────────────────────────────────────────────

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

// ─── Frequency → pitch class ──────────────────────────────────────────────────

function freqToPitchClass(freq) {
  if (freq <= 0) return -1;
  // MIDI note number relative to A4 = 440 Hz
  const midi = 69 + 12 * Math.log2(freq / 440);
  return ((Math.round(midi) % 12) + 12) % 12;
}

// ─── Pearson correlation ──────────────────────────────────────────────────────

function pearson(a, b) {
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den < 1e-10 ? 0 : num / den;
}

// ─── Main analysis function ───────────────────────────────────────────────────

/**
 * Analyzes an audio File and resolves with { key, scale, confidence }.
 * @param {File} file
 * @param {function} onProgress  optional callback(0–1)
 * @returns {Promise<{key: string, scale: string, confidence: number}>}
 */
export async function analyzeKey(file, onProgress) {
  // 1. Decode audio
  onProgress?.(0.05);
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(0.15);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }
  onProgress?.(0.30);

  // 2. Mix to mono
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const maxSamples = Math.min(audioBuffer.length, sampleRate * 90);
  const mono = new Float32Array(maxSamples);

  for (let ch = 0; ch < numChannels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < maxSamples; i++) mono[i] += chData[i];
  }
  for (let i = 0; i < maxSamples; i++) mono[i] /= numChannels;
  onProgress?.(0.40);

  // 3. Build chromagram via FFT
  const FRAME_SIZE = 4096; // ~185 ms at 22050 Hz
  const HOP_SIZE   = 2048;
  const hann = hannWindow(FRAME_SIZE);
  const chroma = new Float32Array(12);

  const totalFrames = Math.floor((maxSamples - FRAME_SIZE) / HOP_SIZE) + 1;
  let processedFrames = 0;

  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);

  for (let start = 0; start + FRAME_SIZE <= maxSamples; start += HOP_SIZE) {
    // Apply Hann window
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = mono[start + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);

    // Accumulate pitch-class energy (only positive frequencies up to Nyquist)
    const binToFreq = sampleRate / FRAME_SIZE;
    const nyquistBin = FRAME_SIZE >> 1;
    for (let bin = 1; bin < nyquistBin; bin++) {
      const freq = bin * binToFreq;
      if (freq < 27.5 || freq > 4186) continue; // piano range A0–C8
      const pc = freqToPitchClass(freq);
      if (pc < 0) continue;
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      chroma[pc] += power;
    }

    processedFrames++;
    if (processedFrames % 50 === 0) {
      onProgress?.(0.40 + 0.50 * (processedFrames / totalFrames));
    }
  }

  onProgress?.(0.90);

  // 4. L1-normalise chroma
  let chromaSum = 0;
  for (let i = 0; i < 12; i++) chromaSum += chroma[i];
  if (chromaSum > 0) for (let i = 0; i < 12; i++) chroma[i] /= chromaSum;

  // 5. Krumhansl–Schmuckler: correlate rotated chroma against each key profile
  const scores = [];
  for (let root = 0; root < 12; root++) {
    // Rotate chroma so 'root' aligns with index 0
    const rotated = new Float32Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + root) % 12];

    const majCorr = pearson(rotated, MAJOR_PROFILE);
    const minCorr = pearson(rotated, MINOR_PROFILE);
    scores.push({ root, scale: 'Major', corr: majCorr });
    scores.push({ root, scale: 'Minor', corr: minCorr });
  }

  scores.sort((a, b) => b.corr - a.corr);
  const best   = scores[0];
  const second = scores[1];

  // Confidence: how decisively the top key wins over the runner-up
  // Map the correlation gap to 0–100 range with some scaling
  const gap = best.corr - second.corr;
  const confidence = Math.round(Math.min(100, Math.max(5, gap * 400)));

  onProgress?.(1.0);

  return {
    key:        NOTE_NAMES[best.root],
    scale:      best.scale,
    confidence,
  };
}
