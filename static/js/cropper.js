// "Crop & straighten" dialog: drag four corner handles onto the canvas's corners in a
// photo; the preview shows it straightened (and with the lighting improved, if ticked).
import { loadImage, pixelsOf, detectCorners, defaultCorners, wholePhoto, warp, outputSize, enhance } from './imagefix.js';

const $ = (s) => document.querySelector(s);
const HANDLE = 11, HIT = 30, LOUPE = 62, ZOOM = 3;

// Opens the dialog. Resolves { corners, enhance, dataUrl } on Apply, or null if cancelled.
//   src: the original photo (URL or data URL); corners: saved corners (fractions) or null
//   to detect them; aspect: the painting's width / height if known.
export async function openCropper({ src, corners = null, enhance: enhanceOn = true, aspect = 0 }) {
  const img = await loadImage(src);
  const dlg = $('#cropDialog'), stage = $('#cropCanvas'), prev = $('#cropPreview');
  const sctx = stage.getContext('2d'), pctx = prev.getContext('2d');
  const small = pixelsOf(img, 800); // for the live preview
  let quad = corners && corners.length === 4 ? corners.map((c) => [...c]) : detectCorners(img);
  let drag = -1, fit = null, framePending = false;
  $('#cropEnhance').checked = enhanceOn;

  // ---- drawing
  function layout() {
    const box = stage.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const w = Math.max(1, Math.floor(img.naturalWidth * k)), h = Math.max(1, Math.floor(img.naturalHeight * k));
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    stage.width = Math.round(w * dpr);
    stage.height = Math.round(h * dpr);
    fit = { w, h, dpr };
    draw();
  }

  const toScreen = ([x, y]) => [x * fit.w, y * fit.h];

  function draw() {
    if (!fit) return;
    const { w, h, dpr } = fit;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(img, 0, 0, w, h);
    const pts = quad.map(toScreen);
    // Dim everything outside the quad.
    sctx.save();
    sctx.beginPath();
    sctx.rect(0, 0, w, h);
    sctx.moveTo(...pts[0]);
    for (let i = 3; i >= 1; i--) sctx.lineTo(...pts[i]);
    sctx.closePath();
    sctx.fillStyle = 'rgba(0, 0, 0, .45)';
    sctx.fill('evenodd');
    sctx.restore();
    // Outline; the top edge in orange so it's clear which way up the result will be.
    sctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      sctx.beginPath();
      sctx.moveTo(...pts[i]);
      sctx.lineTo(...pts[(i + 1) % 4]);
      sctx.strokeStyle = i === 0 ? '#ff8a3d' : '#ffffff';
      sctx.lineWidth = i === 0 ? 3.5 : 2;
      sctx.stroke();
    }
    for (const [i, [x, y]] of pts.entries()) {
      sctx.beginPath();
      sctx.arc(x, y, HANDLE, 0, Math.PI * 2);
      sctx.fillStyle = i === drag ? 'rgba(255, 138, 61, .55)' : 'rgba(255, 255, 255, .35)';
      sctx.fill();
      sctx.lineWidth = 2;
      sctx.strokeStyle = i < 2 ? '#ff8a3d' : '#ffffff';
      sctx.stroke();
    }
    if (drag >= 0) drawLoupe(pts[drag]);
  }

  // A magnified view of the photo around the handle being dragged, clear of the finger.
  function drawLoupe([x, y]) {
    const { w } = fit;
    const cx = Math.min(Math.max(x, LOUPE + 4), w - LOUPE - 4);
    const cy = y > LOUPE * 2 + 30 ? y - LOUPE - 34 : y + LOUPE + 34;
    const sx = (x / fit.w) * img.naturalWidth, sy = (y / fit.h) * img.naturalHeight;
    const srcR = (LOUPE / ZOOM) * (img.naturalWidth / fit.w);
    sctx.save();
    sctx.beginPath();
    sctx.arc(cx, cy, LOUPE, 0, Math.PI * 2);
    sctx.clip();
    sctx.drawImage(img, sx - srcR, sy - srcR, srcR * 2, srcR * 2, cx - LOUPE, cy - LOUPE, LOUPE * 2, LOUPE * 2);
    sctx.strokeStyle = '#ff8a3d';
    sctx.lineWidth = 1;
    sctx.beginPath();
    sctx.moveTo(cx - LOUPE, cy); sctx.lineTo(cx + LOUPE, cy);
    sctx.moveTo(cx, cy - LOUPE); sctx.lineTo(cx, cy + LOUPE);
    sctx.stroke();
    sctx.restore();
    sctx.beginPath();
    sctx.arc(cx, cy, LOUPE, 0, Math.PI * 2);
    sctx.lineWidth = 3;
    sctx.strokeStyle = '#ffffff';
    sctx.stroke();
  }

  function renderPreview() {
    framePending = false;
    const { W, H } = outputSize(small, quad, aspect, 420);
    const out = warp(small, quad, W, H);
    if ($('#cropEnhance').checked) enhance(out);
    prev.width = W;
    prev.height = H;
    pctx.putImageData(out, 0, 0);
  }
  const schedulePreview = () => { if (!framePending) { framePending = true; requestAnimationFrame(renderPreview); } };
  const update = () => { draw(); schedulePreview(); };

  // ---- dragging
  const pointAt = (e) => {
    const r = stage.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  stage.onpointerdown = (e) => {
    const [px, py] = pointAt(e);
    let bestD = Infinity;
    quad.forEach(([x, y], i) => {
      const d = Math.hypot((x - px) * fit.w, (y - py) * fit.h);
      if (d < bestD) { bestD = d; drag = i; }
    });
    if (bestD > HIT * (e.pointerType === 'touch' ? 1.6 : 1)) { drag = -1; return; }
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  };
  stage.onpointermove = (e) => {
    if (drag < 0) {
      // Show a grab cursor over a handle.
      const [px, py] = pointAt(e);
      stage.style.cursor = quad.some(([x, y]) => Math.hypot((x - px) * fit.w, (y - py) * fit.h) < HIT) ? 'grab' : 'default';
      return;
    }
    const [px, py] = pointAt(e);
    quad[drag] = [Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py))];
    update();
  };
  stage.onpointerup = stage.onpointercancel = () => { if (drag >= 0) { drag = -1; update(); } };

  // ---- buttons
  $('#cropEnhance').onchange = schedulePreview;
  $('#cropRotate').onclick = () => { quad = [quad[3], quad[0], quad[1], quad[2]]; update(); };
  $('#cropAuto').onclick = () => { quad = detectCorners(img); update(); };
  $('#cropWhole').onclick = () => { quad = wholePhoto(); update(); };
  $('#cropReset').onclick = () => { quad = defaultCorners(); update(); };
  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  return new Promise((resolve) => {
    let result = null;
    $('#cropCancel').onclick = () => dlg.close();
    $('#cropApply').onclick = () => {
      $('#cropApply').disabled = true;
      $('#cropApply').textContent = 'Working…';
      // Let the button update before the (full-size) warp.
      setTimeout(() => {
        try {
          const full = pixelsOf(img, 2400);
          const { W, H } = outputSize(full, quad, aspect, 2000);
          const out = warp(full, quad, W, H);
          const on = $('#cropEnhance').checked;
          if (on) enhance(out);
          const c = document.createElement('canvas');
          c.width = W;
          c.height = H;
          c.getContext('2d').putImageData(out, 0, 0);
          result = { corners: quad.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]), enhance: on, dataUrl: c.toDataURL('image/jpeg', 0.9) };
        } finally {
          dlg.close();
        }
      }, 30);
    };
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      window.removeEventListener('resize', onResize);
      $('#cropApply').disabled = false;
      $('#cropApply').textContent = 'Apply';
      resolve(result);
    });
    dlg.showModal();
    requestAnimationFrame(() => { layout(); renderPreview(); });
  });
}
