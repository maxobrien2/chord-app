import { analyzeKey } from './analyzer.js';

// ─── Accepted MIME types & extensions ────────────────────────────────────────

const ACCEPTED_TYPES = new Set([
  'audio/wav', 'audio/x-wav',
  'audio/flac', 'audio/x-flac',
  'audio/aiff', 'audio/x-aiff',
  'audio/mpeg', 'audio/mp3',
]);

const ACCEPTED_EXTS = new Set(['.wav', '.flac', '.aiff', '.aif', '.mp3']);

function isAccepted(file) {
  if (ACCEPTED_TYPES.has(file.type)) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return ACCEPTED_EXTS.has(ext);
}

// ─── DOM references ───────────────────────────────────────────────────────────

const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const browseBtn    = document.getElementById('browse-btn');
const dropPrompt   = document.getElementById('drop-prompt');
const loadingView  = document.getElementById('loading-view');
const resultView   = document.getElementById('result-view');
const errorView    = document.getElementById('error-view');
const progressBar  = document.getElementById('progress-bar');
const keyDisplay   = document.getElementById('key-display');
const scaleDisplay = document.getElementById('scale-display');
const confDisplay  = document.getElementById('confidence-display');
const confBar      = document.getElementById('confidence-bar');
const confFill     = document.getElementById('confidence-fill');
const fileName     = document.getElementById('file-name');
const resetBtn     = document.getElementById('reset-btn');
const errorMsg     = document.getElementById('error-msg');
const errorReset   = document.getElementById('error-reset');

// ─── State machine ────────────────────────────────────────────────────────────

// States: idle | loading | result | error
let state = 'idle';

function setState(next) {
  state = next;
  dropPrompt.classList.toggle('hidden', next !== 'idle');
  loadingView.classList.toggle('hidden', next !== 'loading');
  resultView.classList.toggle('hidden', next !== 'result');
  errorView.classList.toggle('hidden', next !== 'error');
}

// ─── Progress helper ──────────────────────────────────────────────────────────

function setProgress(value) {
  progressBar.style.width = `${Math.round(value * 100)}%`;
}

// ─── Main analysis flow ───────────────────────────────────────────────────────

async function processFile(file) {
  if (!isAccepted(file)) {
    showError('Unsupported file type.\nAccepted: WAV, FLAC, AIFF, MP3');
    return;
  }

  setState('loading');
  setProgress(0);
  fileName.textContent = file.name;

  try {
    const result = await analyzeKey(file, (p) => setProgress(p));
    showResult(result, file.name);
  } catch (err) {
    console.error(err);
    showError('Could not decode audio.\nPlease try a different file.');
  }
}

function showResult({ key, scale, confidence }, name) {
  keyDisplay.textContent   = key;
  scaleDisplay.textContent = scale;

  // Animate confidence bar
  confFill.style.width = '0%';
  confDisplay.textContent = `${confidence}%`;

  // Colour the confidence bar based on value
  if (confidence >= 70) {
    confFill.style.background = 'var(--accent-green)';
  } else if (confidence >= 40) {
    confFill.style.background = 'var(--accent-yellow)';
  } else {
    confFill.style.background = 'var(--accent-red)';
  }

  setState('result');

  // Defer bar animation until after layout
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      confFill.style.width = `${confidence}%`;
    });
  });
}

function showError(msg) {
  errorMsg.textContent = msg;
  setState('error');
}

// ─── Drag-and-drop ────────────────────────────────────────────────────────────

dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (state !== 'idle') return;
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (state !== 'idle') return;
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

// ─── Click to browse ──────────────────────────────────────────────────────────

browseBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) processFile(file);
  fileInput.value = ''; // reset so same file can be re-selected
});

// Allow clicking anywhere in drop zone (idle state) to open picker
dropZone.addEventListener('click', (e) => {
  if (state !== 'idle') return;
  if (e.target === browseBtn) return;
  fileInput.click();
});

// ─── Reset ────────────────────────────────────────────────────────────────────

function reset() {
  setProgress(0);
  confFill.style.width = '0%';
  setState('idle');
}

resetBtn.addEventListener('click', reset);
errorReset.addEventListener('click', reset);

// ─── Init ─────────────────────────────────────────────────────────────────────

setState('idle');
