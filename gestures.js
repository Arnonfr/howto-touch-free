// Touch-free gesture recognizer. Pure logic: no DOM, no camera.
// Feed it hand landmarks per frame, get events back.
//
//   flick the index finger  -> next / previous (which way is `flickNext`, see below)
//   open hand, all five fingers spread         -> play / pause
//   OK sign      (thumb + index ring)           -> show the gesture guide
//   thumbs up / thumbs down                     -> volume up / down, repeating while held
//
// A flick is a quick sideways move of the fingertip that starts from a pointing hand (index out,
// other fingers folded). The pointing shape is the filter: cooking hands rarely hold one finger
// out.
//
// Which movement is the flick and which is the hand coming back? The one that starts from rest.
//   - the first flick of a run must start from a resting finger (`flickRestMs`), so a fast
//     snap-back after a slow stroke is never read as a flick the other way;
//   - flipping several pages (flick right, come back, flick right) continues the run: same
//     direction within `flickMemoryMs` needs only `flickCooldownMs`;
//   - against the last flick, the finger must rest first, so the way back is ignored.
//
// The other signs are static: each fires once after it has been held for a moment. It can't fire again until the hand
// has made a different sign (or left) for `releaseMs`, so a hand left in place never repeats.
// The volume signs are the exception: held, they keep stepping every `volumeRepeatMs`.
// Left/right follow what the user sees on screen (the preview is mirrored by default).

export const DEFAULTS = {
  mirror: true,          // preview is mirrored: left/right follow what the user sees
  aspect: 16 / 9,        // camera frame width / height
  minPalm: 0.08,         // palm length as a fraction of frame height; below = too far
  flicks: true,          // off while the finger is choosing a chapter on the timeline
  // which stroke (as seen on the mirrored screen) means "next". 'right' = the finger moving
  // left-to-right from the user's point of view. It was flipped to 'left' once after a live test
  // and that made one direction dead and the other reversed (Arnon, 2026-11-10), so back to
  // 'right'. The likely cause of the first report was the snap-back after a slow stroke being
  // read as a flick: now the first flick of a run needs the finger to rest before it.
  flickNext: 'right',
  flickDist: 0.6,        // fingertip travel, in palm lengths
  flickWindowMs: 300,    // ...within this time
  flickMinRatio: 1.5,    // |dx| / |dy|
  flickCooldownMs: 300,  // between two flicks the same way (flipping several pages)
  flickRestMs: 250,      // a flick against the last one needs the finger to rest this long first
  flickMemoryMs: 2000,   // ...but only this soon after the last flick
  restRadius: 0.18,      // resting = the fingertip stayed within this many palm lengths for flickRestMs.
                         // A circle, not a speed: real tracking jitters every frame, and a
                         // per-frame speed test never saw a real finger as resting (2026-11-11).
  restDrift: 0.1,        // ...and its averaged start and end are this close (no slow steady move)
  okTouch: 0.35,         // thumb tip to index tip, in palm lengths, for the OK sign
  holdOpen: 700,
  holdOk: 400,
  holdVolume: 450,
  thumbClear: 0.25,      // a thumbs-up/down tip must clear the folded fingers by this much
  volumeRepeatMs: 300,
  showAfter: 100,        // ms before the hold ring appears (avoids flicker)
  settleFrames: 3,       // a new sign must be seen this many frames in a row
  releaseMs: 250,
  gapMs: 200,            // tracking dropouts tolerated
};

export const ACTIONS = {
  open: 'togglePlay',
  ok: 'legend',
  'thumbs-up': 'volumeUp',
  'thumbs-down': 'volumeDown',
};
const HOLD = {
  open: 'holdOpen', ok: 'holdOk',
  'thumbs-up': 'holdVolume', 'thumbs-down': 'holdVolume',
};
const REPEATS = new Set(['thumbs-up', 'thumbs-down']);

// landmark indices: [mcp, pip, tip]
const INDEX = [5, 6, 8], MIDDLE = [9, 10, 12], RING = [13, 14, 16], PINKY = [17, 18, 20];

