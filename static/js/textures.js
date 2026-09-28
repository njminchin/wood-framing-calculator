// Procedurally generated canvases: wood grain and a default painting.

export const SPECIES = {
  walnut: { label: 'Walnut', base: '#5b3a24', dark: '#39220f', light: '#80573a' },
  oak: { label: 'Oak', base: '#b88a55', dark: '#8a6135', light: '#d6ad74' },
  maple: { label: 'Maple', base: '#e0c79c', dark: '#c3a071', light: '#f0dcb6' },
  cherry: { label: 'Cherry', base: '#9b5534', dark: '#6b3420', light: '#bd7650' },
  ash: { label: 'Ash', base: '#d7c6a3', dark: '#a8906a', light: '#ebdfc4' },
  jarrah: { label: 'Jarrah', base: '#7b2f1f', dark: '#521b10', light: '#9c4631' },
  bluegum: { label: 'Blue Gum', base: '#b27a5f', dark: '#86513c', light: '#cc9679' },
  messmate: { label: 'Messmate', base: '#c3a178', dark: '#94714a', light: '#dabb92' },
  ebonised: { label: 'Ebonised / black', base: '#2b2723', dark: '#141210', light: '#403a34' },
  white: { label: 'White painted', base: '#ecebe6', dark: '#d8d6cf', light: '#f7f6f2' },
};

export const PINE = { label: 'Pine', base: '#e2c08a', dark: '#c0904f', light: '#f0d6a6', knots: true };

// Small deterministic PRNG so textures don't change between renders.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wood grain running along the x axis. 1024 x 256 px, tileable in x. */
export function woodCanvas(spec, seed = 7) {
  const W = 1024, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = spec.base;
  g.fillRect(0, 0, W, H);
  if (spec === SPECIES.white) {
    // Painted: very faint brush texture only.
    for (let i = 0; i < 120; i++) {
      g.strokeStyle = `rgba(0,0,0,${0.01 + r() * 0.02})`;
      g.lineWidth = 1 + r() * 2;
      const y = r() * H;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y + (r() - 0.5) * 4); g.stroke();
    }
    return c;
  }

  // Broad tonal bands
  for (let i = 0; i < 14; i++) {
    const y = r() * H, h = 10 + r() * 50;
    g.fillStyle = (r() > 0.5 ? spec.light : spec.dark) + '33';
    g.fillRect(0, y, W, h);
  }
  // Grain lines: gently wavy, tileable because waves use whole periods across W.
  for (let i = 0; i < 170; i++) {
    const y0 = r() * H;
    const amp = 1 + r() * 5;
    const k = (1 + Math.floor(r() * 3)) * (2 * Math.PI) / W;
    const ph = r() * Math.PI * 2;
    const k2 = (3 + Math.floor(r() * 5)) * (2 * Math.PI) / W;
    const dark = r() > 0.35;
    g.strokeStyle = (dark ? spec.dark : spec.light) + (dark ? '88' : '66');
    g.lineWidth = 0.5 + r() * (dark ? 2.2 : 1.5);
    g.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = y0 + amp * Math.sin(k * x + ph) + amp * 0.3 * Math.sin(k2 * x);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // Pores / flecks
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.12})`;
    g.fillRect(r() * W, r() * H, 1 + r() * 4, 1);
  }
  if (spec.knots) {
    for (let i = 0; i < 2; i++) {
      const x = 100 + r() * (W - 200), y = 40 + r() * (H - 80);
      for (let k = 12; k > 0; k--) {
        g.strokeStyle = `rgba(110,60,20,${0.08 + (12 - k) * 0.03})`;
        g.lineWidth = 1.5;
        g.beginPath(); g.ellipse(x, y, k * 2.6, k * 1.2, 0, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = 'rgba(90,45,15,0.8)';
      g.beginPath(); g.ellipse(x, y, 5, 2.5, 0, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

/** A default "painting": an abstract landscape. */
export function defaultPaintingCanvas() {
  const W = 1200, H = 900;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const r = rng(42);

  const sky = g.createLinearGradient(0, 0, 0, H * 0.65);
  sky.addColorStop(0, '#1f3b63');
  sky.addColorStop(0.55, '#d9785a');
  sky.addColorStop(1, '#f3c37a');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // Sun
  const sun = g.createRadialGradient(W * 0.68, H * 0.42, 10, W * 0.68, H * 0.42, 160);
  sun.addColorStop(0, 'rgba(255,240,200,1)');
  sun.addColorStop(0.35, 'rgba(255,210,140,0.9)');
  sun.addColorStop(1, 'rgba(255,180,120,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, W, H);

  // Layered hills
  const hills = ['#7b4a5e', '#5a3c55', '#3f2f4a', '#2a2238', '#1b1726'];
  hills.forEach((col, i) => {
    const base = H * (0.5 + i * 0.1);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) {
      const y = base - 40 * Math.sin(x / (160 + i * 40) + i * 1.7) - 25 * Math.sin(x / (70 + i * 13) + i);
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  });

  // Painterly strokes
  for (let i = 0; i < 1400; i++) {
    const x = r() * W, y = r() * H;
    const px = g.getImageData(Math.min(W - 1, x) | 0, Math.min(H - 1, y) | 0, 1, 1).data;
    const j = (r() - 0.5) * 40;
    g.strokeStyle = `rgba(${px[0] + j},${px[1] + j},${px[2] + j},0.55)`;
    g.lineWidth = 2 + r() * 7;
    g.lineCap = 'round';
    const a = (r() - 0.5) * 0.8;
    const l = 10 + r() * 30;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  return c;
}
