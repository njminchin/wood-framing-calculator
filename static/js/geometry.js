// Pure geometry for the floating frame. All lengths in mm, angles in degrees
// unless a name says otherwise.
//
// Coordinate system (frame plane, as seen from the FRONT of the painting):
//   x to the right, y up, z towards the viewer. The back of the frame is z = 0.
//
// Painting corners are indexed counter-clockwise:
//   0 = BL (bottom-left), 1 = BR, 2 = TR, 3 = TL
// Edge i runs from corner i to corner i+1:
//   0 = bottom, 1 = right, 2 = top, 3 = left

const DEG = Math.PI / 180;
const TAPE_TOLERANCE = 0.01; // degrees: close enough that the acute preference doesn't matter

export const CORNERS = [
  { key: 'BL', name: 'Bottom-left' },
  { key: 'BR', name: 'Bottom-right' },
  { key: 'TR', name: 'Top-right' },
  { key: 'TL', name: 'Top-left' },
];

export const SIDES = [
  { key: 'bottom', name: 'Bottom' },
  { key: 'right', name: 'Right' },
  { key: 'top', name: 'Top' },
  { key: 'left', name: 'Left' },
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const dist = (a, b) => len(sub(a, b));
const norm = (a) => mul(a, 1 / len(a));

function area(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return s / 2;
}

function isConvexCCW(pts) {
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    if (cross(sub(b, a), sub(c, b)) <= 0) return false;
  }
  return true;
}

// Interior angle at each corner (degrees).
export function interiorAngles(pts) {
  return pts.map((p, i) => {
    const prev = pts[(i + 3) % 4], next = pts[(i + 1) % 4];
    const a = norm(sub(prev, p)), b = norm(sub(next, p));
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / DEG;
  });
}

// Build the quadrilateral for a given interior angle (radians) at BL.
function quadForAlpha(T, B, L, R, alpha) {
  const BL = [0, 0], BR = [B, 0], TL = [L * Math.cos(alpha), L * Math.sin(alpha)];
  const d = sub(TL, BR);
  const dl = len(d);
  if (dl > R + T || dl < Math.abs(R - T) || dl === 0) return null;
  const a = (R * R - T * T + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, R * R - a * a));
  const m = add(BR, mul(d, a / dl));
  const c1 = [m[0] + (h * d[1]) / dl, m[1] - (h * d[0]) / dl];
  const c2 = [m[0] - (h * d[1]) / dl, m[1] + (h * d[0]) / dl];
  // TR lies on the opposite side of the BR->TL diagonal from BL.
  const TR = cross(d, sub(c1, BR)) < 0 ? c1 : c2;
  const pts = [BL, BR, TR, TL];
  return isConvexCCW(pts) ? pts : null;
}

/**
 * Four side lengths alone don't fix a quadrilateral's shape (it can "rack").
 * - If one or both diagonals are given, the shape that best matches them is used.
 * - Otherwise the maximum-area shape is used (the cyclic quadrilateral). For a
 *   rectangle-ish canvas this is the "most square" shape: a true rectangle when
 *   opposite sides match, an isosceles trapezoid when only one pair differs.
 */
