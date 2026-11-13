// Run: npm test
// Synthetic hands making signs through scripted timelines; checks which commands fire.
import assert from 'node:assert/strict';
import { createGestureEngine } from '../gestures.js';

const ASPECT = 16 / 9;
const DT = 1000 / 30;

// Hand geometry in palm units, display space (y down), wrist at (0, 0.5), knuckles above it.
const MCP = { index: [-0.3, -0.45], middle: [0, -0.5], ring: [0.25, -0.45], pinky: [0.45, -0.35] };
const add = ([x, y], [dx, dy], k = 1) => [x + dx * k, y + dy * k];
const ext = (mcp, dir = [0, -1]) => [mcp, add(mcp, dir, 0.4), add(mcp, dir, 0.65), add(mcp, dir, 0.85)];
const curl = (mcp) => [mcp, add(mcp, [0, -0.3]), add(mcp, [0, -0.1]), add(mcp, [0, 0.25])];
const THUMB_OPEN = [[-0.35, 0.3], [-0.6, 0.05], [-0.8, -0.15], [-0.95, -0.3]];
const THUMB_TUCKED = [[-0.35, 0.3], [-0.45, 0.1], [-0.3, -0.1], [-0.05, -0.15]];

const POSES = {
  open: () => [THUMB_OPEN, ext(MCP.index), ext(MCP.middle), ext(MCP.ring), ext(MCP.pinky)],
  fist: () => [THUMB_TUCKED, curl(MCP.index), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  thumbsUp: () => [[[-0.35, 0.3], [-0.5, -0.1], [-0.58, -0.6], [-0.62, -1.15]], curl(MCP.index), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  // a fist seen from the thumb side: the thumb lies straight up along the fist, but no higher than it
  fistThumbAlong: () => [[[-0.35, 0.3], [-0.45, 0.0], [-0.5, -0.4], [-0.52, -0.78]], curl(MCP.index), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  // thumbs-down: the thumbs-up hand turned upside down around the palm
  thumbsDown: () => POSES.thumbsUp().map((f) => f.map(([x, y]) => [-x, 2 * -0.1 - y])),
  right: () => [THUMB_TUCKED, ext(MCP.index, [1, 0]), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  left: () => [THUMB_TUCKED, ext(MCP.index, [-1, 0]), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  up: () => [THUMB_TUCKED, ext(MCP.index), curl(MCP.middle), curl(MCP.ring), curl(MCP.pinky)],
  ok: () => [
    [[-0.35, 0.3], [-0.55, 0.1], [-0.62, -0.15], [-0.58, -0.42]],
    [MCP.index, [-0.5, -0.7], [-0.62, -0.62], [-0.6, -0.45]],
    ext(MCP.middle), ext(MCP.ring), ext(MCP.pinky),
  ],
};

// Real tracking jitters: every landmark wobbles a little each frame. Without this the tests
// passed while a real hand never counted as "resting" (2026-11-11). Deterministic noise.
let seed = Number(process.env.SEED || 1);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const JITTER = 0.016; // in frame-height units: about ±4.5% of a palm length per coordinate

function hand(pose, { cx = 0.9, cy = 0.5, palm = 0.18, mirror = true, tilt = 0, jitter = JITTER } = {}) {
  const wrist = pose === 'thumbsDown' ? [0, -0.7] : [0, 0.5]; // flipped with the rest of the hand
  let pts = [wrist, ...POSES[pose]().flat()];
  if (tilt) {
    // turn the whole hand around the wrist (positive = clockwise on screen)
    const a = (tilt * Math.PI) / 180, [wx, wy] = wrist;
    pts = pts.map(([x, y]) => [wx + (x - wx) * Math.cos(a) - (y - wy) * Math.sin(a), wy + (x - wx) * Math.sin(a) + (y - wy) * Math.cos(a)]);
  }
  return pts.map(([x, y]) => {
    const nx = (cx + x * palm + rnd() * jitter) / ASPECT;
    return { x: mirror ? 1 - nx : nx, y: cy + y * palm + rnd() * jitter, z: 0 };
  });
}

// timeline: [[pose | null, ms, opts?], ...]
// Flick tests below describe the stroke as seen on screen ("flick right"), so they pin
// flickNext: 'right'. The shipped default is checked on its own.
function run(timeline, engineOpts = {}) {
  const opts = { aspect: ASPECT, flickNext: 'right', ...engineOpts };
  if (opts.flickNext === undefined) delete opts.flickNext; // use the shipped default
  const eng = createGestureEngine(opts);
  const commands = [];
  const statuses = [];
  let t = 0;
  for (const [pose, ms, o] of timeline) {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) {
      const opts = typeof o === 'function' ? o(i / Math.max(1, n - 1)) : o;
      const hands = pose ? [hand(pose, { mirror: engineOpts.mirror ?? true, ...opts })] : [];
      for (const e of eng.update({ t, hands })) {
        if (e.type === 'command') commands.push(e.name);
        if (e.type === 'status') statuses.push(e.status);
      }
      t += DT;
    }
  }
  return { commands, statuses };
}

const tests = {
  'shipped default: finger moving left-to-right (as the user sees it) is next': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })]], { flickNext: undefined });
    assert.deepEqual(r.commands, ['next']);
  },
  'flick right -> next': () => {
    assert.deepEqual(run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.18 * 1.1 * u })]]).commands, ['next']);
  },
  'flick left -> previous': () => {
    assert.deepEqual(run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 - 0.18 * 1.1 * u })]]).commands, ['previous']);
  },
  'flick from a fixed wrist (finger swings 70°) -> next': () => {
    assert.deepEqual(run([['up', 300, { tilt: -35 }], ['up', 150, (u) => ({ tilt: -35 + 70 * u })]]).commands, ['next']);
  },
  'finger swinging back after a flick is not "previous"': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 150, (u) => ({ cx: 1.1 - 0.2 * u })], ['up', 600]]);
    assert.deepEqual(r.commands, ['next']);
  },
  'two flicks right, half a second apart -> next twice': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 350, { cx: 1.1 }], ['up', 150, (u) => ({ cx: 1.1 + 0.2 * u })]]);
    assert.deepEqual(r.commands, ['next', 'next']);
  },
  'flick right, pause, flick back left on purpose -> next, previous': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 900, { cx: 1.1 }], ['up', 150, (u) => ({ cx: 1.1 - 0.2 * u })]]);
    assert.deepEqual(r.commands, ['next', 'previous']);
  },
  'slow stroke right, then a fast snap back left -> never "previous"': () => {
    const r = run([['up', 300], ['up', 1000, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 150, (u) => ({ cx: 1.1 - 0.2 * u })]]);
    assert.ok(!r.commands.includes('previous'), r.commands.join(','));
  },
  'finger raised already moving (no rest) -> nothing': () => {
    assert.deepEqual(run([[null, 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })]]).commands, []);
  },
  'flipping 3 pages: right, back, right, back, right -> next ×3': () => {
    const R = (from) => ['up', 150, (u) => ({ cx: from + 0.2 * u })];
    const back = (from) => ['up', 200, (u) => ({ cx: from - 0.2 * u })];
    const r = run([['up', 300], R(0.9), back(1.1), R(0.9), back(1.1), R(0.9)]);
    assert.deepEqual(r.commands, ['next', 'next', 'next']);
  },
  'slow way back (no rest) is still not "previous"': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 280, (u) => ({ cx: 1.1 - 0.2 * u })], ['up', 300]]);
    assert.deepEqual(r.commands, ['next']);
  },
  'long after a flick, either direction counts': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })], ['up', 100, { cx: 1.1 }], ['up', 2200, (u) => ({ cx: 1.1 + 0.002 * Math.sin(u * 40) })], ['up', 150, (u) => ({ cx: 1.1 - 0.2 * u })]]);
    assert.deepEqual(r.commands, ['next', 'previous']);
  },
  'mirroring: flicking right on screen is next either way': () => {
    const tl = [['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })]];
    assert.deepEqual(run(tl, { mirror: true }).commands, ['next']);
    assert.deepEqual(run(tl, { mirror: false }).commands, ['next']);
  },
  'flicks switched off (choosing a chapter) do nothing': () => {
    const r = run([['up', 300], ['up', 150, (u) => ({ cx: 0.9 + 0.2 * u })]], { flicks: false });
    assert.deepEqual(r.commands, []);
  },
  'pointing finger held still does nothing': () => {
    assert.deepEqual(run([['up', 2000], ['right', 2000]]).commands, []);
  },
  'slow drag of the finger does nothing': () => {
    assert.deepEqual(run([['up', 300], ['up', 1200, (u) => ({ cx: 0.9 + 0.3 * u })]]).commands, []);
  },
  'vertical flick does nothing': () => {
    assert.deepEqual(run([['up', 300], ['up', 150, (u) => ({ cy: 0.5 - 0.2 * u })]]).commands, []);
  },
  'open hand swiping across does nothing': () => {
    assert.deepEqual(run([['open', 300], ['open', 150, (u) => ({ cx: 0.9 + 0.3 * u })]]).commands, []);
  },
  'fist moving fast does nothing': () => {
    assert.deepEqual(run([['fist', 200], ['fist', 150, (u) => ({ cx: 0.9 + 0.3 * u })]]).commands, []);
  },
  'open hand held -> pause, held 3s still once': () => {
    assert.deepEqual(run([['open', 3000]]).commands, ['togglePlay']);
  },
  'open hand, drop hand, open hand -> pause then play': () => {
    assert.deepEqual(run([['open', 1000], [null, 400], ['open', 1000]]).commands, ['togglePlay', 'togglePlay']);
  },
  'brief open hand (400ms) does nothing': () => {
    assert.deepEqual(run([['open', 400], [null, 500]]).commands, []);
  },
  'fist does nothing any more': () => {
    assert.deepEqual(run([['fist', 2000]]).commands, []);
  },
  'fist with the thumb along its side is not a thumbs-up (Arnon, live test)': () => {
    assert.deepEqual(run([['fistThumbAlong', 2000]]).commands, []);
  },
  'thumbs-up is not a fist': () => {
    assert.ok(!run([['thumbsUp', 1500]]).commands.includes('togglePlay'));
  },
  'thumbs-up held -> volume up, repeating': () => {
    const c = run([['thumbsUp', 1500]]).commands;
    assert.ok(c.length >= 3 && c.every((x) => x === 'volumeUp'), c.join(','));
  },
  'thumbs-down held -> volume down, repeating': () => {
    const c = run([['thumbsDown', 1500]]).commands;
    assert.ok(c.length >= 3 && c.every((x) => x === 'volumeDown'), c.join(','));
  },
  'quick thumbs-up (300ms) does nothing': () => {
    assert.deepEqual(run([['thumbsUp', 300], [null, 400]]).commands, []);
  },
  'volume stops the moment the thumb goes away': () => {
    const a = run([['thumbsUp', 1000]]).commands.length;
    const b = run([['thumbsUp', 1000], [null, 1000]]).commands.length;
    assert.ok(b <= a + 1, `${a} vs ${b}`); // at most one more step while the new sign settles (~100ms)
  },
  'OK sign -> legend': () => {
    assert.deepEqual(run([['ok', 700]]).commands, ['legend']);
  },
  'one flickered frame mid-hold does not restart or double-fire': () => {
    assert.deepEqual(run([['open', 300], ['fist', 33], ['open', 900]]).commands, ['togglePlay']);
  },
  'short tracking dropout mid-hold is tolerated': () => {
    assert.deepEqual(run([['open', 400], [null, 120], ['open', 500]]).commands, ['togglePlay']);
  },
  'hand lost mid-hold does nothing': () => {
    assert.deepEqual(run([['open', 400], [null, 600]]).commands, []);
  },
  'far-away hand does nothing and reports far': () => {
    const r = run([['up', 300, { palm: 0.05 }], ['up', 150, (u) => ({ palm: 0.05, cx: 0.9 + 0.2 * u })], ['open', 1500, { palm: 0.05 }]]);
    assert.deepEqual(r.commands, []);
    assert.ok(r.statuses.includes('far'));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message.split('\n').join('\n        ')); }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