export function readHand(landmarks, cfg) {
  const P = (i) => {
    const l = landmarks[i];
    return { x: (cfg.mirror ? 1 - l.x : l.x) * cfg.aspect, y: l.y };
  };
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wrist = P(0);
  const palm = d(wrist, P(9));
  const extended = ([m, p, t]) => {
    const mcp = P(m), pip = P(p), tip = P(t);
    return d(tip, mcp) > 1.5 * d(pip, mcp) && d(wrist, tip) > d(wrist, pip);
  };

  const idx = extended(INDEX);
  const others = [MIDDLE, RING, PINKY].filter(extended).length;
  const thumbTip = P(4);

  let pose = 'other';
  if (d(thumbTip, P(8)) < cfg.okTouch * palm && others >= 2) {
    pose = 'ok';
  } else if (idx && others === 0) {
    pose = 'point'; // any direction: flicks are judged by how the fingertip moves
  } else if (!idx && others === 0) {
    // fingers folded into the palm: a fist, unless the thumb sticks straight up or down
    const center = P(9);
    const tipsIn = [8, 12, 16, 20].every((i) => d(P(i), center) < 1.0 * palm);
    const thumbLen = d(P(1), P(2)) + d(P(2), P(3)) + d(P(3), thumbTip);
    const thumbStraight = d(P(1), thumbTip) > 0.9 * thumbLen;
    const tv = { x: thumbTip.x - P(2).x, y: thumbTip.y - P(2).y };
    const vertical = Math.abs(tv.y) > 1.2 * Math.abs(tv.x);
    const dir = Math.sign(tv.y); // -1 up, +1 down
    // A real thumbs-up sticks out clear of the whole fist. A thumb lying along the side of a fist
    // can be straight and vertical too (that read as volume up), but it never rises above the
    // folded fingers, so: the tip must pass every finger point by `thumbClear` palm lengths.
    const fingerYs = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((i) => P(i).y);
    const clear = dir < 0 ? Math.min(...fingerYs) - thumbTip.y : thumbTip.y - Math.max(...fingerYs);
    if (tipsIn && thumbStraight && vertical && clear > cfg.thumbClear * palm) pose = dir < 0 ? 'thumbs-up' : 'thumbs-down';
    else if (tipsIn) pose = 'fist';
  } else if (idx && others === 3) {
    // a full open hand: all four fingers and the thumb out
    const thumbLen = d(P(1), P(2)) + d(P(2), P(3)) + d(P(3), thumbTip);
    const thumbOut = d(P(1), thumbTip) > 0.85 * thumbLen && d(thumbTip, P(5)) > 0.5 * palm;
    pose = thumbOut ? 'open' : 'other';
  }

  const tip = P(8);
  return { pose, palm, far: palm < cfg.minPalm, x: wrist.x, y: wrist.y, tipX: tip.x, tipY: tip.y };
}