export function solveQuad({ top: T, bottom: B, left: L, right: R, diagA, diagB }) {
  const hasA = diagA > 0, hasB = diagB > 0; // A: BL->TR, B: TL->BR
  const score = (pts) => {
    if (!hasA && !hasB) return -area(pts);
    let e = 0;
    if (hasA) e += (dist(pts[0], pts[2]) - diagA) ** 2;
    if (hasB) e += (dist(pts[3], pts[1]) - diagB) ** 2;
    return e;
  };
  const f = (alpha) => {
    const pts = quadForAlpha(T, B, L, R, alpha);
    return pts ? score(pts) : Infinity;
  };

  // Coarse scan then golden-section refinement.
  let best = null, bestS = Infinity;
  const lo = 20 * DEG, hi = 160 * DEG, step = 0.05 * DEG;
  for (let a = lo; a <= hi; a += step) {
    const s = f(a);
    if (s < bestS) { bestS = s; best = a; }
  }
  if (best === null) return null;
  let a = best - step, b = best + step;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); }
  }
  const alpha = f1 < f2 ? x1 : x2;
  let pts = quadForAlpha(T, B, L, R, alpha) || quadForAlpha(T, B, L, R, best);
  if (!pts) return null;

  // Centre on the centroid of the corners.
  const c = mul(pts.reduce((s, p) => add(s, p), [0, 0]), 1 / 4);
  pts = pts.map((p) => sub(p, c));

  return {
    pts,
    angles: interiorAngles(pts),
    diagA: dist(pts[0], pts[2]),
    diagB: dist(pts[3], pts[1]),
    method: hasA || hasB ? 'diagonals' : 'max-area',
    diagResidual: hasA || hasB ? Math.sqrt(score(pts)) : 0,
  };
}

// Outward unit normal of each edge (polygon is CCW, so outward = right-hand normal).
function edgeNormals(pts) {
  return pts.map((p, i) => {
    const d = norm(sub(pts[(i + 1) % 4], p));
    return [d[1], -d[0]];
  });
}

// Polygon whose edges are each pushed outward by distance d (negative = inward).
export function offsetPolygon(pts, d) {
  const n = edgeNormals(pts);
  return pts.map((p, i) => {
    const n0 = n[(i + 3) % 4], n1 = n[i];
    const k = d / (1 + dot(n0, n1));
    return add(p, mul(add(n0, n1), k));
  });
}

/**
 * Which face of the L rides the 45° fence:
 *   'outer'     - outer face of the good wood (long-point side)
 *   'goodInner' - inner face of the good wood; the L lies upside down with the
 *                 good wood's front edge on the sled and the cheap wood above the fence
 *   'inner'     - inner edge of the cheap wood
 * Only whether it is on the outer or inner side of the profile matters for the angles.
 */
export const FENCE_FACES = {
  outer: { label: 'Good wood - outer face', short: 'Good wood outer face', side: 'operator' },
  goodInner: { label: 'Good wood - inner face (L upside down)', short: 'Good wood inner face', side: 'blade' },
  inner: { label: 'Cheap wood - inner edge', short: 'Cheap wood inner edge', side: 'blade' },
};

export const onInnerSide = (fenceEdge) => fenceEdge !== 'outer';

/**
 * Masking-tape shim plan for one mitre cut on a fixed 45 degree sled fence.
 *
 * The strip bears on the fence at two points: one right beside the blade and
 * one `tapeDistance` mm further along the fence. Tape of total thickness t at
 * one of those points rotates the strip by atan(t / tapeDistance).
 *
 *  - Tape at the FAR point pushes the far end of the strip's fence edge into the
 *    workpiece side, shrinking the angle at the fence-side corner of the cut.
 *  - Tape NEAR the blade does the opposite.
 * The mitre angle we care about is the acute angle at the long point. If the
 * OUTER (long) edge rides the fence that corner IS the mitre angle; if the
 * INNER (short) edge rides the fence the mitre angle is its supplement.
 *
 * Rounding to whole layers prefers the slightly more acute (smaller) result so
 * the joint closes tight at the visible outside corner.
 */
