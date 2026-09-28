// Technical drawing (SVG) of the frame and its 8 strips.
import { stripLocal, FENCE_FACES } from './geometry.js';

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SHEET_W = 1120;
const INK = '#1b1b1b';
const DIM = '#1b4fa8';

class Svg {
  constructor() { this.parts = []; }
  add(s) { this.parts.push(s); }
  line(x1, y1, x2, y2, cls = 'thick') { this.add(`<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`); }
  poly(pts, cls = 'thick', extra = '') { this.add(`<polygon class="${cls}" ${extra} points="${pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ')}"/>`); }
  rect(x, y, w, h, cls = 'thick', extra = '') { this.add(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" ${extra}/>`); }
  text(x, y, s, { size = 11, anchor = 'start', weight = 'normal', cls = '', rot = 0, baseline = 'auto' } = {}) {
    const tr = rot ? ` transform="rotate(${rot} ${x} ${y})"` : '';
    this.add(`<text class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" dominant-baseline="${baseline}"${tr}>${esc(s)}</text>`);
  }
  /** Aligned dimension from p1 to p2 offset `off` along the normal (negative = up/left for L->R / B->T). */
  dim(p1, p2, off, label, { size = 10.5 } = {}) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const d = [dx / L, dy / L], n = [-d[1], d[0]];
    const sg = Math.sign(off) || 1;
    const P = (p, k) => [p[0] + n[0] * k, p[1] + n[1] * k];
    const e1a = P(p1, sg * 2), e1b = P(p1, off + sg * 4);
    const e2a = P(p2, sg * 2), e2b = P(p2, off + sg * 4);
    const q1 = P(p1, off), q2 = P(p2, off);
    this.line(e1a[0], e1a[1], e1b[0], e1b[1], 'dimext');
    this.line(e2a[0], e2a[1], e2b[0], e2b[1], 'dimext');
    const small = L < 22;
    if (small) {
      // Arrows outside, pointing in
      const o1 = [q1[0] - d[0] * 12, q1[1] - d[1] * 12], o2 = [q2[0] + d[0] * 12, q2[1] + d[1] * 12];
      this.add(`<line class="dimline" x1="${o1[0]}" y1="${o1[1]}" x2="${q1[0]}" y2="${q1[1]}" marker-end="url(#arrow)"/>`);
      this.add(`<line class="dimline" x1="${o2[0]}" y1="${o2[1]}" x2="${q2[0]}" y2="${q2[1]}" marker-end="url(#arrow)"/>`);
      this.line(q1[0], q1[1], q2[0], q2[1], 'dimline');
    } else {
      this.add(`<line class="dimline" x1="${q1[0]}" y1="${q1[1]}" x2="${q2[0]}" y2="${q2[1]}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`);
    }
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang > 89.99) ang -= 180;
    if (ang <= -90.01) ang += 180;
    const mid = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    // Put the text on the far side of the dimension line from the object.
    const tp = [mid[0] + n[0] * sg * 7, mid[1] + n[1] * sg * 7];
    if (small) {
      // Too short for a rotated label: write it level, beside the dimension line.
      const side = n[0] * sg;
      const anchor = side > 0.5 ? 'start' : side < -0.5 ? 'end' : 'middle';
      this.text(tp[0], tp[1], label, { size, anchor, baseline: 'middle', cls: 'dimtext' });
    } else {
      this.text(tp[0], tp[1], label, { size, anchor: 'middle', baseline: 'middle', cls: 'dimtext', rot: ang });
    }
  }
  toString(h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${h}" width="${SHEET_W}" height="${h}" font-family="Arial, Helvetica, sans-serif">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1.5 L10,5 L0,8.5 z" fill="${DIM}"/></marker>
  <pattern id="hatchGood" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#f1e2cc"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7a4e2a" stroke-width="0.9"/></pattern>
  <pattern id="hatchCheap" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="7" height="7" fill="#fbf1d8"/><line x1="0" y1="0" x2="0" y2="7" stroke="#b88a3e" stroke-width="0.7"/></pattern>
</defs>
<style>
  .thick{stroke:${INK};stroke-width:1.4;fill:none}
  .thin{stroke:${INK};stroke-width:0.7;fill:none}
  .hidden{stroke:${INK};stroke-width:0.8;fill:none;stroke-dasharray:5 3}
  .center{stroke:#888;stroke-width:0.6;fill:none;stroke-dasharray:14 3 2 3}
  .good{stroke:${INK};stroke-width:1.4;fill:#f1e2cc}
  .cheap{stroke:${INK};stroke-width:1.4;fill:#fbf1d8}
  .goodH{stroke:${INK};stroke-width:1.2;fill:url(#hatchGood)}
  .cheapH{stroke:${INK};stroke-width:1.2;fill:url(#hatchCheap)}
  .canvas{stroke:${INK};stroke-width:1;fill:#f6f5f2}
  .white{stroke:${INK};stroke-width:1.2;fill:#fff}
  .dimline{stroke:${DIM};stroke-width:0.7;fill:none}
  .dimext{stroke:${DIM};stroke-width:0.5;fill:none}
  .dimtext{fill:${DIM}}
  .box{stroke:${INK};stroke-width:1;fill:none}
  .muted{fill:#555}
  .angle{fill:#b3261e;font-weight:bold}
  text{fill:${INK}}
</style>
<rect x="0" y="0" width="${SHEET_W}" height="${h}" fill="#fff"/>
${this.parts.join('\n')}
</svg>`;
  }
}

function tapeText(t) {
  if (t.invalid) return 'set tape distance & thickness';
  if (t.layers === 0) return 'no tape (45°)';
  return `${t.layers} layer${t.layers === 1 ? '' : 's'} ${t.location === 'far' ? 'FAR from blade' : 'NEAR blade'} → ${f2(t.result)}°`;
}

export function buildDrawing(frame, meta, settings) {
  const s = new Svg();
  const M = 30;
  let y = M;

  // ---------- Title block ----------
  s.rect(M, y, SHEET_W - 2 * M, 70, 'box');
  s.text(M + 14, y + 30, 'FLOATING FRAME - CUTTING DRAWING', { size: 20, weight: 'bold' });
  s.text(M + 14, y + 54, 'All dimensions in mm. Miter angles are measured between the strip\'s long (outer) edge and the cut.', { size: 11, cls: 'muted' });
  const tbx = SHEET_W - M - 360;
  s.line(tbx, y, tbx, y + 70, 'thin');
  const rows = [
    ['SKU', meta.sku || '-'],
    ['Title', meta.title || '-'],
    ['Artist', meta.artist || '-'],
    ['Date', new Date().toLocaleDateString()],
  ];
  rows.forEach(([k, v], i) => {
    s.text(tbx + 10, y + 17 + i * 16, k.toUpperCase(), { size: 9, cls: 'muted', weight: 'bold' });
    s.text(tbx + 60, y + 17 + i * 16, v.length > 48 ? v.slice(0, 47) + '…' : v, { size: 11 });
  });
  y += 90;

  // ---------- Front view ----------
  const viewH = 430;
  const fvW = 640;
  s.rect(M, y, fvW, viewH, 'box');
  s.text(M + 10, y + 18, 'FRONT VIEW', { size: 12, weight: 'bold' });
  s.text(M + 10, y + 32, 'cheap wood strips hidden behind (dashed)', { size: 9.5, cls: 'muted' });
  {
    const outer = frame.polys.good.outer;
    const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const sc = Math.min((fvW - 190) / w, (viewH - 150) / h);
    const cx = M + fvW / 2, cy = y + viewH / 2 + 12;
    const T = (p) => [cx + p[0] * sc, cy - p[1] * sc];
    const P = frame.polys;
    s.poly(P.good.outer.map(T), 'good');
    s.poly(P.good.inner.map(T), 'white');
    // cheap strips hidden
    s.poly(P.cheap.inner.map(T), 'hidden');
    if (!frame.inside) s.poly(P.cheap.outer.map(T), 'hidden');
    for (let i = 0; i < 4; i++) {
      const a = T(P.cheap.outer[i]), b = T(P.cheap.inner[i]);
      s.line(a[0], a[1], b[0], b[1], 'hidden');
    }
    s.poly(frame.quad.pts.map(T), 'canvas');
    for (let i = 0; i < 4; i++) {
      const a = T(P.good.outer[i]), b = T(P.good.inner[i]);
      s.line(a[0], a[1], b[0], b[1], 'thick');
    }
    // centre lines
    s.line(cx - 30, cy, cx + 30, cy, 'center');
    s.line(cx, cy - 30, cx, cy + 30, 'center');
    s.text(cx, cy - 40, 'PAINTING', { size: 11, anchor: 'middle', cls: 'muted', weight: 'bold' });
    const pp = frame.painting;
    s.text(cx, cy + 46, `T ${f1(pp.top)} · B ${f1(pp.bottom)}`, { size: 10, anchor: 'middle', cls: 'muted' });
    s.text(cx, cy + 60, `L ${f1(pp.left)} · R ${f1(pp.right)} · depth ${f1(pp.depth)}`, { size: 10, anchor: 'middle', cls: 'muted' });

    // Outer dims on all 4 sides
    const o = P.good.outer.map(T);
    s.dim(o[3], o[2], -26, `${f1(frame.outerSize.top)}`); // top
    s.dim(o[0], o[1], 26, `${f1(frame.outerSize.bottom)}`); // bottom
    s.dim(o[0], o[3], -26, `${f1(frame.outerSize.left)}`); // left (B->T, -n is left)
    s.dim(o[1], o[2], 26, `${f1(frame.outerSize.right)}`); // right
    // Corner angles
    frame.corners.forEach((c, i) => {
      const p = o[i];
      const dx = p[0] - cx, dy = p[1] - cy;
      const l = Math.hypot(dx, dy);
      const q = [p[0] + (dx / l) * 30, p[1] + (dy / l) * 30];
      s.text(q[0], q[1], `${c.key} ${f2(c.angle)}°`, { size: 10.5, anchor: dx < 0 ? 'end' : 'start', baseline: 'middle', cls: 'angle' });
    });
    // Section marker A-A across the left strip
    const mid = [(P.good.outer[0][0] + P.good.outer[3][0]) / 2, (P.good.outer[0][1] + P.good.outer[3][1]) / 2];
    const a1 = T([mid[0] - 4 / sc, mid[1]]), a2 = T([frame.quad.pts[0][0] + 30 / sc, mid[1]]);
    s.line(a1[0], a1[1], a2[0], a2[1], 'center');
    s.text(a1[0] + 2, a1[1] - 5, 'A', { size: 11, weight: 'bold', anchor: 'middle' });
    s.text(a2[0], a2[1] - 5, 'A', { size: 11, weight: 'bold', anchor: 'middle' });
  }

  // ---------- Section A-A ----------
  {
    const sx0 = M + fvW + 20, sw = SHEET_W - M - sx0;
    s.rect(sx0, y, sw, viewH, 'box');
    s.text(sx0 + 10, y + 18, 'SECTION A-A  (L profile)', { size: 12, weight: 'bold' });
    const { good, cheap } = frame.layers;
    const gap = settings.gap, tg = settings.goodThickness, depth = frame.painting.depth;
    const pz0 = frame.painting.z0, pz1 = frame.painting.z1;
    // Section x: 0 = painting edge, negative = outward (drawn to the LEFT).
    const gx0 = -(gap + tg), gx1 = -gap;
    const cx0 = -cheap.dOut, cx1 = -cheap.dIn;
    const paintEnd = Math.max(cx1, 0) + Math.max(25, depth * 0.8);
    const xmin = gx0, xmax = paintEnd;
    const zmax = Math.max(good.z1, pz1);
    const scale = Math.min((sw - 200) / (xmax - xmin), (viewH - 150) / zmax, 8);
    const ox = sx0 + 125 - xmin * scale;
    const oz = y + viewH - 70;
    const X = (x) => ox + x * scale, Z = (z) => oz - z * scale;

    s.rect(X(gx0), Z(good.z1), tg * scale, (good.z1 - good.z0) * scale, 'goodH');
    s.rect(X(cx0), Z(cheap.z1), (cx1 - cx0) * scale, (cheap.z1 - cheap.z0) * scale, 'cheapH');
    // painting (stretcher bar + canvas), with break line at the right
    const bx = X(paintEnd);
    s.add(`<path class="canvas" d="M${X(0)},${Z(pz0)} L${X(0)},${Z(pz1)} L${bx},${Z(pz1)} L${bx - 5},${Z(pz1 - depth * 0.35)} L${bx + 5},${Z(pz1 - depth * 0.65)} L${bx},${Z(pz0)} Z"/>`);
    s.line(X(0), Z(pz1), bx, Z(pz1), 'thick');
    s.text(X(paintEnd / 2), Z((pz0 + pz1) / 2), 'CANVAS', { size: 9, anchor: 'middle', baseline: 'middle', cls: 'muted' });
    // screw centre line
    const screwX = (Math.max(cx0, 0) + cx1) / 2;
    if (cx1 > 0) s.line(X(screwX), Z(-3), X(screwX), Z(pz0 + Math.min(depth * 0.6, 20)), 'center');

    // Dimensions
    s.dim([X(gx0), Z(good.z1)], [X(gx1), Z(good.z1)], -16, f1(tg));
    s.dim([X(gx1), Z(pz1)], [X(0), Z(pz1)], -38, `gap ${f1(gap)}`);
    s.dim([X(gx0), Z(good.z0)], [X(gx0), Z(good.z1)], -22, `${f1(frame.goodWidth)}`);
    if (Math.abs(settings.lip) > 1e-6) {
      s.dim([X(gx0), Z(Math.min(pz1, good.z1))], [X(gx0), Z(Math.max(pz1, good.z1))], -62, `lip ${settings.lip > 0 ? '+' : ''}${f1(settings.lip)}`);
    }
    s.dim([bx + 8, Z(pz0)], [bx + 8, Z(pz1)], 18, f1(depth));
    s.dim([X(cx1), Z(cheap.z0)], [X(cx1), Z(cheap.z1)], 18, f1(cheap.z1 - cheap.z0));
    s.dim([X(cx0), Z(0)], [X(cx1), Z(0)], 20, f1(cheap.dOut - cheap.dIn));

    // Legend
    const ly = y + viewH - 22;
    s.rect(sx0 + 12, ly - 9, 14, 11, 'goodH');
    s.text(sx0 + 32, ly, `Good wood ${f1(tg)} × ${f1(frame.goodWidth)}`, { size: 10 });
    s.rect(sx0 + 200, ly - 9, 14, 11, 'cheapH');
    s.text(sx0 + 220, ly, `Cheap wood ${f1(settings.cheapThickness)} × ${f1(settings.cheapWidth)}`, { size: 10 });
    s.text(sx0 + 10, y + 34, frame.inside ? 'cheap strip glued to inside face of good wood' : 'good wood sits on top of cheap strip', { size: 9.5, cls: 'muted' });
  }
  y += viewH + 26;

  // ---------- Strips ----------
  const all = frame.strips.flatMap((st) => [st.good, st.cheap]);
  const maxLen = Math.max(...all.map((x) => x.longPoint));
  const gx0 = M + 190, gx1 = SHEET_W - M - 120;
  const sc = Math.min((gx1 - gx0) / maxLen, 3);
  const ratio = 1 / sc;
  const scaleText = ratio >= 1 ? `1:${ratio.toFixed(ratio < 10 ? 1 : 0)}` : `${(1 / ratio).toFixed(1)}:1`;
  const corners = frame.corners;

  const section = (layerName, heading, sub) => {
    s.text(M, y + 12, heading, { size: 14, weight: 'bold' });
    s.text(M, y + 28, sub, { size: 10, cls: 'muted' });
    s.line(M, y + 36, SHEET_W - M, y + 36, 'thin');
    y += 50;
    frame.strips.forEach((st) => {
      const part = st[layerName];
      const loc = part.poly.map((p) => stripLocal(st, p));
      const xs = loc.map((p) => p[0]), ys = loc.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys), minY = Math.min(...ys);
      const hpx = (maxY - minY) * sc;
      const ox = (gx0 + gx1) / 2 - ((minX + maxX) / 2) * sc;
      const top = y + 40;
      const T = (p) => [ox + p[0] * sc, top + (maxY - p[1]) * sc];
      const P = loc.map(T); // inner_i, inner_j, outer_j, outer_i  -> in drawing: outer on top
      s.poly(P, layerName === 'good' ? 'good' : 'cheap');

      const [i, j] = st.corners; // i = right end, j = left end
      const outerL = P[2], outerR = P[3], innerL = P[1], innerR = P[0];
      s.dim(outerL, outerR, -18, `${f1(part.longPoint)}`, { size: 11.5 });
      s.dim(innerL, innerR, 18, `${f1(part.shortPoint)}`);
      const rightmost = Math.max(outerR[0], innerR[0]);
      s.dim([rightmost, outerR[1]], [rightmost, innerR[1]], -12, f1(part.width), { size: 9.5 });

      const cL = corners[j], cR = corners[i];
      s.text(Math.min(outerL[0], innerL[0]) - 10, outerL[1] - 4, `${f2(cL.miter)}°`, { size: 11, anchor: 'end', cls: 'angle' });
      s.text(Math.min(outerL[0], innerL[0]) - 10, outerL[1] + 9, `${cL.key} end`, { size: 9, anchor: 'end', cls: 'muted' });
      s.text(rightmost + 56, outerR[1] - 4, `${f2(cR.miter)}°`, { size: 11, cls: 'angle' });
      s.text(rightmost + 56, outerR[1] + 9, `${cR.key} end`, { size: 9, cls: 'muted' });

      // Label column
      s.text(M, top - 2, `${st.name.toUpperCase()}`, { size: 13, weight: 'bold' });
      s.text(M, top + 13, `${layerName === 'good' ? 'Good wood' : 'Cheap wood'} × 1`, { size: 10, cls: 'muted' });
      s.text(M, top + 26, `${f1(part.width)} × ${f1(part.height)} section`, { size: 10, cls: 'muted' });

      const rowBottom = top + hpx + 42;
      if (layerName === 'good') {
        s.text(gx0, rowBottom + 6, `Tape - ${cL.key} end: ${tapeText(cL.tape)}      ${cR.key} end: ${tapeText(cR.tape)}`, { size: 9.5, cls: 'muted' });
        y = rowBottom + 22;
      } else {
        y = rowBottom + 10;
      }
    });
    y += 8;
  };

  section('good', 'GOOD WOOD STRIPS  (×4)', `Drawn to scale ${scaleText}, viewed from the front with the outer (visible) edge on top.`);
  section('cheap', 'CHEAP WOOD STRIPS  (×4)',
    frame.inside
      ? 'Top edge glues to the inside face of the matching good wood strip. Cut together with the good wood as one L.'
      : 'Top face glues under the matching good wood strip, outer edges flush. Cut together with the good wood as one L.');

  // ---------- Notes ----------
  s.line(M, y, SHEET_W - M, y, 'thin');
  y += 18;
  const q = frame.quad;
  const notes = [
    `Painting shape: ${q.method === 'diagonals' ? `fitted to measured diagonal(s) (residual ${f1(q.diagResidual)} mm)` : 'assumed "most square" (max area) - measure the diagonals for extra accuracy'}. Diagonals: BL→TR ${f1(q.diagA)}, TL→BR ${f1(q.diagB)}.`,
    `Tape: ${settings.tapeThickness} mm per layer, far point ${settings.tapeDistance} mm from blade, ${(FENCE_FACES[settings.fenceEdge] || FENCE_FACES.outer).short.toLowerCase()} against the fence (${(FENCE_FACES[settings.fenceEdge] || FENCE_FACES.outer).side} side). Rounded to the slightly more acute side.`,
    `Stock (sum of long points + kerfs): good wood ≥ ${f1(frame.stock.good)} mm, cheap wood ≥ ${f1(frame.stock.cheap)} mm.`,
  ];
  notes.forEach((n) => { s.text(M, y, '• ' + n, { size: 10.5 }); y += 17; });
  y += M - 10;

  return s.toString(Math.ceil(y));
}
