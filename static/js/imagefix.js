// Photo clean-up for painting images: find the canvas in a photo, straighten it
// (remove perspective) and even out the lighting. Plain canvas/ImageData maths.

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

// The image's pixels, scaled so its longer side is at most maxSide.
export function pixelsOf(img, maxSide = Infinity) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// ---------------------------------------------------------------- Corner detection
// Best guess at the canvas's corners, as fractions of the photo's width/height, in the
// order top-left, top-right, bottom-right, bottom-left. Works best with the painting on a
// plain background: the background colour is taken from the photo's edges, and the
// painting is the largest region that differs from it.
export function detectCorners(img) {
  const px = pixelsOf(img, 220);
  const { width: w, height: h, data } = px;
  const n = w * h;

  // Background: the colour of a band around the photo's edge, fitted as a smooth gradient
  // (c = a + b x + c y + d x y per channel) so a wall that's lit unevenly still counts as wall.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], R = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const i = (y * w + x) * 4, fx = x / w - 0.5, fy = y / h - 0.5;
      const f = [1, fx, fy, fx * fy];
      for (let p = 0; p < 4; p++) {
        for (let q = 0; q < 4; q++) M[p][q] += f[p] * f[q];
        for (let k = 0; k < 3; k++) R[k][p] += f[p] * data[i + k];
      }
    }
  }
  const bgFit = R.map((r) => solve4(M, r) || [r[0] / Math.max(M[0][0], 1), 0, 0, 0]);

  // How different each pixel is from the background there, split with Otsu's threshold.
  const dist = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const fx = (i % w) / w - 0.5, fy = ((i / w) | 0) / h - 0.5;
    const bgAt = (k) => bgFit[k][0] + bgFit[k][1] * fx + bgFit[k][2] * fy + bgFit[k][3] * fx * fy;
    const r = data[i * 4] - bgAt(0), g = data[i * 4 + 1] - bgAt(1), b = data[i * 4 + 2] - bgAt(2);
    const d = Math.min(255, Math.sqrt(r * r + g * g + b * b));
    dist[i] = d;
    hist[d | 0]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thresh = 30;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thresh = t; }
  }
  thresh = Math.max(thresh, 22);

  // Foreground mask, closed (dilate then erode) so gaps inside the painting join up.
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = dist[i] > thresh ? 1 : 0;
  // grow: a pixel is set if any neighbour is set (dilate); otherwise only if all are (erode).
  const morph = (src, grow) => {
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let any = 0, all = 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
            const s = src[yy * w + xx];
            any |= s;
            all &= s;
          }
        }
        out[y * w + x] = grow ? any : all;
      }
    }
    return out;
  };
  mask = morph(morph(mask, true), false);

  // Largest connected region.
  const label = new Int32Array(n).fill(-1);
  let bestId = -1, bestSize = 0;
  const stack = new Int32Array(n);
  for (let start = 0, id = 0; start < n; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    let top = 0, size = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && label[i - 1] === -1) { label[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && label[i + 1] === -1) { label[i + 1] = id; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && label[i - w] === -1) { label[i - w] = id; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && label[i + w] === -1) { label[i + w] = id; stack[top++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestSize < n * 0.05 || bestSize > n * 0.97) return defaultCorners();

  // Its four extreme points along the diagonals are the corners.
  let tl = null, tr = null, br = null, bl = null;
  let sTL = Infinity, sTR = -Infinity, sBR = -Infinity, sBL = Infinity;
  for (let i = 0; i < n; i++) {
    if (label[i] !== bestId) continue;
    const x = i % w + 0.5, y = ((i / w) | 0) + 0.5;
    if (x + y < sTL) { sTL = x + y; tl = [x, y]; }
    if (x + y > sBR) { sBR = x + y; br = [x, y]; }
    if (x - y > sTR) { sTR = x - y; tr = [x, y]; }
    if (x - y < sBL) { sBL = x - y; bl = [x, y]; }
  }
  const corners = [tl, tr, br, bl].map(([x, y]) => [x / w, y / h]);
  // A sliver or a triangle isn't a painting: fall back to a plain inset.
  return quadArea(corners) < 0.04 ? defaultCorners() : corners;
}

export const defaultCorners = (inset = 0.06) => [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]];
export const wholePhoto = () => defaultCorners(0);

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------- Perspective
// Homography taking the rectangle (0,0)-(W,H) onto the quad (pixels, TL TR BR BL).
function rectToQuad(W, H, quad) {
  const src = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = quad[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(8).fill(0);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k];
    h[r] = s / (A[r][r] || 1e-12);
  }
  return h;
}