export function tapePlan(targetDeg, { tapeDistance: D, tapeThickness: t, fenceEdge }) {
  const delta = targetDeg - 45;
  const base = { target: targetDeg, delta, location: null, layers: 0, exactLayers: 0, shim: 0, result: 45, error: 45 - targetDeg };
  if (!(D > 0) || !(t > 0)) return { ...base, invalid: true };
  if (Math.abs(delta) < 1e-6) return { ...base, error: 0 };

  const increase = delta > 0;
  const location = increase === onInnerSide(fenceEdge) ? 'far' : 'near';
  const sign = Math.sign(delta);
  const angleFor = (n) => 45 + sign * Math.atan((n * t) / D) / DEG;
  const exact = (D * Math.tan(Math.abs(delta) * DEG)) / t;
  const cands = [...new Set([Math.floor(exact + 1e-6), Math.ceil(exact - 1e-6)])].filter((n) => n >= 0);
  const err = (n) => angleFor(n) - targetDeg;
  const nearest = cands.reduce((b, c) => (Math.abs(err(c)) < Math.abs(err(b)) ? c : b));
  const acute = cands.filter((n) => err(n) <= 1e-9);
  // Take the more-acute option unless the nearest is already within a hair (0.01°).
  const n = Math.abs(err(nearest)) <= TAPE_TOLERANCE || !acute.length
    ? nearest
    : acute.reduce((b, c) => (angleFor(c) > angleFor(b) ? c : b));
  const result = angleFor(n);
  return { ...base, location: n > 0 ? location : null, idealLocation: location, layers: n, exactLayers: exact, shim: n * t, result, error: result - targetDeg };
}

/**
 * Full frame calculation.
 * painting: { top, bottom, left, right, depth, diagA?, diagB? }
 * s (settings): { goodThickness, cheapThickness, cheapWidth, cheapPosition, gap, lip,
 *                 tapeDistance, tapeThickness, fenceEdge, kerf }
 */