export function createGestureEngine(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  let status = null;
  let lastSeen = null;
  let pose = null;          // the settled sign
  let poseSince = 0;
  let pending = null;       // { pose, n } a sign waiting to settle
  let latched = null;       // sign that already fired and must be let go first
  let lastFire = 0;         // for the repeating volume signs
  let trail = [];           // recent fingertip samples, for flicks
  let lastFlick = null;     // { t, dir }
  let hist = [];            // fingertip samples for the last second, to judge resting
  let shown = { progress: 0, action: null };
  let debug = {};

  function pick(hands) {
    const reads = hands.map((lm, which) => ({ ...readHand(lm, cfg), which }));
    const signing = reads.filter((r) => (ACTIONS[r.pose] || r.pose === 'point') && !r.far);
    return (signing.length ? signing : reads).sort((a, b) => b.palm - a.palm)[0];
  }

  // Did the fingertip rest just before this stroke? Looks for a span of `flickRestMs` where it
  // stayed inside a `restRadius` circle, ending no earlier than shortly before the stroke window,
  // and starting after the last flick (so the moment a flick ends is never a "rest").
  function restedBefore(t, palm) {
    const earliestEnd = t - cfg.flickWindowMs - 150;
    for (let j = hist.length - 1; j >= 0 && hist[j].t >= earliestEnd; j--) {
      const end = hist[j];
      let k = j, ok = true;
      while (k > 0 && hist[k - 1].t >= end.t - cfg.flickRestMs) {
        k--;
        if (Math.hypot(hist[k].x - end.x, hist[k].y - end.y) / palm > cfg.restRadius) { ok = false; break; }
      }
      if (!ok || hist[k].t > end.t - cfg.flickRestMs * 0.8) continue; // moving, or not long enough
      if (lastFlick && hist[k].t <= lastFlick.t) continue;
      // a slow, steady move can stay inside the circle; averaging the first and last few
      // samples cancels jitter but not drift
      const span = hist.slice(k, j + 1), n = Math.max(1, Math.floor(span.length / 3));
      const avg = (a) => ({ x: a.reduce((m, h) => m + h.x, 0) / a.length, y: a.reduce((m, h) => m + h.y, 0) / a.length });
      const a = avg(span.slice(0, n)), b = avg(span.slice(-n));
      if (Math.hypot(b.x - a.x, b.y - a.y) / palm > cfg.restDrift) continue;
      return true;
    }
    return false;
  }

  function update({ t, hands }) {
    const events = [];
    const setStatus = (s) => {
      if (s !== status) { status = s; events.push({ type: 'status', status: s }); }
    };
    const showHold = (progress, action = null) => {
      if (progress !== shown.progress || action !== shown.action) {
        shown = { progress, action };
        events.push({ type: 'hold', progress, action });
      }
    };
    const settle = (p) => {
      if (p === pose) { pending = null; return; }
      pending = pending && pending.pose === p ? { pose: p, n: pending.n + 1 } : { pose: p, n: 1 };
      if (pending.n >= cfg.settleFrames) {
        pose = p;
        poseSince = t;
        pending = null;
      }
    };

    const r = hands && hands.length ? pick(hands) : null;

    if (!r) {
      if (lastSeen != null && t - lastSeen <= cfg.gapMs) return events;
      pose = null; pending = null; latched = null; trail = []; hist = [];
      showHold(0);
      setStatus('searching');
      debug = { hand: false };
      return events;
    }
    lastSeen = t;
    debug = { hand: true, ...r };

    if (r.far) {
      pose = null; pending = null; latched = null; trail = [];
      showHold(0);
      setStatus('far');
      return events;
    }
    setStatus('ready');
    settle(r.pose);
    debug.settled = pose;

    /* ---- flick: fingertip sweeps sideways, starting from a pointing hand ---- */
    const last = trail[trail.length - 1];
    if (last && Math.hypot(r.tipX - last.x, r.tipY - last.y) / r.palm / Math.max(1, t - last.t) > 0.05) {
      trail = []; hist = []; // faster than a finger can move: the tracker jumped to the other hand
    }
    hist.push({ t, x: r.tipX, y: r.tipY });
    while (hist.length && t - hist[0].t > 1000) hist.shift();
    trail.push({ t, x: r.tipX, y: r.tipY, palm: r.palm, pointing: r.pose === 'point' });
    while (trail.length && t - trail[0].t > cfg.flickWindowMs) trail.shift();
    for (const s of cfg.flicks ? trail : []) {
      if (!s.pointing) continue;
      const dx = (r.tipX - s.x) / s.palm;
      const dy = (r.tipY - s.y) / s.palm;
      if (Math.abs(dx) < cfg.flickDist || Math.abs(dx) < cfg.flickMinRatio * Math.abs(dy)) continue;
      const dir = dx > 0 ? 'right' : 'left';
      trail = [];
      const since = lastFlick ? t - lastFlick.t : Infinity;
      const rested = restedBefore(t, s.palm);
      let reason = null;
      if (lastFlick && since < cfg.flickMemoryMs) {
        if (dir === lastFlick.dir && since < cfg.flickCooldownMs) reason = 'too soon';
        else if (dir !== lastFlick.dir && !rested) reason = 'finger coming back';
      } else if (!rested) {
        reason = 'no rest before it (snap-back?)';
      }
      if (!reason) {
        lastFlick = { t, dir };
        showHold(0);
        events.push({ type: 'command', name: dir === cfg.flickNext ? 'next' : 'previous', pose: 'flick', dir });
      } else {
        events.push({ type: 'ignored', reason, dir });
      }
      return events;
    }

    // a fired sign stays locked until the hand has shown something else for a moment
    if (latched && pose !== latched && t - poseSince >= cfg.releaseMs) latched = null;

    const action = ACTIONS[pose];
    if (action && latched === pose && REPEATS.has(pose)) {
      // volume: keep stepping while the thumb stays up/down
      if (t - lastFire >= cfg.volumeRepeatMs) {
        lastFire = t;
        events.push({ type: 'command', name: action, pose, repeat: true });
      }
      return events;
    }
    if (!action || latched === pose) { showHold(0); return events; }

    const held = t - poseSince;
    const need = cfg[HOLD[pose]];
    if (held < cfg.showAfter) { showHold(0); return events; }
    const progress = Math.min(1, held / need);
    if (progress < 1) { showHold(progress, action); return events; }

    latched = pose;
    lastFire = t;
    showHold(0);
    events.push({ type: 'command', name: action, pose });
    return events;
  }

  return {
    update,
    reset() {
      status = null; lastSeen = null; pose = null; pending = null; latched = null;
      trail = []; lastFlick = null; hist = [];
      shown = { progress: 0, action: null };
    },
    get config() { return cfg; },
    get debug() { return debug; },
  };
}
