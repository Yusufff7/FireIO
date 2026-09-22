// Standalone reproduction of restartAt()'s new bracketing-interpolation
// convergence loop, run against the real findClusters output for
// /tmp/apoth.mkv (via debug_one), to sanity-check it actually converges
// faster / more reliably than the old single-average extrapolation before
// trusting the TS change enough to spend a device build on it.
const { execFileSync } = require('child_process');

const DEBUG_ONE = '/work/MkvDemuxModule/test/build/debug_one';
const FILE = '/tmp/apoth.mkv';
const LOCAL_SIZE = 52428800;
const FULL_FILE_SIZE = 328419790;
const DURATION = 1370.07;
const INIT_SEGMENT_END = 12477850;
const SEEK_PROBE_CHUNK = 2 * 1024 * 1024;
const MAX_ITER = 6;
const TOLERANCE = 4;

function probeAt(offset, size = SEEK_PROBE_CHUNK) {
  const clamped = Math.max(INIT_SEGMENT_END, Math.floor(offset));
  if (clamped + size > LOCAL_SIZE) return { offSlice: true };
  const out = execFileSync(DEBUG_ONE, [FILE, String(clamped), String(size)], { encoding: 'utf8' });
  const m = out.match(/\{"clusters":\[(.*)\]\}/);
  if (!m || m[1].trim() === '') return undefined;
  const first = m[1].split('},{')[0];
  const offM = /"offset":(\d+)/.exec(first);
  const tcM = /"timecode":(\d+)/.exec(first);
  if (!offM || !tcM) return undefined;
  return { offset: Number(offM[1]), timecodeSec: Number(tcM[1]) / 1000 };
}

function estimateByteOffset(target) {
  const span = FULL_FILE_SIZE - INIT_SEGMENT_END;
  const frac = Math.max(0, Math.min(1, target / DURATION));
  return Math.round(INIT_SEGMENT_END + frac * span);
}

function convergeBracket(target) {
  let lowOffset = INIT_SEGMENT_END,
    lowSec = 0;
  let highOffset = FULL_FILE_SIZE,
    highSec = DURATION;
  let estOffset = estimateByteOffset(target);
  const trail = [];
  for (let i = 0; i < MAX_ITER; i++) {
    let probe = probeAt(estOffset);
    if (probe && probe.offSlice) return { trail, result: 'off-slice' };
    if (!probe) {
      probe = probeAt(estOffset, SEEK_PROBE_CHUNK * 6);
      if (probe && probe.offSlice) return { trail, result: 'off-slice' };
      if (!probe) return { trail, result: 'gave-up (empty probe)' };
    }
    trail.push({ iter: i, estOffset, sec: probe.timecodeSec });
    const diff = target - probe.timecodeSec;
    if (Math.abs(diff) < TOLERANCE) return { trail, result: 'CONVERGED', landedSec: probe.timecodeSec };
    if (probe.timecodeSec <= target) {
      lowOffset = probe.offset;
      lowSec = probe.timecodeSec;
    } else {
      highOffset = probe.offset;
      highSec = probe.timecodeSec;
    }
    estOffset =
      highSec > lowSec ? Math.round(lowOffset + ((target - lowSec) * (highOffset - lowOffset)) / (highSec - lowSec)) : lowOffset;
    estOffset = Math.max(INIT_SEGMENT_END, Math.min(FULL_FILE_SIZE - 1, estOffset));
  }
  return { trail, result: 'gave-up (max iterations)' };
}

function convergeOldLinear(target) {
  let estOffset = estimateByteOffset(target);
  const trail = [];
  for (let i = 0; i < MAX_ITER; i++) {
    const probe = probeAt(estOffset);
    if (probe && probe.offSlice) return { trail, result: 'off-slice' };
    if (!probe) return { trail, result: 'gave-up (empty probe)' };
    trail.push({ iter: i, estOffset, sec: probe.timecodeSec });
    const diff = target - probe.timecodeSec;
    if (Math.abs(diff) < TOLERANCE) return { trail, result: 'CONVERGED', landedSec: probe.timecodeSec };
    const bytesPerSec = (FULL_FILE_SIZE - INIT_SEGMENT_END) / DURATION;
    estOffset = Math.max(INIT_SEGMENT_END, Math.min(FULL_FILE_SIZE - 1, estOffset + diff * bytesPerSec));
  }
  return { trail, result: 'gave-up (max iterations)' };
}

const targets = [5, 15, 30, 45, 60, 90, 120, 150, 180];
for (const t of targets) {
  const oldR = convergeOldLinear(t);
  const newR = convergeBracket(t);
  console.log(`target ${t}s:`);
  console.log(`  OLD (linear-avg):    ${oldR.result} in ${oldR.trail.length} probes` + (oldR.landedSec !== undefined ? ` -> landed ${oldR.landedSec.toFixed(2)}s` : ''));
  console.log(`  NEW (bracket-interp): ${newR.result} in ${newR.trail.length} probes` + (newR.landedSec !== undefined ? ` -> landed ${newR.landedSec.toFixed(2)}s` : ''));
}