export function computeFrame(painting, s) {
  const errors = [], warnings = [];
  const need = { top: 'Top width', bottom: 'Bottom width', left: 'Left height', right: 'Right height', depth: 'Canvas depth' };
  for (const [k, label] of Object.entries(need)) {
    if (!(painting[k] > 0)) errors.push(`${label} is required.`);
  }
  const setNeed = { goodThickness: 'Good wood thickness', cheapThickness: 'Cheap wood thickness', cheapWidth: 'Cheap wood width' };
  for (const [k, label] of Object.entries(setNeed)) {
    if (!(s[k] > 0)) errors.push(`${label} must be greater than 0.`);
  }
  if (!Number.isFinite(s.gap) || s.gap < 0) errors.push('Gap must be 0 or more.');
  if (!Number.isFinite(s.lip)) errors.push('Lip must be a number (negative to recess).');
  if (errors.length) return { ok: false, errors, warnings };

  const quad = solveQuad(painting);
  if (!quad) {
    return { ok: false, errors: ['Those four side lengths cannot form a painting shape - please re-check the measurements.'], warnings };
  }

  const inside = s.cheapPosition !== 'under';
  const tg = s.goodThickness, tc = s.cheapThickness, wc = s.cheapWidth, gap = s.gap, lip = s.lip, depth = painting.depth;

  const goodWidth = (inside ? tc : 0) + depth + lip; // good wood dimension front-to-back
  if (goodWidth <= 0) errors.push('Negative lip is larger than the frame - the good wood would have no width.');

  const layers = {
    good: { dIn: gap, dOut: gap + tg, z0: inside ? 0 : tc, z1: (inside ? 0 : tc) + goodWidth },
    cheap: inside
      ? { dIn: gap - wc, dOut: gap, z0: 0, z1: tc }
      : { dIn: gap + tg - wc, dOut: gap + tg, z0: 0, z1: tc },
  };
  const support = inside ? wc - gap : wc - tg - gap; // how far the cheap strip reaches under the canvas
  if (support <= 0) errors.push(`The cheap wood strip doesn't reach under the painting (it stops ${Math.abs(support).toFixed(1)} mm short). Increase its width.`);
  else if (support < 10) warnings.push(`The cheap wood strip only reaches ${support.toFixed(1)} mm under the painting - that leaves little room for screws.`);

  const minHalf = Math.min(painting.top, painting.bottom, painting.left, painting.right) / 2;
  if (-layers.cheap.dIn >= minHalf) errors.push('The cheap wood strips are wider than half the painting.');
  if (errors.length) return { ok: false, errors, warnings };

  quad.angles.forEach((a, i) => {
    if (Math.abs(a - 90) > 3) warnings.push(`Corner ${CORNERS[i].key} works out at ${a.toFixed(2)}° - that is a lot for a stretched canvas. Double-check the measurements.`);
  });
  if (lip < 0 && -lip >= depth) warnings.push('The negative lip recesses the frame below the back of the canvas.');

  const polys = {};
  for (const [name, l] of Object.entries(layers)) {
    polys[name] = { inner: offsetPolygon(quad.pts, l.dIn), outer: offsetPolygon(quad.pts, l.dOut) };
  }

  const mitre = quad.angles.map((a) => a / 2);
  const tape = mitre.map((m) => tapePlan(m, s));

  const corners = CORNERS.map((c, i) => {
    const t = tape[i];
    // Both strips at a corner get the same cut, so the joint error is double.
    // Faces meet at the long point; the gap opens at the short point.
    const face = tg / Math.sin(mitre[i] * DEG);
    const opening = face * Math.sin(Math.abs(2 * t.error) * DEG);
    return { ...c, index: i, angle: quad.angles[i], mitre: mitre[i], tape: t, jointOpening: opening, openingAt: t.error <= 0 ? 'inner' : 'outer' };
  });

  const strips = SIDES.map((side, i) => {
    const j = (i + 1) % 4;
    const make = (layerName) => {
      const p = polys[layerName], l = layers[layerName];
      const poly = [p.inner[i], p.inner[j], p.outer[j], p.outer[i]];
      return {
        layer: layerName,
        poly,
        z0: l.z0,
        z1: l.z1,
        width: l.dOut - l.dIn,
        height: l.z1 - l.z0,
        longPoint: dist(p.outer[i], p.outer[j]),
        shortPoint: dist(p.inner[i], p.inner[j]),
      };
    };
    const dir = norm(sub(quad.pts[j], quad.pts[i]));
    return {
      ...side,
      index: i,
      corners: [i, j], // [start corner, end corner] in CCW order
      paintingLength: painting[side.key],
      dir,
      normal: [dir[1], -dir[0]],
      good: make('good'),
      cheap: make('cheap'),
    };
  });

  const kerf = s.kerf > 0 ? s.kerf : 0;
  const stock = {
    good: strips.reduce((t, st) => t + st.good.longPoint, 0) + 8 * kerf,
    cheap: strips.reduce((t, st) => t + st.cheap.longPoint, 0) + 8 * kerf,
  };

  const outer = polys.good.outer;
  return {
    ok: true,
    errors,
    warnings,
    quad,
    inside,
    goodWidth,
    support,
    layers,
    polys,
    strips,
    corners,
    stock,
    painting: { ...painting, z0: tc, z1: tc + depth },
    outerSize: {
      top: dist(outer[3], outer[2]),
      bottom: dist(outer[0], outer[1]),
      left: dist(outer[0], outer[3]),
      right: dist(outer[1], outer[2]),
    },
    // Corner-to-corner diagonals of the assembled frame, for checking the glue-up.
    // a: bottom-left -> top-right, b: top-left -> bottom-right.
    diagonals: {
      outer: { a: dist(outer[0], outer[2]), b: dist(outer[3], outer[1]) },
      inner: { a: dist(polys.good.inner[0], polys.good.inner[2]), b: dist(polys.good.inner[3], polys.good.inner[1]) },
    },
    totalDepth: Math.max(layers.good.z1, tc + depth),
  };
}

// Transform a point into a strip's local drawing frame: x along the strip with
// the outer edge on top (+y). The strip's END corner ends up on the left.
export function stripLocal(strip, p) {
  return [-dot(p, strip.dir), dot(p, strip.normal)];
}