// Straighten: the quad (fractions of the source) becomes a W x H image.
export function warp(src, corners, W, H) {
  const { width: sw, height: sh, data: s } = src;
  const quad = corners.map(([x, y]) => [x * sw, y * sh]);
  const [a, b, c, d, e, f, g, hh] = rectToQuad(W, H, quad);
  const out = new ImageData(W, H);
  const o = out.data;
  for (let v = 0; v < H; v++) {
    const vy = v + 0.5;
    for (let u = 0; u < W; u++) {
      const ux = u + 0.5;
      const z = g * ux + hh * vy + 1;
      let x = (a * ux + b * vy + c) / z - 0.5;
      let y = (d * ux + e * vy + f) / z - 0.5;
      x = x < 0 ? 0 : x > sw - 1 ? sw - 1 : x;
      y = y < 0 ? 0 : y > sh - 1 ? sh - 1 : y;
      const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const oi = (v * W + u) * 4;
      for (let k = 0; k < 3; k++) {
        const top = s[i00 + k] + (s[i10 + k] - s[i00 + k]) * fx;
        const bot = s[i01 + k] + (s[i11 + k] - s[i01 + k]) * fx;
        o[oi + k] = top + (bot - top) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  return out;
}

// Output size for a quad: the painting's real proportions (width / height) when known,
// otherwise the quad's own; about as many pixels as the photo has there, up to maxSide.
export function outputSize(src, corners, aspect, maxSide = 2000) {
  const q = corners.map(([x, y]) => [x * src.width, y * src.height]);
  const len = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
  const qw = (len(q[0], q[1]) + len(q[3], q[2])) / 2;
  const qh = (len(q[0], q[3]) + len(q[1], q[2])) / 2;
  const ratio = aspect > 0 ? aspect : qw / Math.max(qh, 1);
  const long = Math.max(16, Math.min(maxSide, Math.max(qw, qh)));
  return ratio >= 1
    ? { W: Math.round(long), H: Math.max(1, Math.round(long / ratio)) }
    : { W: Math.max(1, Math.round(long * ratio)), H: Math.round(long) };
}

// ---------------------------------------------------------------- Lighting
// Gentle, painting-friendly clean-up, in place:
//  1. evens out lighting that falls off across the photo (a smooth bilinear gradient,
//     so the painting's own light and dark areas are left alone);
//  2. stretches each colour channel's levels a little, which also takes out colour casts.
export function enhance(img) {
  const { width: W, height: H, data: d } = img;

  // 1. Fit luminance ~ c0 + c1 x + c2 y + c3 x y (x, y in -0.5..0.5) by least squares.
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 20000)));
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], r = [0, 0, 0, 0];
  let lumSum = 0, count = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const f = [1, x / W - 0.5, y / H - 0.5, (x / W - 0.5) * (y / H - 0.5)];
      for (let p = 0; p < 4; p++) {
        r[p] += f[p] * L;
        for (let q = 0; q < 4; q++) M[p][q] += f[p] * f[q];
      }
      lumSum += L; count++;
    }
  }
  const coef = solve4(M, r);
  const mean = lumSum / Math.max(count, 1);
  if (coef && mean > 8) {
    for (let y = 0; y < H; y++) {
      const fy = y / H - 0.5;
      for (let x = 0; x < W; x++) {
        const fx = x / W - 0.5;
        const fit = coef[0] + coef[1] * fx + coef[2] * fy + coef[3] * fx * fy;
        let gain = mean / Math.max(fit, 1);
        gain = 1 + 0.85 * (Math.min(1.6, Math.max(0.65, gain)) - 1);
        const i = (y * W + x) * 4;
        d[i] = d[i] * gain; d[i + 1] = d[i + 1] * gain; d[i + 2] = d[i + 2] * gain; // clamped by the array
      }
    }
  }

  // 2. Per-channel levels: 0.5% / 99.5% points stretched most of the way to 0 / 255.
  for (let k = 0; k < 3; k++) {
    const hist = new Uint32Array(256);
    for (let i = k; i < d.length; i += 4) hist[d[i]]++;
    const total = W * H;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.005) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.005) { hi = v; break; } }
    if (hi - lo < 40) continue; // nearly flat: stretching would just add noise
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const stretched = ((v - lo) * 255) / (hi - lo);
      lut[v] = v + 0.75 * (stretched - v);
    }
    for (let i = k; i < d.length; i += 4) d[i] = lut[d[i]];
  }
  return img;
}

function solve4(M, r) {
  const A = M.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let i = c + 1; i < 4; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-9) return null;
    for (let i = 0; i < 4; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      for (let k = c; k < 5; k++) A[i][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[4] / row[i]);
}
