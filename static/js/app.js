import { computeFrame, solveQuad, FENCE_FACES, onInnerSide, CORNER_SYMBOL } from './geometry.js';
import { buildDrawing } from './drawing.js';
import { SPECIES } from './textures.js';
import { VERSION, CHANGELOG } from './version.js';
import { nextSku, DEFAULT_SKU_FORMAT } from './sku.js';
import { startTour } from './tour.js';
import { openCropper } from './cropper.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').trim().toLowerCase();

const UI_KEY = 'floating-frame:ui';
let currentUser = null; // signed-in username when the server has accounts on
// Unsaved work is cached per user so people sharing a browser don't see each other's drafts.
const draftKey = () => 'floating-frame:draft' + (currentUser ? ':' + currentUser : '');

const PAINTING_TEXT = ['sku', 'title', 'artist'];
const PAINTING_NUM = ['topWidth', 'bottomWidth', 'leftHeight', 'rightHeight', 'depth', 'diagA', 'diagB'];
const PAINTING_BOOL = ['sameWidth', 'sameHeight'];
const SETTING_NUM = ['goodThickness', 'cheapThickness', 'cheapWidth', 'gap', 'lip', 'tapeDistance', 'tapeThickness', 'kerf'];

// ---------------------------------------------------------------- API
const api = {
  async req(method, url, body, headers = {}) {
    const opts = { method, headers };
    if (body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = body.type; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.startsWith('api/auth')) {
      saveDraft();
      showAuth('login', 'Your session has ended - please sign in again.');
    }
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  },
  auth: () => api.req('GET', 'api/auth'),
  authPost: (action, body) => api.req('POST', `api/auth/${action}`, body || {}),
  invite: () => api.req('GET', 'api/admin/invite'),
  inviteAction: (action) => api.req('POST', 'api/admin/invite', { action }),
  state: () => api.req('GET', 'api/state'),
  saveSettings: (s) => api.req('PUT', 'api/settings', s),
  savePainting: (p) => api.req('POST', 'api/paintings', p),
  deletePainting: (id) => api.req('DELETE', `api/paintings/${id}`),
  uploadImage: (id, blob, original = false) => api.req('POST', `api/paintings/${id}/image${original ? '?original=1' : ''}`, blob),
  deleteImage: (id) => api.req('DELETE', `api/paintings/${id}/image`),
  setShare: (id, share) => api.req('POST', `api/paintings/${id}/share`, { share }),
  shared: (token) => api.req('GET', `api/share/${encodeURIComponent(token)}`),
  timer: (action) => api.req('POST', 'api/timer', { action }),
  addTime: (id, minutes, note) => api.req('POST', `api/paintings/${id}/time`, { minutes, note }),
  deleteTime: (id, entry) => api.req('DELETE', `api/paintings/${id}/time/${entry}`),
  setCuts: (id, sig, done) => api.req('POST', `api/paintings/${id}/cuts`, { sig, done }),
  setStatus: (id, status) => api.req('POST', `api/paintings/${id}/status`, { status }),
  addArtist: (name) => api.req('POST', 'api/artists', { name }),
  deleteArtist: (name) => api.req('DELETE', `api/artists/${encodeURIComponent(name)}`),
};

// ---------------------------------------------------------------- State
let db = { settings: {}, paintings: [], artists: [], timer: {} };
let clockSkew = 0; // server clock minus this computer's, in seconds (for the build timer)

// Take a library state from the server.
function setDb(res) {
  db = { settings: res.settings, paintings: res.paintings, artists: res.artists, timer: res.timer || {} };
  if (res.now) clockSkew = res.now - Date.now() / 1000;
}
let cur = null; // the painting being edited
let savedSnapshot = null; // JSON of `cur` as last saved/loaded, for dirty tracking
let frame = null;
let viewer = null;
let activeTab = 'cut';
let drawingDirty = true, modelDirty = true;
let selectedEnd = null; // the piece end (e.g. 'top:TL') shown on the sled diagram, or null for the general view
// Opened from a share link: the painting is read only, the frame settings can be tried out but aren't saved.
const SHARE_TOKEN = new URLSearchParams(location.search).get('share');
const viewOnly = !!SHARE_TOKEN;

function blankPainting() {
  return {
    id: null, sku: '', title: '', artist: '',
    topWidth: null, bottomWidth: null, sameWidth: true,
    leftHeight: null, rightHeight: null, sameHeight: true,
    depth: null, diagA: null, diagB: null,
    image: null, // saved image filename on the server
    status: null, // frame status: null (not started), 'building' or 'made'; saved straight away
    buildingAt: null, madeAt: null, // when it got to that status (seconds)
    pendingImage: null, // data URL of a newly chosen image (uploaded on save)
    imageOriginal: null, // saved original photo the image was cropped from (server filename)
    pendingOriginal: null, // data URL of a new original photo (uploaded on save)
    imageCrop: null, // { corners, enhance } used to make the image from the original
    cuts: null, // { sig, done: { 'top:TL': true, ... } } cuts ticked off, saved straight away
    removeImage: false,
    settings: { ...db.settings },
  };
}

function fromRecord(rec) {
  const p = blankPainting();
  for (const k of [...PAINTING_TEXT, ...PAINTING_NUM, ...PAINTING_BOOL, 'id', 'image', 'imageOriginal', 'imageCrop', 'cuts', 'updatedAt', 'status', 'buildingAt', 'madeAt', 'shareToken']) if (k in rec) p[k] = rec[k];
  p.settings = { ...db.settings, ...(rec.settings || {}) };
  return p;
}

function toRecord(p) {
  const r = { id: p.id || undefined, settings: p.settings };
  for (const k of [...PAINTING_TEXT, ...PAINTING_NUM, ...PAINTING_BOOL]) r[k] = p[k];
  r.imageCrop = p.imageCrop || null;
  return r;
}

const snapshotOf = (p) => JSON.stringify({ ...toRecord(p), pendingImage: !!p.pendingImage, pendingOriginal: !!p.pendingOriginal, removeImage: p.removeImage });
const isDirty = () => cur && snapshotOf(cur) !== savedSnapshot;

// ---------------------------------------------------------------- Form binding
function writeForm() {
  for (const el of $$('[data-p]')) {
    const k = el.dataset.p;
    if (el.type === 'checkbox') el.checked = !!cur[k];
    else el.value = cur[k] ?? '';
  }
  for (const el of $$('[data-s]')) el.value = cur.settings[el.dataset.s] ?? '';
  syncSameFields();
}

function readField(el) {
  const k = el.dataset.p ?? el.dataset.s;
  const target = el.dataset.p ? cur : cur.settings;
  if (el.type === 'checkbox') target[k] = el.checked;
  else if (el.type === 'number') target[k] = el.value === '' ? null : parseFloat(el.value);
  else target[k] = el.value;
}

function syncSameFields() {
  const b = $('#f-bottom'), r = $('#f-right');
  b.disabled = viewOnly || !!cur.sameWidth;
  r.disabled = viewOnly || !!cur.sameHeight;
  if (cur.sameWidth) b.value = cur.topWidth ?? '';
  if (cur.sameHeight) r.value = cur.leftHeight ?? '';
}

function paintingInput() {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  return {
    top: n(cur.topWidth),
    bottom: n(cur.sameWidth ? cur.topWidth : cur.bottomWidth),
    left: n(cur.leftHeight),
    right: n(cur.sameHeight ? cur.leftHeight : cur.rightHeight),
    depth: n(cur.depth),
    diagA: n(cur.diagA) > 0 ? cur.diagA : 0,
    diagB: n(cur.diagB) > 0 ? cur.diagB : 0,
  };
}

function settingsInput() {
  const s = { ...cur.settings };
  for (const k of SETTING_NUM) s[k] = typeof s[k] === 'number' ? s[k] : parseFloat(s[k]);
  return s;
}

// ---------------------------------------------------------------- Recompute & render
function recompute() {
  frame = computeFrame(paintingInput(), settingsInput());
  renderMeasureDiagram();
  renderCutList();
  renderWorkshop();
  updateSkuPreview();
  modelDirty = drawingDirty = true;
  refreshVisiblePanel();
  updateStatus();
  saveDraft();
  updateMatchHint();
}

// The little painting outline beside the size inputs, drawn to the proportions
// of the entered sides (and diagonals, if given).
function renderMeasureDiagram() {
  const p = paintingInput();
  const quad = ['top', 'bottom', 'left', 'right'].every((k) => p[k] > 0) ? solveQuad(p) : null;
  // Fallback when sides are missing: a slightly irregular example shape.
  const pts = quad ? quad.pts : [[-39, -32], [41, -33], [40, 33], [-39, 31]];
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min(80 / (maxX - minX), 64 / (maxY - minY));
  const cx = 61, cy = 51, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = (q) => [cx + (q[0] - mx) * k, cy - (q[1] - my) * k]; // y up -> SVG y down
  const [bl, br, tr, tl] = pts.map(P);
  const L = (x) => x.toFixed(1);
  const top = cy - ((maxY - my) * k), bottom = cy + ((my - minY) * k);
  const left = cx - ((mx - minX) * k), right = cx + ((maxX - mx) * k);
  $('#measureDiagram').innerHTML = `
    <polygon points="${[bl, br, tr, tl].map((q) => q.map(L).join(',')).join(' ')}" fill="var(--canvas-fill)" stroke="currentColor" stroke-width="1.5"/>
    <line x1="${L(bl[0])}" y1="${L(bl[1])}" x2="${L(tr[0])}" y2="${L(tr[1])}" stroke="currentColor" stroke-dasharray="3 2" opacity=".45"/>
    <line x1="${L(tl[0])}" y1="${L(tl[1])}" x2="${L(br[0])}" y2="${L(br[1])}" stroke="currentColor" stroke-dasharray="3 2" opacity=".45"/>
    <text x="${cx}" y="${L(top - 5)}" text-anchor="middle">Top</text>
    <text x="${cx}" y="${L(bottom + 11)}" text-anchor="middle">Bottom</text>
    <text x="${L(left - 5)}" y="${cy}" text-anchor="middle" transform="rotate(-90 ${L(left - 5)} ${cy})">Left</text>
    <text x="${L(right + 5)}" y="${cy}" text-anchor="middle" transform="rotate(90 ${L(right + 5)} ${cy})">Right</text>`;
}

function refreshVisiblePanel() {
  if (activeTab === 'model' && modelDirty) { renderModel(); modelDirty = false; }
  if (activeTab === 'drawing' && drawingDirty) { renderDrawing(); drawingDirty = false; }
}

// ---------------------------------------------------------------- Cut list
// One row per L piece: the length to cut (good wood long point) and, for each end, the
// mitre angle with its tape setup, so everything for a piece is together. Ends can be
// ticked off as they're cut; "By tape setup" groups the cuts so the tape is set once.

const tapeKey = (t) => (t.invalid ? 'invalid' : t.layers === 0 ? 'none' : `${t.location}${t.layers}`);
const tapeText = (t) => (t.invalid ? 'check setup' : t.layers === 0 ? 'no tape' : `${t.location === 'far' ? 'FAR' : 'NEAR'} ×${t.layers}`);
const tapeClass = (t) => (t.invalid || t.layers === 0 ? 'none' : t.location);

// The tape setup as a chip; tapping it shows that end's setup on the sled diagram.
function tapeChip(t, e, big = false) {
  return `<button type="button" class="tape-chip ${tapeClass(t)}${big ? ' big' : ''}${e.cut === selectedEnd ? ' selected' : ''}" data-end="${e.cut}" title="Show this setup on the sled diagram">${tapeText(t)}</button>`;
}

function tapeWords(t) {
  if (t.invalid) return 'check the cutting setup';
  if (t.layers === 0) return 'no tape - straight off the 45° fence';
  return `${t.layers} layer${t.layers === 1 ? '' : 's'} (${f2(t.shim)} mm) at the ${t.location === 'far' ? 'FAR point' : 'NEAR point, by the blade'}`;
}

// The sled has two 45\u00B0 fences in a V, one each side of the blade. A piece's two ends are
// mirror images, so they're cut on opposite fences, and the two mating cuts at every corner
// always end up on opposite fences, which cancels out any error in the jig's angles.
// These ends go on the right-hand fence (as you stand at the sled) with the L the right way
// up; turning the L upside down (good wood inner face against the fence) swaps them over.
const RIGHT_FENCE_UPRIGHT = new Set(['top:TL', 'bottom:BR', 'left:BL', 'right:TR']);
function fenceFor(cut, s = settingsInput()) {
  const upsideDown = s.fenceEdge === 'goodInner';
  return RIGHT_FENCE_UPRIGHT.has(cut) !== upsideDown ? 'right' : 'left';
}
const fenceName = (f) => (f === 'right' ? 'R fence' : 'L fence');
const fenceBadge = (f) => `<span class="fence-badge ${f}" title="Cut on the ${f}-hand fence">${fenceName(f)}</span>`;

// The corner's symbol (see CORNER_SYMBOL), to pencil on both mating ends.
const symbolBadge = (key) => `<span class="corner-symbol" title="Mark this end with ${CORNER_SYMBOL[key]} - it joins the other ${CORNER_SYMBOL[key]} end at the ${key} corner">${CORNER_SYMBOL[key]}</span>`;

// A piece's two ends in reading order: left then right for Top/Bottom, top then bottom
// for Left/Right. Each is { strip, ci (corner index), key (e.g. 'TL'), label, cut (tick key), fence }.
function pieceEnds(frame, st) {
  const horizontal = st.key === 'top' || st.key === 'bottom';
  const ends = st.corners.map((ci) => ({ strip: st, ci, key: frame.corners[ci].key }));
  ends.sort((a, b) => (horizontal ? (a.key[1] === 'L' ? -1 : 1) : (a.key[0] === 'T' ? -1 : 1)));
  const labels = horizontal ? ['left end', 'right end'] : ['top end', 'bottom end'];
  return ends.map((e, i) => {
    const cut = `${st.key}:${e.key}`;
    return { ...e, label: labels[i], cut, fence: fenceFor(cut) };
  });
}
const findEnd = (frame, cut) => frame.strips.flatMap((st) => pieceEnds(frame, st)).find((e) => e.cut === cut) || null;

// Rows in Top, Bottom, Left, Right order. Opposite pieces that come out the same (length,
// and the angle and tape at each end) share a row, with their matching ends side by side.
function pieceRows(frame) {
  const byKey = Object.fromEntries(frame.strips.map((st) => [st.key, st]));
  const sig = (e) => `${f2(frame.corners[e.ci].mitre)}|${tapeKey(frame.corners[e.ci].tape)}|${e.fence}`;
  const rows = [];
  for (const [a, b, name] of [['top', 'bottom', 'Top & Bottom'], ['left', 'right', 'Left & Right']]) {
    const A = byKey[a], B = byKey[b];
    const ea = pieceEnds(frame, A), eb = pieceEnds(frame, B);
    const sameLen = f1(A.good.longPoint) === f1(B.good.longPoint);
    const pairB = sameLen && sig(ea[0]) === sig(eb[0]) && sig(ea[1]) === sig(eb[1]) ? eb
      : sameLen && sig(ea[0]) === sig(eb[1]) && sig(ea[1]) === sig(eb[0]) ? [eb[1], eb[0]] : null;
    if (pairB) rows.push({ name, strips: [A, B], ends: [[ea[0], pairB[0]], [ea[1], pairB[1]]] });
    else for (const [st, ends] of [[A, ea], [B, eb]]) rows.push({ name: st.name, strips: [st], ends: ends.map((e) => [e]) });
  }
  return rows;
}

// ---- ticking cuts off
// Identifies the cut plan: if lengths or tape setups change, earlier ticks no longer apply.
function cutPlanSig(frame) {
  return frame.strips.map((st) => `${st.key}:${f1(st.good.longPoint)}:${pieceEnds(frame, st).map((e) => e.key + tapeKey(frame.corners[e.ci].tape) + e.fence[0]).join(',')}`).join('|');
}
const cutsDone = () => (cur.cuts && frame && frame.ok && cur.cuts.sig === cutPlanSig(frame) ? cur.cuts.done || {} : {});
const staleCuts = () => !!(cur.cuts && frame && frame.ok && cur.cuts.sig !== cutPlanSig(frame) && Object.keys(cur.cuts.done || {}).length);
const ALL_CUTS = () => frame.strips.flatMap((st) => pieceEnds(frame, st).map((e) => e.cut));

function tickBox(e, text = '') {
  const done = !!cutsDone()[e.cut];
  const off = !cur.id ? ' disabled title="Save the painting to tick off cuts"' : '';
  return `<label class="tick${done ? ' done' : ''}"><input type="checkbox" data-cut="${e.cut}"${done ? ' checked' : ''}${off}>${text ? ` <span>${text}</span>` : ''}</label>`;
}

async function setCut(key, on) {
  if (!cur.id || !frame || !frame.ok) return;
  const sig = cutPlanSig(frame);
  const done = { ...cutsDone() };
  if (on) done[key] = true; else delete done[key];
  cur.cuts = { sig, done };
  renderCutList();
  renderWorkshop();
  try {
    const res = await api.setCuts(cur.id, sig, done);
    setDb(res);
    cur.cuts = res.painting.cuts || null;
  } catch (e) { toast("Couldn't save the tick: " + e.message, true); }
  const n = Object.keys(done).length, total = ALL_CUTS().length;
  if (on && n === total) toast('All cuts done');
}

async function clearCuts() {
  if (!cur.id || !confirm('Clear all the ticks for this frame?')) return;
  cur.cuts = { sig: cutPlanSig(frame), done: {} };
  renderCutList();
  try { setDb(await api.setCuts(cur.id, cur.cuts.sig, {})); } catch (e) { toast(e.message, true); }
}

// Whether this cut sets the piece's length: it does once the other end has been cut.
// In piece order (the workshop view) the second end is the length cut by default.
function lengthHint(frame, e, pieceOrder = false) {
  const ends = pieceEnds(frame, e.strip), done = cutsDone();
  const other = ends.find((x) => x.cut !== e.cut);
  const len = `<b class="len">${f1(e.strip.good.longPoint)}</b>`;
  if (done[other.cut]) return `cut to ${len}`;
  if (pieceOrder && !done[e.cut] && e.cut === ends[1].cut) return `then cut to ${len}`;
  return '<span class="sub">first end - just mitre it, leave the piece long</span>';
}

function renderCutList() {
  const host = $('#panel-cut');
  const p = paintingInput();
  const missing = ['top', 'left', 'depth'].some((k) => !(p[k] > 0));
  if (missing && frame.errors.every((e) => /required/.test(e))) {
    host.innerHTML = `<div class="empty"><p><b>Enter the painting's measurements</b> on the left to get the cut list.</p><p>Top width, left height and canvas depth are the minimum (bottom and right default to the same).</p></div>`;
    return;
  }
  const alerts = [
    ...frame.errors.map((e) => `<div class="alert err">${esc(e)}</div>`),
    ...frame.warnings.map((w) => `<div class="alert warn">${esc(w)}</div>`),
  ].join('');
  if (!frame.ok) { host.innerHTML = `<div class="alerts">${alerts}</div>`; return; }

  const s = settingsInput();
  const q = frame.quad;
  const view = loadUi().cutView === 'tape' ? 'tape' : 'piece';
  const done = cutsDone();
  const total = ALL_CUTS().length, nDone = ALL_CUTS().filter((k) => done[k]).length;

  // ---- by piece
  const endCell = (entries) => {
    const c = frame.corners[entries[0].ci];
    const where = entries.length > 1
      ? entries.map((e) => `${symbolBadge(e.key)} ${e.key}`).join(' / ')
      : `${symbolBadge(entries[0].key)} ${entries[0].label} \u00B7 ${entries[0].key}`;
    const ticks = viewOnly ? '' : `<div class="ticks">${entries.map((e) => tickBox(e, entries.length > 1 ? e.strip.name : 'cut')).join('')}</div>`;
    return `<td class="end-cell"><div class="end-main"><span class="angle">${f2(c.mitre)}\u00B0</span> ${tapeChip(c.tape, entries[0])} ${fenceBadge(entries[0].fence)}</div><div class="sub">${where}</div>${ticks}</td>`;
  };
  const pieceTable = pieceRows(frame).map((r) => {
    const cuts = r.ends.flat().map((e) => e.cut);
    const rowDone = !viewOnly && cuts.every((k) => done[k]);
    const painting = r.strips.length > 1 && f1(r.strips[0].paintingLength) !== f1(r.strips[1].paintingLength)
      ? r.strips.map((x) => f1(x.paintingLength)).join(' / ')
      : f1(r.strips[0].paintingLength);
    return `<tr class="${rowDone ? 'piece-done' : ''}">
      <td><b>${r.name}</b>${r.strips.length > 1 ? ' <span class="sub">×2</span>' : ''}<div class="sub">painting ${painting}</div></td>
      <td class="num"><span class="len">${f1(r.strips[0].good.longPoint)}</span></td>
      ${endCell(r.ends[0])}${endCell(r.ends[1])}
    </tr>`;
  }).join('');

  // ---- by tape setup: every end, grouped so each setup is made once
  const groups = new Map();
  for (const key of ['top', 'bottom', 'left', 'right']) {
    const st = frame.strips.find((x) => x.key === key);
    for (const e of pieceEnds(frame, st)) {
      // Each fence is taped separately, so a setup is per fence.
      const t = frame.corners[e.ci].tape, k = `${e.fence}|${tapeKey(t)}`;
      if (!groups.has(k)) groups.set(k, { t, fence: e.fence, items: [] });
      groups.get(k).items.push(e);
    }
  }
  const order = (g) => (g.fence === 'left' ? 0 : 10000) + (g.t.invalid ? 9e3 : g.t.layers === 0 ? 0 : (g.t.location === 'far' ? 1000 : 2000) + g.t.layers);
  const tapeGroups = [...groups.values()].sort((a, b) => order(a) - order(b)).map((g) => {
    const left = g.items.filter((e) => !done[e.cut]).length;
    return `<div class="tape-group${left ? '' : ' group-done'}">
      <div class="tape-group-head">${fenceBadge(g.fence)} ${tapeChip(g.t, g.items[0], true)} <span>${tapeWords(g.t)}</span> <span class="sub">${left ? `${left} of ${g.items.length} cut${g.items.length === 1 ? '' : 's'} left` : 'all done'}</span></div>
      <ul class="tape-cuts">${g.items.map((e) => `<li class="${done[e.cut] ? 'cut-done' : ''}">
        ${viewOnly ? '' : tickBox(e)}
        <span>${symbolBadge(e.key)} <b>${e.strip.name}</b> ${e.label} <span class="sub">${e.key}</span></span>
        <span class="angle">${f2(frame.corners[e.ci].mitre)}°</span>
        <span class="cut-hint">${lengthHint(frame, e)}</span>
      </li>`).join('')}</ul>
    </div>`;
  }).join('');

  const dg = frame.diagonals;
  const diagDiff = (d) => Math.abs(d.a - d.b);
  const cornerRows = frame.corners.map((c) => `<tr>
      <td>${symbolBadge(c.key)} <b>${c.key}</b> <span class="sub">${c.name}</span></td>
      <td class="num">${f2(c.angle)}°</td>
      <td class="num angle">${f2(c.mitre)}°</td>
      <td><span class="tape-chip ${tapeClass(c.tape)}">${tapeText(c.tape)}</span></td>
      <td class="num">${f2(c.tape.result)}°</td>
      <td class="num">${Math.abs(c.tape.error) < 0.005 ? '0.00' : (c.tape.error > 0 ? '+' : '') + f2(c.tape.error)}°</td>
      <td class="num">${c.jointOpening < 0.05 ? '<span class="sub">&lt; 0.05</span>' : f2(c.jointOpening)} <span class="sub">${c.jointOpening < 0.05 ? '' : c.openingAt === 'inner' ? 'inside' : 'outside'}</span></td>
    </tr>`).join('');

  const perLayer = (Math.atan(s.tapeThickness / s.tapeDistance) * 180) / Math.PI;
  const face = FENCE_FACES[s.fenceEdge] || FENCE_FACES.outer;
  const outerFence = !onInnerSide(s.fenceEdge);
  const farEffect = outerFence ? 'smaller (more acute)' : 'larger';
  const nearEffect = outerFence ? 'larger' : 'smaller (more acute)';
  const openDetails = $('#accuracyDetails') ? $('#accuracyDetails').open : false;

  host.innerHTML = `
    ${alerts ? `<div class="alerts">${alerts}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Outer frame size</div><div class="v">${f1(frame.outerSize.top)} × ${f1(frame.outerSize.left)}</div><div class="s">top × left, outside edges</div></div>
      <div class="stat"><div class="k">Good wood stock</div><div class="v">${f1(s.goodThickness)} × ${f1(frame.goodWidth)}</div><div class="s">thickness × width · need ≥ ${f1(frame.stock.good)} long</div></div>
      <div class="stat"><div class="k">Cheap wood stock</div><div class="v">${f1(s.cheapThickness)} × ${f1(s.cheapWidth)}</div><div class="s">thickness × width · need ≥ ${f1(frame.stock.cheap)} long</div></div>
      <div class="stat"><div class="k">Canvas support</div><div class="v">${f1(frame.support)}</div><div class="s">cheap strip reaches under the canvas</div></div>
    </div>

    <div class="cut-head">
      <h3>Cut list</h3>
      <div class="seg" role="group" aria-label="Arrange the cut list">
        <button type="button" data-cut-view="piece" class="${view === 'piece' ? 'active' : ''}">By piece</button>
        <button type="button" data-cut-view="tape" class="${view === 'tape' ? 'active' : ''}">By tape setup</button>
      </div>
      ${viewOnly ? '' : `<span class="cut-progress">${nDone} of ${total} cuts done${nDone ? ' · <button type="button" class="link" data-cuts-clear>clear</button>' : ''}</span>`}
      <button type="button" class="workshop-btn" data-workshop>&#9974; Workshop view</button>
    </div>
    ${staleCuts() ? '<div class="alert warn">The measurements or cutting setup changed since you ticked cuts, so those ticks have been cleared.</div>' : ''}
    <p class="note" style="margin-top:0">Glue each cheap strip to its good wood strip ${frame.inside ? '(against the inside face, at the back)' : '(underneath, outer edges flush)'}, then mitre both ends of the L in one cut. Cut to the <b>long point</b>: the outer (visible) edge of the good wood. Each piece's two ends go on opposite fences (<b>L</b> or <b>R</b>, as you stand at the sled). Pencil each end's symbol on it: ends with the same symbol join at a corner (\u25CB top-left, \u25B3 top-right, \u25A1 bottom-right, \u2715 bottom-left). Tap a tape setup to see it on the sled diagram below.</p>
    ${view === 'piece' ? `
    <div class="table-wrap"><table class="table cut-table">
      <thead><tr><th>Piece</th><th class="num">Cut to</th><th>End 1</th><th>End 2</th></tr></thead>
      <tbody>${pieceTable}</tbody>
    </table></div>` : `
    <p class="note">Set the tape on that fence once for each group and make all its cuts. A piece's second cut sets its length.</p>
    <div class="tape-groups">${tapeGroups}</div>`}

    <h3>Using the tape shims</h3>
    <div class="guide" id="tapeGuide">
      ${selectedGuideSvg(frame, s)}
      <div>
        ${cornerCaption(frame)}
        <div class="guide-label">Against the 45° fence:</div>
        <div class="seg guide-toggle" role="group" aria-label="Face against the fence">
          ${Object.entries(FENCE_FACES).map(([k, f]) => `<button type="button" data-fence-edge="${k}" class="${k === s.fenceEdge ? 'active' : ''}">${f.short}</button>`).join('')}
        </div>
        <div>Each end goes on the <b>${face.side} side</b> of its fence so the long point ends up on the outside of the frame${
          s.fenceEdge === 'goodInner' ? '. Lay the L <b>upside down</b>: the good wood\'s front edge on the sled, the cheap wood on top reaching over the fence.' : '.'}</div>
        <ul>
          <li><span class="tag far">FAR end</span> tape on the fence ~${f1(s.tapeDistance)} mm from the blade makes the mitre <b>${farEffect}</b> than 45°.</li>
          <li><span class="tag near">NEAR blade</span> tape on the fence right next to the blade makes it <b>${nearEffect}</b> than 45°.</li>
          <li>Stack the layers at one point only - the strip should still touch the bare fence (or its tape) at both points.</li>
          <li>The two mating ends at each corner are cut on opposite fences, so if the jig's fences aren't exactly 45\u00B0 the errors cancel out and the joint still closes.</li>
        </ul>
      </div>
    </div>

    <h3>Diagonals - check the glued-up frame</h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Diagonal</th><th class="num">Outside corners</th><th class="num">Inside (good wood)</th><th class="num">Painting</th></tr></thead>
      <tbody>
        <tr><td><b>BL → TR</b></td><td class="num big">${f1(dg.outer.a)}</td><td class="num">${f1(dg.inner.a)}</td><td class="num">${f1(q.diagA)}</td></tr>
        <tr><td><b>TL → BR</b></td><td class="num big">${f1(dg.outer.b)}</td><td class="num">${f1(dg.inner.b)}</td><td class="num">${f1(q.diagB)}</td></tr>
      </tbody>
    </table></div>
    <p class="note">Measure the assembled frame corner to corner before the glue sets. ${diagDiff(dg.outer) < 0.05
      ? 'The two diagonals should be equal.'
      : `This painting isn't square, so the diagonals should differ by ${f1(diagDiff(dg.outer))} mm (outside) - match these numbers rather than making them equal.`}</p>

    <details class="more accuracy" id="accuracyDetails"${openDetails ? ' open' : ''}>
      <summary>Accuracy details: corner angles, errors and joint gaps</summary>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Corner</th><th class="num">Frame angle</th><th class="num">Mitre (both strips)</th><th>Tape</th><th class="num">You'll cut</th><th class="num">Error</th><th class="num">Joint gap (mm)</th></tr></thead>
        <tbody>${cornerRows}</tbody>
      </table></div>
      <p class="note">Each layer of tape (${s.tapeThickness} mm at ${s.tapeDistance} mm) turns the strip about ${f2(perLayer)}°. Layers are rounded towards the slightly more acute side so the joint closes at the visible outside corner and any gap is on the inside, hidden against the painting.
      Painting shape ${q.method === 'diagonals' ? `fitted to your diagonal${p.diagA && p.diagB ? 's' : ''} (off by ${f1(q.diagResidual)} mm)` : 'assumed "most square" - measure its diagonals to check'}: BL→TR <b>${f1(q.diagA)}</b>, TL→BR <b>${f1(q.diagB)}</b>.</p>
    </details>`;
}

// The sled diagram for the selected end (on its fence), or the general view.
function selectedGuideSvg(frame, s) {
  const e = selectedEnd ? findEnd(frame, selectedEnd) : null;
  return e ? endGuideSvg(frame, s, e) : tapeGuideSvg(s);
}
function endGuideSvg(frame, s, e) {
  const c = frame.corners[e.ci];
  return tapeGuideSvg(s, c, { mirror: e.fence === 'left', heading: `${CORNER_SYMBOL[e.key]} ${e.strip.name} \u00B7 ${e.label}`, fenceSide: e.fence });
}

// Which end the tape diagram is showing, and its mate on the other fence.
function cornerCaption(frame) {
  const e = selectedEnd ? findEnd(frame, selectedEnd) : null;
  if (!e) return '<p class="guide-pick">Tap a tape setup in the cut list to show it here.</p>';
  const c = frame.corners[e.ci], t = c.tape;
  const mate = frame.strips.flatMap((st) => pieceEnds(frame, st)).find((x) => x.ci === e.ci && x.cut !== e.cut);
  return `<div class="guide-pick active">${symbolBadge(e.key)} <b>${e.strip.name} piece, ${e.label}</b> on the <b>${e.fence}-hand fence</b>: ${tapeWords(t)}, to cut <span class="angle">${f2(t.result)}\u00B0</span>
    for the ${f2(c.mitre)}\u00B0 mitre.${mate ? ` Its mate, the ${mate.strip.name.toLowerCase()} piece's ${mate.label}, goes on the ${mate.fence}-hand fence with the same tape.` : ''}
    <button type="button" class="link" data-corner-clear>Show both points</button></div>`;
}

// ---------------------------------------------------------------- Workshop view
// Full screen, one piece at a time, big enough to read from the bench.
let workshopStep = 0;
const WORKSHOP_PIECES = ['top', 'bottom', 'left', 'right'];

function renderWorkshop() {
  const dlg = $('#workshopDialog');
  if (!dlg || !dlg.open) return;
  const body = $('#workshopBody');
  if (!frame || !frame.ok) { body.innerHTML = '<p class="ws-empty">Enter the painting\'s measurements to get the cut list.</p>'; return; }
  const s = settingsInput();
  const st = frame.strips.find((x) => x.key === WORKSHOP_PIECES[workshopStep]);
  const ends = pieceEnds(frame, st);
  const done = cutsDone();
  const title = [cur.sku, cur.title].filter(Boolean).join(' — ');
  body.innerHTML = `
    <div class="ws-top">
      <span class="ws-count">Piece ${workshopStep + 1} of 4${title ? ` · ${esc(title)}` : ''}</span>
      <button type="button" class="ws-arrow" data-ws-step="-1" aria-label="Previous piece"${workshopStep === 0 ? ' disabled' : ''}>&larr;</button>
      <button type="button" class="ws-arrow" data-ws-step="1" aria-label="Next piece"${workshopStep === 3 ? ' disabled' : ''}>&rarr;</button>
      <button type="button" class="ws-close" data-ws-close>Close</button>
    </div>
    <div class="ws-piece">${st.name}${ends.every((e) => done[e.cut]) ? ' <span class="ws-done">✓ done</span>' : ''}</div>
    <div class="ws-length"><span>${f1(st.good.longPoint)}</span> <small>mm, long point</small></div>
    <div class="ws-ends">${ends.map((e) => {
      const c = frame.corners[e.ci];
      return `<div class="ws-end${done[e.cut] ? ' cut-done' : ''}">
        <div class="ws-end-head"><span class="corner-symbol big">${CORNER_SYMBOL[e.key]}</span> <b>${e.label[0].toUpperCase() + e.label.slice(1)}</b> <span class="sub">${e.key}</span></div>
        <div class="ws-end-main"><span class="ws-angle">${f2(c.mitre)}\u00B0</span> <span class="tape-chip big ${tapeClass(c.tape)}">${tapeText(c.tape)}</span> <span class="fence-badge big ${e.fence}">${e.fence === 'right' ? 'Right' : 'Left'} fence</span></div>
        <div class="ws-hint">${lengthHint(frame, e, true)}</div>
        <div class="ws-sled">${endGuideSvg(frame, s, e)}</div>
        ${cur.id && !viewOnly ? `<label class="ws-tick"><input type="checkbox" data-cut="${e.cut}"${done[e.cut] ? ' checked' : ''}> Cut</label>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="ws-nav">
      <button type="button" data-ws-step="-1"${workshopStep === 0 ? ' disabled' : ''}>&larr; Back</button>
      <button type="button" class="primary" data-ws-step="1"${workshopStep === 3 ? ' disabled' : ''}>Next &rarr;</button>
    </div>`;
}

function openWorkshop() {
  // Start at the first piece that still has cuts to make.
  const done = cutsDone();
  const i = WORKSHOP_PIECES.findIndex((k) => pieceEnds(frame, frame.strips.find((x) => x.key === k)).some((e) => !done[e.cut]));
  workshopStep = i < 0 ? 0 : i;
  $('#workshopDialog').showModal();
  renderWorkshop();
}

function setupWorkshop() {
  const dlg = $('#workshopDialog');
  dlg.addEventListener('click', (e) => {
    const step = e.target.closest('[data-ws-step]');
    if (step) { workshopStep = Math.min(3, Math.max(0, workshopStep + Number(step.dataset.wsStep))); renderWorkshop(); return; }
    if (e.target.closest('[data-ws-close]')) dlg.close();
  });
  dlg.addEventListener('change', (e) => {
    const box = e.target.closest('[data-cut]');
    if (box) setCut(box.dataset.cut, box.checked);
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && workshopStep < 3) { workshopStep++; renderWorkshop(); }
    if (e.key === 'ArrowLeft' && workshopStep > 0) { workshopStep--; renderWorkshop(); }
  });
}

// Bird's-eye view of the 45° sled: blade at the top, the fence running away from
// the kerf down to the right, and the L strip against one side of it. With a
// corner, only that corner's tape point is lit and its stack of layers is drawn.
let sledSeq = 0;
// mirror: draw the left-hand fence (the drawing flipped left to right).
function tapeGuideSvg(s, corner = null, { mirror = false, heading = null, fenceSide = 'right' } = {}) {
  const uid = ++sledSeq; // unique ids: the diagram can appear more than once
  const c = Math.SQRT1_2;
  const K = 150, AY = 112; // kerf x, and where the fence's blade-side face meets the kerf
  // P(a, o): a along the fence away from the blade, o off the fence's blade-side
  // face (+ towards the blade, - towards the operator).
  const MX = (x) => (mirror ? 330 - x : x);
  const P = (a, o) => [MX(K + c * a + c * o), AY + c * a - c * o];
  const flip = (anchor) => (!mirror ? anchor : anchor === 'end' ? 'start' : anchor === 'start' ? 'end' : anchor);
  const pts = (arr) => arr.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ');
  const rot = (q) => `rotate(${mirror ? -45 : 45} ${q[0].toFixed(1)} ${q[1].toFixed(1)})`;
  const FT = 12, GOOD = 14, CHEAP = 22, LEN = 190;
  const inside = s.cheapPosition !== 'under';
  const bladeSide = onInnerSide(s.fenceEdge);

  // Profile across the strip, measured outwards from the good wood's inner face.
  const prof = {
    good: [0, GOOD],
    cheap: inside ? [-CHEAP, 0] : [GOOD - CHEAP, GOOD],
  };
  const contact = { outer: GOOD, goodInner: 0, inner: prof.cheap[0] }[s.fenceEdge] ?? GOOD;
  // Blade side: outwards = towards the blade (+o), contact face on o = 0.
  // Operator side: outwards = towards the fence, contact face on o = -FT.
  const toO = (d) => (bladeSide ? d - contact : -FT + (d - contact));
  const upsideDown = s.fenceEdge === 'goodInner';
  const bands = ['cheap', 'good'].map((k) => {
    const [o1, o2] = prof[k].map(toO);
    const over = upsideDown && k === 'cheap'; // sits on top, reaching over the fence
    return { k, oa: Math.min(o1, o2), ob: Math.max(o1, o2), over, label: over ? 'cheap wood (on top)' : k === 'good' ? 'good wood' : 'cheap wood' };
  });
  const oMin = Math.min(...bands.map((b) => b.oa)), oMax = Math.max(...bands.map((b) => b.ob));

  // Kept piece is right of the kerf (x >= K), i.e. a >= -o.
  const band = (b) => [P(-b.oa, b.oa), P(LEN, b.oa), P(LEN, b.ob), P(-b.ob, b.ob)];
  const s0 = Math.min(-oMin, -oMax) - 18;
  const offcut = [P(s0, oMin), P(-oMin, oMin), P(-oMax, oMax), P(s0, oMax)];
  const oLong = toO(GOOD); // good wood's outer face = long point
  const tip = P(-oLong, oLong);
  const o0 = bladeSide ? 0 : -FT, dir = bladeSide ? 1 : -1;
  const face = o0 - dir * FT / 2; // tape point markers sit on the fence itself
  const near = P(-o0 + 14, face), far = P(175, face);
  const lblO = bladeSide ? Math.min(oMin, -FT) - 12 : Math.max(oMax, 0) + 12; // free side of the fence
  const nearL = P(-o0 + (bladeSide ? 44 : 30), lblO), farL = P(bladeSide ? 190 : 112, lblO);
  const lblAnchor = flip(bladeSide ? 'end' : 'start'); // keep labels clear of the fence
  const fence = [P(0, 0), P(235, 0), P(235, -FT), P(FT, -FT)];
  const fenceL = P(upsideDown ? 150 : 105, -FT / 2);
  // Selected corner: which point gets the tape, and how many layers.
  const tape = corner ? corner.tape : null;
  const layers = tape ? tape.layers : 0;
  const lit = (loc) => !corner || (layers > 0 && tape.location === loc);
  const pointLabel = (loc, x, y, title) => {
    const cls = loc === 'near' ? 'g-near-t' : 'g-far-t';
    if (!corner) return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${lblAnchor}">${title}</text>`;
    if (!lit(loc)) return `<text class="g-off-t" x="${x}" y="${y}" text-anchor="${lblAnchor}">${loc.toUpperCase()}</text>`;
    // Two lines: on the operator side the labels sit above the fence, so lift them clear of it.
    return `<text class="${cls}" x="${x}" y="${bladeSide ? y : y - 12}" text-anchor="${lblAnchor}">${title}<tspan x="${x}" dy="14" class="g-count">${layers} layer${layers === 1 ? '' : 's'}</tspan></text>`;
  };
  // Tape stack between the fence face and the strip, one line per layer (up to 10 drawn).
  let stack = '';
  if (corner && layers > 0) {
    const a = tape.location === 'near' ? -o0 + 14 : 175, shown = Math.min(layers, 10), h = 1.6 * shown + 1.5;
    const q = (along, off) => P(along, o0 + dir * off);
    stack = `<polygon class="g-tape" points="${pts([q(a - 14, 0), q(a + 14, 0), q(a + 14, h), q(a - 14, h)])}"/>` +
      Array.from({ length: shown - 1 }, (_, k) => {
        const [x1, y1] = q(a - 14, 1.6 * (k + 1) + 0.75), [x2, y2] = q(a + 14, 1.6 * (k + 1) + 0.75);
        return `<line class="g-tape-line" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      }).join('');
  }
  const tx = mirror ? 314 : 16, ta = mirror ? 'end' : 'start';
  const title = corner
    ? `<text class="g-title" x="${tx}" y="66" text-anchor="${ta}">${heading || `${corner.key} corner`}</text>
       <text class="g-muted" x="${tx}" y="80" text-anchor="${ta}">${fenceSide === 'right' ? 'right-hand' : 'left-hand'} fence \u00B7 mitre ${f2(corner.mitre)}\u00B0 \u2192 cut ${f2(tape.result)}\u00B0</text>`
    : '';
  const bandLabel = (b) => {
    const q = P(b.over ? 60 : 75, (b.oa + b.ob) / 2);
    return `<text class="g-band-t" x="${q[0]}" y="${q[1]}" text-anchor="middle" dominant-baseline="middle" transform="${rot(q)}">${b.label}</text>`;
  };
  return `<svg class="sled" viewBox="0 0 330 300" role="img" aria-label="Sled seen from above: blade, 45 degree fence and strip">
    <defs><clipPath id="sledClip${uid}"><rect x="6" y="46" width="318" height="248" rx="6"/></clipPath>
      <marker id="gArrow${uid}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" class="g-arrowhead"/></marker></defs>
    <rect class="g-sled" x="6" y="46" width="318" height="248" rx="6"/>
    <line class="g-kerf" x1="${MX(K)}" y1="46" x2="${MX(K)}" y2="294"/>
    <g clip-path="url(#sledClip${uid})">
      <polygon class="g-offcut" points="${pts(offcut)}"/>
      <polygon class="g-fence" points="${pts(fence)}"/>
      ${bands.map((b) => `<polygon class="g-${b.k}${b.over ? ' g-over' : ''}" points="${pts(band(b))}"/>`).join('')}
    </g>
    ${bands.map(bandLabel).join('')}
    <text class="g-fence-t" x="${fenceL[0]}" y="${fenceL[1]}" text-anchor="middle" dominant-baseline="middle" transform="${rot(fenceL)}">45° fence</text>
    <rect class="g-blade" x="${MX(K) - 2.5}" y="6" width="5" height="36" rx="1"/>
    <text class="g-blade-t" x="${MX(K + 8)}" y="24" text-anchor="${flip('start')}">blade</text>
    <circle class="g-tip" cx="${tip[0]}" cy="${tip[1]}" r="3.5"/>
    <text class="g-ink" x="${MX(K - 7)}" y="${tip[1] + 4}" text-anchor="${flip('end')}">long point</text>
    ${stack}
    <circle class="${lit('near') ? 'g-near' : 'g-off'}" cx="${near[0]}" cy="${near[1]}" r="5.5"/>
    ${pointLabel('near', nearL[0], nearL[1] + 4, 'NEAR')}
    <circle class="${lit('far') ? 'g-far' : 'g-off'}" cx="${far[0]}" cy="${far[1]}" r="5.5"/>
    ${pointLabel('far', farL[0], farL[1] + 4, `FAR · ${f1(s.tapeDistance)} mm`)}
    ${title}
    <line class="g-arrow" x1="${MX(28)}" y1="270" x2="${MX(28)}" y2="215" marker-end="url(#gArrow${uid})"/>
    <text class="g-muted" x="${MX(28)}" y="284" text-anchor="middle">feed</text>
  </svg>`;
}

// ---------------------------------------------------------------- 3D
async function ensureViewer() {
  if (viewer) return viewer;
  try {
    const { FrameViewer } = await import('./viewer3d.js');
    viewer = new FrameViewer($('#viewer'));
    viewer.setOptions({ showCanvas: $('#optCanvas').checked, showMeasurements: $('#optMeasure').checked, explode: $('#optExplode').checked, blackCheapTop: $('#optBlackTop').checked });
  } catch (e) {
    console.error(e);
    showViewerMsg('3D view could not start: ' + e.message);
  }
  return viewer;
}

function showViewerMsg(msg) {
  const el = $('#viewerMsg');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function currentImageUrl() {
  if (cur.pendingImage) return cur.pendingImage;
  if (cur.image && !cur.removeImage) {
    return viewOnly ? `api/share/${encodeURIComponent(SHARE_TOKEN)}/image?v=${cur.updatedAt || ''}` : `images/${cur.image}?v=${cur.updatedAt || ''}`;
  }
  return null;
}

async function renderModel() {
  const v = await ensureViewer();
  if (!v) return;
  v.setSpecies(cur.settings.species);
  v.setImage(currentImageUrl());
  v.update(frame);
  showViewerMsg(frame.ok ? '' : 'Enter valid measurements to see the frame.');
}

// ---------------------------------------------------------------- Drawing
function renderDrawing() {
  const host = $('#drawingHost');
  if (!frame.ok) {
    host.innerHTML = '<div class="empty">Enter valid measurements to see the drawing.</div>';
    return;
  }
  host.innerHTML = buildDrawing(frame, cur, settingsInput());
}

function drawingFileName(ext) {
  const base = [cur.sku, cur.title].filter(Boolean).join(' - ') || 'frame';
  return `${base.replace(/[\\/:*?"<>|]+/g, '_')} - ${ext}`;
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------- Status / lists
// SKU numbering and the timer chime are personal preferences saved straight to the defaults, not frame settings.
const SKU_SETTINGS = ['skuFormat', 'skuPrefix', 'chimeMinutes'];

function settingsMatchDefaults() {
  return Object.keys(db.settings).filter((k) => !SKU_SETTINGS.includes(k)).every((k) => String(cur.settings[k] ?? '') === String(db.settings[k] ?? ''));
}

function updateDefaultsButtons() {
  const same = settingsMatchDefaults();
  const reset = $('#btnResetDefaults'), save = $('#btnSaveDefaults');
  reset.disabled = save.disabled = same;
  reset.title = same ? 'These are already the default settings' : '';
  save.title = same ? 'These are already the default settings' : '';
}

// ---------------------------------------------------------------- Unsaved changes
// Compare what's on screen with the saved copy of the painting: highlight each
// changed value and give it a revert button showing the saved value.

function savedBaseline() {
  if (!cur || !cur.id) return null;
  const rec = db.paintings.find((p) => p.id === cur.id);
  return rec ? fromRecord(rec) : null;
}

const emptyish = (v) => v === null || v === undefined || v === '';
function sameValue(a, b) {
  if (emptyish(a) && emptyish(b)) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  return String(a ?? '') === String(b ?? '');
}

// Bottom width / right height follow top / left while "same as" is ticked, so compare
// the value actually in use rather than the stored (often empty) one.
const FOLLOWS = { bottomWidth: ['sameWidth', 'topWidth'], rightHeight: ['sameHeight', 'leftHeight'] };
function valueOf(obj, el) {
  if (el.dataset.s) return obj.settings[el.dataset.s];
  const k = el.dataset.p, follows = FOLLOWS[k];
  return follows && obj[follows[0]] ? obj[follows[1]] : obj[k];
}

function describeValue(el, v) {
  if (el.type === 'checkbox') return v ? 'ticked' : 'not ticked';
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find((o) => o.value === String(v));
    return opt ? opt.textContent : String(v ?? '');
  }
  return emptyish(v) ? '(empty)' : String(v);
}

function revertButton(host, tip, onRevert) {
  let btn = host.querySelector(':scope > .revert-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'revert-btn';
    btn.textContent = '\u21BA';
    host.append(btn);
  }
  btn.dataset.tip = tip;
  btn.setAttribute('aria-label', tip);
  btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onRevert(); };
  return btn;
}

function clearRevert(host) {
  host.classList.remove('changed');
  host.querySelector(':scope > .revert-btn')?.remove();
}

function markChanges() {
  const base = savedBaseline();
  let count = 0;
  for (const el of $$('[data-p], [data-s]')) {
    const host = el.type === 'checkbox' ? el.closest('label') : el.closest('.field');
    if (!host) continue;
    const changed = !!base && !el.disabled && !sameValue(valueOf(cur, el), valueOf(base, el));
    if (!changed) { clearRevert(host); continue; }
    count++;
    host.classList.add('changed');
    const original = valueOf(base, el);
    const btn = revertButton(host, `Revert to ${describeValue(el, original)}`, () => {
      if (el.dataset.p) cur[el.dataset.p] = original;
      else cur.settings[el.dataset.s] = original;
      writeForm();
      if (el.dataset.s === 'species' && viewer) viewer.setSpecies(original);
      recompute();
    });
    if (el.type === 'checkbox') {
      Object.assign(btn.style, { left: 'calc(100% + 6px)', top: '50%' });
    } else {
      // Inside the right-hand end of the box (clear of a select's arrow).
      const inset = el.tagName === 'SELECT' ? 50 : 28;
      Object.assign(btn.style, { left: `${el.offsetLeft + el.offsetWidth - inset}px`, top: `${el.offsetTop + el.offsetHeight / 2}px` });
    }
  }
  // Settings are in a dialog: flag its button if something inside changed.
  $('#btnSettings').classList.toggle('changed', !!$('#settingsDialog .changed'));
  // Collapsed "Diagonals" section: flag it if something inside changed.
  for (const d of $$('details.more')) d.querySelector('summary').classList.toggle('changed', !!d.querySelector('.changed'));

  // The painting image.
  const row = $('.image-row'), thumb = $('#imgThumb');
  const imgChanged = !!base && (!!cur.pendingImage || !!cur.removeImage);
  thumb.classList.toggle('changed', imgChanged);
  row.classList.toggle('changed', imgChanged);
  if (imgChanged) {
    count++;
    const btn = revertButton(row, base.image ? 'Revert to the saved image' : 'Revert to no image', () => {
      cur.pendingImage = cur.pendingOriginal = null;
      cur.removeImage = false;
      cur.imageCrop = base.imageCrop || null;
      updateImageUi();
      recompute();
    });
    Object.assign(btn.style, { left: `${thumb.offsetLeft + thumb.offsetWidth - 14}px`, top: `${thumb.offsetTop + 12}px` });
  } else {
    row.querySelector(':scope > .revert-btn')?.remove();
  }
  return count;
}

async function reloadSaved() {
  if (viewOnly) {
    if (confirm('Go back to the frame settings that were shared?')) setCurrent(fromRecord(db.paintings[0]));
    return;
  }
  if (!cur.id) return;
  if (!confirm('Discard all your unsaved changes to this painting and reload the saved version?')) return;
  try {
    setDb(await api.state());
    refreshLists();
  } catch (e) {
    toast('Could not reach the server: ' + e.message, true);
    return;
  }
  const rec = db.paintings.find((p) => p.id === cur.id);
  if (!rec) { toast('This painting is no longer in your library.', true); return; }
  setCurrent(fromRecord(rec));
  toast('Reloaded the saved version');
}

function updateStatus() {
  updateDefaultsButtons();
  updateFrameStatus();
  updateTimer();
  $('#btnSaveAsNew').disabled = !cur.id; // only useful once a saved painting is loaded
  const el = $('#saveStatus');
  const changes = markChanges();
  const dirty = !!cur.id && isDirty();
  $('#btnReload').hidden = !dirty;
  $('#btnShare').disabled = !cur.id;
  if (viewOnly) {
    el.textContent = dirty ? `${changes || 'Some'} change${changes === 1 ? '' : 's'} - not saved` : 'Read only';
    el.className = 'save-status' + (dirty ? ' dirty' : '');
    $('#btnReload').title = 'Go back to the shared frame settings';
  } else if (!cur.id) { el.textContent = 'New - not saved yet'; el.className = 'save-status dirty'; }
  else if (dirty) {
    el.textContent = changes ? `${changes} unsaved change${changes === 1 ? '' : 's'}` : 'Unsaved changes';
    el.className = 'save-status dirty';
  } else { el.textContent = 'Saved'; el.className = 'save-status saved'; }
}

const paintingLabel = (p) => [p.sku, p.title, p.artist].filter(Boolean).join(' — ');

function refreshLists() {
  const opt = (v) => `<option value="${esc(v)}"></option>`;
  const sorted = [...db.paintings].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Each saved painting with its status icon in front and the status name beside it.
  $('#dlPaintings').innerHTML = sorted.map((p) => {
    const st = STATUS[statusOf(p)];
    return `<option value="${esc(`${st.icon} ${paintingLabel(p)}`)}" label="${st.label}"></option>`;
  }).join('');
  $('#dlSkus').innerHTML = [...new Set(sorted.map((p) => p.sku).filter(Boolean))].map(opt).join('');
  $('#dlTitles').innerHTML = [...new Set(sorted.map((p) => p.title).filter(Boolean))].map(opt).join('');
  $('#dlArtists').innerHTML = db.artists.map(opt).join('');
  if ($('#libraryDialog').open) { renderLibrary(); renderArtists(); }
  updateSkuPreview();
}

function findSaved({ sku, title }) {
  if (sku) {
    const m = db.paintings.find((p) => norm(p.sku) === norm(sku));
    if (m) return m;
  }
  if (title) return db.paintings.find((p) => norm(p.title) === norm(title));
  return null;
}

function updateMatchHint() {
  const hint = $('#matchHint');
  const m = findSaved(cur);
  if (!m || m.id === cur.id) { hint.hidden = true; return; }
  hint.hidden = false;
  hint.innerHTML = `<span>“${esc(paintingLabel(m))}” is already saved.</span><button type="button" class="link">Load it</button>`;
  hint.querySelector('button').onclick = () => loadPainting(m.id);
}

// ---------------------------------------------------------------- Draft (browser cache of unsaved input)
function saveDraft() {
  if (!cur || viewOnly) return; // nothing loaded yet (e.g. still on the sign-in screen)
  try { localStorage.setItem(draftKey(), JSON.stringify({ cur, savedSnapshot })); }
  catch {
    // Most likely the pending image is too big for localStorage; keep the rest.
    try { localStorage.setItem(draftKey(), JSON.stringify({ cur: { ...cur, pendingImage: null, pendingOriginal: null }, savedSnapshot })); } catch { /* ignore */ }
  }
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey()) || 'null');
    if (d && d.cur) return d;
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------- Actions
function setCurrent(p, snapshot) {
  cur = p;
  cur.settings = { ...db.settings, ...(cur.settings || {}) };
  savedSnapshot = snapshot ?? snapshotOf(cur);
  writeForm();
  updateImageUi();
  recompute();
}

function confirmDiscard() {
  return !isDirty() || confirm('You have unsaved changes to the current painting. Discard them?');
}

function loadPainting(id) {
  const rec = db.paintings.find((p) => p.id === id);
  if (!rec || !confirmDiscard()) return;
  setCurrent(fromRecord(rec));
  toast(`Loaded ${paintingLabel(rec) || 'painting'}`);
}

function newPainting() {
  if (!confirmDiscard()) return;
  setCurrent(blankPainting());
  $('#f-sku').focus();
}

async function save(message = 'Saved') {
  if (viewOnly) { toast("This is a shared frame, so changes can't be saved.", true); return; }
  readAll();
  if (!cur.sku.trim() && !cur.title.trim()) {
    toast('Enter an SKU or a title before saving.', true);
    $('#f-sku').focus();
    return;
  }
  const clash = cur.sku.trim() && db.paintings.find((p) => norm(p.sku) === norm(cur.sku) && p.id !== cur.id);
  if (clash) {
    if (!cur.id) {
      if (!confirm(`SKU "${cur.sku}" is already saved (${paintingLabel(clash)}). Overwrite it with these values?`)) return;
      cur.id = clash.id;
      cur.image = clash.image;
    } else if (!confirm(`Another saved painting already uses SKU "${cur.sku}". Save anyway?`)) return;
  }
  const btn = $('#btnSave');
  btn.disabled = true;
  try {
    let res = await api.savePainting(toRecord(cur));
    cur.id = res.painting.id;
    if (cur.pendingImage) {
      if (cur.pendingOriginal) res = await api.uploadImage(cur.id, await (await fetch(cur.pendingOriginal)).blob(), true);
      const blob = await (await fetch(cur.pendingImage)).blob();
      res = await api.uploadImage(cur.id, blob);
    } else if (cur.removeImage && cur.image) {
      res = await api.deleteImage(cur.id);
      res.painting = res.paintings.find((p) => p.id === cur.id);
    }
    setDb(res);
    const saved = fromRecord(res.painting);
    saved.settings = { ...cur.settings };
    setCurrent(saved);
    refreshLists();
    toast(message);
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Save what's on screen as a new painting; the one it was loaded from is left as it was.
// ---------------------------------------------------------------- SKU generation
function skuFor() {
  const p = paintingInput();
  return nextSku(db.settings.skuFormat || DEFAULT_SKU_FORMAT, {
    prefix: db.settings.skuPrefix,
    artist: cur ? cur.artist : '',
    width: p.top,
    height: p.left,
  }, db.paintings.map((x) => x.sku));
}

function updateSkuPreview() {
  if (!cur) return;
  const r = skuFor();
  $('#skuPreview').textContent = r.sku || '(empty)';
  $('#skuWarning').textContent = r.missing.length
    ? `(needs the ${r.missing.join(' and ')})`
    : r.hasSeq ? '' : '- no {SEQ} in the format, so SKUs can repeat';
}

function generateSku() {
  readAll();
  const r = skuFor();
  if (r.missing.length) {
    toast(`Fill in the ${r.missing.join(' and ')} first - the SKU format uses it.`, true);
    return;
  }
  if (db.paintings.some((p) => norm(p.sku) === norm(r.sku) && p.id !== cur.id)) {
    toast(`${r.sku} is already used. Add {SEQ} to the SKU format so each one is different.`, true);
    return;
  }
  const el = $('#f-sku');
  el.value = r.sku;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let skuSaveTimer;
function bindSkuSettings() {
  $('#sku-format').value = db.settings.skuFormat || DEFAULT_SKU_FORMAT;
  $('#sku-prefix').value = db.settings.skuPrefix ?? '';
  $('#chime-minutes').value = db.settings.chimeMinutes ?? 10;
  const onChange = () => {
    db.settings.skuFormat = $('#sku-format').value.trim() || DEFAULT_SKU_FORMAT;
    db.settings.skuPrefix = $('#sku-prefix').value.trim();
    const chime = parseFloat($('#chime-minutes').value);
    db.settings.chimeMinutes = Number.isFinite(chime) && chime >= 0 ? Math.min(chime, 240) : 10;
    updateSkuPreview();
    clearTimeout(skuSaveTimer);
    skuSaveTimer = setTimeout(async () => {
      try { db.settings = (await api.saveSettings(db.settings)).settings; }
      catch (e) { toast("Couldn't save your settings: " + e.message, true); }
    }, 700);
  };
  $('#sku-format').addEventListener('input', onChange);
  $('#sku-prefix').addEventListener('input', onChange);
  $('#chime-minutes').addEventListener('input', onChange);
  $('#btnGenerateSku').onclick = generateSku;
}

async function saveAsNew() {
  if (viewOnly) return save();
  readAll();
  if (!cur.id) return save(); // never saved, so a normal save already makes a new painting
  if (cur.sku.trim() && db.paintings.some((p) => norm(p.sku) === norm(cur.sku))) {
    toast(`SKU "${cur.sku}" is already used by a saved painting. Change the SKU first, then Save as new.`, true);
    $('#f-sku').focus();
    $('#f-sku').select();
    return;
  }
  // Give the copy its own copy of the painting image (and the photo it was cropped from).
  if (!cur.pendingImage && cur.image && !cur.removeImage) {
    try {
      cur.pendingImage = await urlToDataUrl(currentImageUrl());
      if (cur.imageOriginal && !cur.pendingOriginal) cur.pendingOriginal = await urlToDataUrl(`images/${cur.imageOriginal}?v=${cur.updatedAt || ''}`);
    } catch {
      toast("Couldn't copy the painting image - the new painting won't have one.", true);
    }
  }
  cur.id = null;
  cur.image = cur.imageOriginal = null;
  cur.removeImage = false;
  cur.status = cur.buildingAt = cur.madeAt = null; // the copy's frame hasn't been started
  cur.cuts = null;
  cur.shareToken = null;
  await save('Saved as a new painting');
}

function readAll() {
  for (const el of $$('[data-p], [data-s]')) if (!el.disabled) readField(el);
}

async function deletePainting(id) {
  const rec = db.paintings.find((p) => p.id === id);
  if (!rec || !confirm(`Delete "${paintingLabel(rec)}" from the library? This can't be undone.`)) return;
  try {
    const res = await api.deletePainting(id);
    setDb(res);
    if (cur.id === id) { cur.id = null; cur.image = null; savedSnapshot = 'deleted'; updateStatus(); updateImageUi(); }
    refreshLists();
    toast('Deleted');
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- Frame status
// Where each frame is up to: not started, building or made. Saved straight away
// (it isn't one of the painting's values, so it doesn't count as an unsaved change).
const STATUS = {
  none: { label: 'Not started', icon: '\u25CB' },
  building: { label: 'Building', icon: '\u{1F528}' },
  made: { label: 'Made', icon: '\u2705' },
};
// Paintings marked as made before there was a status only have madeAt.
const statusOf = (p) => (p && (p.status || (p.madeAt ? 'made' : null))) || 'none';
const shortDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function statusSince(p) {
  const st = statusOf(p), t = st === 'made' ? p.madeAt : st === 'building' ? p.buildingAt : null;
  return t ? `${st === 'made' ? 'on' : 'since'} ${shortDate(t)}` : '';
}

function updateFrameStatus() {
  const st = cur.id ? statusOf(cur) : 'none';
  $('#statusBox').className = `status-box ${st}`;
  const badge = $('#statusBadge');
  badge.hidden = st === 'none';
  badge.className = `status-pill ${st}`;
  badge.textContent = st === 'made' ? '\u2713 Made' : `${STATUS[st].icon} ${STATUS[st].label}`;
  badge.title = st === 'none' ? '' : `${STATUS[st].label} ${statusSince(cur)}`;
  for (const c of ['building', 'made']) $('#cardPainting').classList.toggle(c, st === c);
  for (const b of $$('#statusSeg button')) {
    b.classList.toggle('active', b.dataset.status === st);
    b.disabled = !cur.id;
  }
  const text = $('#statusText');
  if (!cur.id) { text.textContent = 'Save the painting to track whether its frame is being built or made.'; return; }
  const since = esc(statusSince(cur));
  const warn = isDirty() && !viewOnly && st !== 'none'
    ? `<span class="status-warn">You\u2019re changing a frame that\u2019s ${st === 'made' ? 'already been made' : 'being built'}.</span>` : '';
  text.innerHTML = st === 'made' ? `<b>\u2713 Made</b> ${since}${warn}`
    : st === 'building' ? `<b>\u{1F528} Building</b> ${since}${warn}`
    : 'Frame not started';
}

async function setFrameStatus(st) {
  if (!cur.id || st === statusOf(cur)) return;
  if (st === 'none' && !confirm('Mark this frame as not started?')) return;
  try {
    const res = await api.setStatus(cur.id, st === 'none' ? null : st);
    setDb(res);
    for (const k of ['status', 'buildingAt', 'madeAt']) cur[k] = res.painting[k] ?? null;
    refreshLists();
    updateStatus();
    saveDraft();
    toast((st === 'made' ? 'Marked as made' : st === 'building' ? 'Marked as building' : 'Marked as not started')
      + (res.timerStopped ? '. The timer has stopped - no frames are being built now.' : ''));
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- Build timer
// One timer for the workshop. While it runs, its time is split equally between all
// the frames marked Building; the server adds each frame's share to its time log.
const nowSec = () => Date.now() / 1000 + clockSkew;
const timerOn = () => !!(db.timer && db.timer.start);
const buildingCount = () => db.paintings.filter((p) => statusOf(p) === 'building').length;
const savedRec = () => (cur && cur.id ? db.paintings.find((p) => p.id === cur.id) : null);

// Total time for a frame, including its share of the timer's time since the last split.
function timeSpent(p) {
  let t = (p.timeLog || []).reduce((sum, e) => sum + (e.seconds || 0), 0);
  if (timerOn() && statusOf(p) === 'building') t += Math.max(0, nowSec() - db.timer.segmentStart) / Math.max(1, buildingCount());
  return Math.max(0, t);
}

function fmtDuration(sec) {
  const m = Math.round(Math.abs(sec) / 60), sign = sec < 0 ? '-' : '';
  if (m < 60) return `${sign}${m} min`;
  return `${sign}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// A chime every few minutes while the timer runs (Settings > Build timer; 0 = off).
const chimeEvery = () => {
  const m = Number(db.settings.chimeMinutes ?? 10);
  return Number.isFinite(m) && m > 0 ? m * 60 : 0;
};
let audioCtx = null;
let chimedAt = null; // the timer start and the 10-minute mark last chimed (or skipped)

function unlockAudio() {
  // Browsers only allow sound after the person has clicked something on the page.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no Web Audio */ }
}

function playChime() {
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + 0.05;
  // Two soft bell tones, high then low.
  [[880, 0], [659.25, 0.28]].forEach(([freq, delay]) => {
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 1.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + 1.5);
  });
}

function maybeChime() {
  const every = chimeEvery();
  if (!timerOn() || !every) { chimedAt = null; return; }
  const mark = Math.floor((nowSec() - db.timer.start) / every);
  // First look at this run (e.g. the page was just opened, or the interval changed): note where it's up to without chiming.
  if (!chimedAt || chimedAt.start !== db.timer.start || chimedAt.every !== every) { chimedAt = { start: db.timer.start, every, mark }; return; }
  if (mark > chimedAt.mark) {
    chimedAt.mark = mark;
    playChime();
  }
}

// The numbers that change every second while the timer runs.
function tickTimer() {
  const on = timerOn();
  maybeChime();
  $('#dockClock').textContent = on ? `\u23F1 ${fmtClock(nowSec() - db.timer.start)}` : '\u23F1 Timer stopped';
  const rec = savedRec();
  if (rec) $('#timeTotal').textContent = fmtDuration(timeSpent(rec));
}

// The dock at the bottom of the screen: shown while the timer runs or anything is being built.
function updateDock() {
  const on = timerOn();
  const frames = db.paintings.filter((p) => statusOf(p) === 'building');
  const show = !viewOnly && (on || frames.length > 0);
  $('#timerDock').hidden = !show;
  document.body.classList.toggle('has-dock', show);
  if (!show) { syncTimerNotification(); return; }
  $('#timerDock').classList.toggle('running', on);
  const n = frames.length;
  $('#dockLabel').textContent = on ? (n > 1 ? `Split between ${n}:` : 'Timing:') : `${n} being built:`;
  $('#dockFrames').innerHTML = frames.map((p) => `<button type="button" class="dock-chip${cur && p.id === cur.id ? ' current' : ''}" data-id="${p.id}" title="${esc(paintingLabel(p))}">${esc(p.sku || p.title || 'Untitled')}</button>`).join('');
  syncTimerNotification();
  const btn = $('#btnDockTimer');
  const rec = savedRec();
  // Start only from a frame that's being built; Stop whenever the timer runs.
  btn.hidden = !on && !(rec && statusOf(rec) === 'building');
  btn.textContent = on ? 'Stop' : 'Start timer';
  btn.title = on ? 'Stop the timer and share its time between the frames being built' : `Time your work; it's shared between the ${n} frame${n === 1 ? '' : 's'} marked Building`;
}

function updateTimer() {
  updateDock();
  tickTimer();
  const rec = savedRec(), box = $('#timeBox');
  const on = timerOn(), n = buildingCount();
  const st = rec ? statusOf(rec) : 'none';
  box.hidden = !rec || viewOnly || (st === 'none' && !timeSpent(rec) && !(rec.timeLog || []).length);
  if (box.hidden) return;
  const btn = $('#btnTimer');
  btn.hidden = st !== 'building'; // only frames being built can be timed (Stop is always in the dock)
  btn.textContent = on ? 'Stop timer' : 'Start timer';
  btn.classList.toggle('running', on);
  btn.disabled = !on && !n;
  btn.title = on ? 'Stop the timer and share its time between the frames being built'
    : n ? `Time your work; it's shared between the ${n} frame${n === 1 ? '' : 's'} marked Building` : 'Mark a frame as Building first';
  $('#timeNote').textContent = on
    ? (st === 'building' ? (n > 1 ? `Timer running - this frame gets 1/${n} of the time (${n} frames being built).` : 'Timer running.')
      : 'The timer is running for other frames. Mark this one as Building to share in it.')
    : st === 'building' ? `Start the timer while you work. Its time is split between all the frames marked Building${n > 1 ? ` (${n} now)` : ''}.` : '';
  renderTimeLog(rec);
}

// The log, with timer entries grouped into sessions.
function renderTimeLog(rec) {
  const groups = new Map();
  for (const e of rec.timeLog || []) {
    const key = e.manual ? e.id : 's' + e.session;
    const g = groups.get(key) || { ids: [], seconds: 0, start: e.start, end: e.end, frames: 0, manual: !!e.manual, note: e.note };
    g.ids.push(e.id);
    g.seconds += e.seconds || 0;
    g.start = Math.min(g.start, e.start);
    g.end = Math.max(g.end, e.end);
    g.frames = Math.max(g.frames, e.frames || 1);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.start - a.start);
  $('#timeLog').innerHTML = rows.length ? `<table class="time-log"><tbody>${rows.map((g) => `<tr>
      <td>${esc(shortDate(g.start))}<div class="sub">${g.manual ? esc(g.note || 'Added by hand') : `${esc(fmtTime(g.start))} - ${esc(fmtTime(g.end))}${g.frames > 1 ? `, shared by up to ${g.frames} frames` : ''}`}</div></td>
      <td class="num">${g.seconds < 0 ? '' : '+'}${esc(fmtDuration(g.seconds))}</td>
      <td><button type="button" class="link danger" data-time="${esc(g.ids.join(','))}" title="Remove this from the log">&times;</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="help">No time recorded yet.</p>';
}

async function toggleTimer() {
  try {
    setDb(await api.timer(timerOn() ? 'stop' : 'start'));
    refreshLists();
    updateStatus();
    toast(timerOn() ? 'Timer started' : 'Timer stopped - its time has been shared between the frames being built');
  } catch (e) { toast(e.message, true); }
}

async function addTime() {
  const minutes = parseFloat($('#timeAddMin').value);
  if (!cur.id || !minutes) { toast('Enter the number of minutes to add.', true); $('#timeAddMin').focus(); return; }
  try {
    setDb(await api.addTime(cur.id, minutes, $('#timeAddNote').value.trim()));
    $('#timeAddMin').value = $('#timeAddNote').value = '';
    refreshLists();
    updateStatus();
    toast(minutes > 0 ? `Added ${fmtDuration(minutes * 60)}` : `Took off ${fmtDuration(-minutes * 60)}`);
  } catch (e) { toast(e.message, true); }
}

async function removeTime(ids) {
  if (!confirm('Remove this time from the log?')) return;
  try {
    let res;
    for (const id of ids) res = await api.deleteTime(cur.id, id);
    setDb(res);
    refreshLists();
    updateStatus();
  } catch (e) { toast(e.message, true); }
}

function setupTimer() {
  $('#btnTimer').onclick = toggleTimer;
  $('#btnDockTimer').onclick = toggleTimer;
  $('#dockFrames').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-id]');
    if (chip && chip.dataset.id !== cur.id) loadPainting(chip.dataset.id);
  });
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('keydown', unlockAudio, { capture: true });
  $('#btnTimeAdd').onclick = addTime;
  $('#timeAddMin').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTime(); } });
  $('#timeLog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-time]');
    if (b) removeTime(b.dataset.time.split(','));
  });
  setInterval(() => { if (timerOn()) tickTimer(); }, 1000);
  // Pick up changes made on another device (e.g. the timer started on a phone): when the
  // page comes back into view (phones don't always send "focus"), and every minute while it's open.
  window.addEventListener('focus', () => refreshState());
  document.addEventListener('visibilitychange', () => refreshState());
  window.addEventListener('pageshow', (e) => { if (e.persisted) refreshState(); }); // back from the browser's page cache
  setInterval(() => refreshState(), 60 * 1000);
  setupTimerNotification();
}

let refreshing = false;
async function refreshState(force = false) {
  // In the background, only keep checking while the timer runs (for its notification).
  if (!cur || viewOnly || refreshing || (document.hidden && !force && !timerOn())) return;
  refreshing = true;
  try { setDb(await api.state()); refreshLists(); updateStatus(); } catch { /* offline - keep what we have */ }
  refreshing = false;
}

// ---- Notification while the timer runs (per device), with a Stop button handled by sw.js.
const NOTIFY_TAG = 'build-timer';
const notifySupported = () => 'Notification' in window && 'serviceWorker' in navigator;
const notifyOn = () => notifySupported() && loadUi().timerNotify === true && Notification.permission === 'granted';
let notifyShown = ''; // what the current notification says, so it isn't re-posted for nothing

async function syncTimerNotification() {
  if (!notifySupported() || viewOnly) return;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!reg) return;
  const existing = await reg.getNotifications({ tag: NOTIFY_TAG }).catch(() => []);
  if (!timerOn() || !notifyOn()) {
    existing.forEach((n) => n.close());
    notifyShown = '';
    return;
  }
  const frames = db.paintings.filter((p) => statusOf(p) === 'building');
  const names = frames.map((p) => p.sku || p.title || 'Untitled').join(', ');
  const body = `Started ${fmtTime(db.timer.start)}${frames.length ? ` \u00B7 ${frames.length > 1 ? `split between ${frames.length}: ` : ''}${names}` : ''}`;
  if (existing.length && notifyShown === body) return; // still showing, nothing new to say
  notifyShown = body;
  await reg.showNotification('\u23F1 Build timer running', {
    tag: NOTIFY_TAG,
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    timestamp: Math.round(db.timer.start * 1000), // Android shows how long ago it started
    requireInteraction: true,
    silent: true,
    renotify: false,
    actions: [{ action: 'stop', title: 'Stop timer' }],
    data: { url: location.href.split('#')[0] },
  }).catch(() => { notifyShown = ''; });
}

function showNotifySetting() {
  const box = $('#timerNotify'), help = $('#timerNotifyHelp');
  if (!notifySupported()) {
    box.checked = false;
    box.disabled = true;
    help.textContent = 'This browser can\u2019t show notifications. Install the app from Chrome on your phone to use them.';
    return;
  }
  box.checked = notifyOn();
  help.textContent = Notification.permission === 'denied'
    ? 'Notifications are blocked for this site. Allow them in the browser\u2019s site settings, then tick this again.'
    : 'On this device only. Best in the installed app on your phone.';
}

function setupTimerNotification() {
  showNotifySetting();
  $('#timerNotify').addEventListener('change', async (e) => {
    let on = e.target.checked;
    if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission().catch(() => 'denied')) === 'granted';
    saveUi({ timerNotify: on });
    showNotifySetting();
    syncTimerNotification();
    if (on) toast(timerOn() ? 'The timer notification is showing' : 'A notification will show while the timer runs');
  });
  // The Stop button in the notification stops the timer from the service worker; catch up here.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'refresh') refreshState(true);
    });
  }
}

// ---------------------------------------------------------------- Share links
const shareUrl = (token) => `${location.origin}${location.pathname}?share=${encodeURIComponent(token)}`;

function showShare() {
  const token = cur.shareToken;
  $('#shareOff').hidden = !!token;
  $('#shareOn').hidden = !token;
  $('#shareUrl').value = token ? shareUrl(token) : '';
}

async function setShare(share) {
  try {
    const res = await api.setShare(cur.id, share);
    setDb(res);
    cur.shareToken = res.painting.shareToken ?? null;
    refreshLists();
    showShare();
    if (!share) toast('Stopped sharing - the link no longer works');
  } catch (e) { toast(e.message, true); }
}

function setupShareDialog() {
  const dlg = $('#shareDialog');
  $('#btnShare').onclick = () => {
    if (!cur.id) return;
    if (isDirty()) toast('The link shows the saved version - save your changes for them to be included.');
    showShare();
    dlg.showModal();
  };
  $('#shareClose').onclick = () => dlg.close();
  $('#shareCreate').onclick = () => setShare(true);
  $('#shareStop').onclick = () => {
    if (confirm('Stop sharing? Anyone with the link will no longer be able to open it.')) setShare(false);
  };
  $('#shareUrl').onfocus = (e) => e.target.select();
  $('#shareCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#shareUrl').value); toast('Link copied'); }
    catch { $('#shareUrl').select(); toast("Copying isn't available here - the link is selected, press Ctrl+C.", true); }
  };
}

// Opened from a share link: show that one painting, no library, no saving.
async function initShared() {
  document.body.classList.add('view-only');
  $('#shareBanner').hidden = false;
  $('#s-species').innerHTML = Object.entries(SPECIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  bindEvents();
  let res;
  try { res = await api.shared(SHARE_TOKEN); }
  catch (e) {
    $('#shareBanner').innerHTML = `<b>${esc(e.message)}</b>`;
    $('#shareBanner').classList.add('error');
    return;
  }
  $('#shareOwner').textContent = res.owner ? `from ${res.owner}` : '';
  db = { settings: res.settings, paintings: [res.painting], artists: [] };
  for (const el of $$('#cardPainting input, #cardPainting select, #cardSize input, #cardSize select')) el.disabled = true;
  setCurrent(fromRecord(res.painting));
  document.title = `${paintingLabel(res.painting) || 'Shared frame'} - Floating Frame Calculator`;
  const ui = loadUi();
  $('#optBlackTop').checked = !!ui.blackCheapTop;
  setTab(ui.tab || 'cut');
}

// ---------------------------------------------------------------- Image
async function urlToDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// The photo to crop from: the original if we have one, otherwise the image itself
// (paintings saved before cropping existed).
function originalImageUrl() {
  if (cur.pendingOriginal) return cur.pendingOriginal;
  if (cur.imageOriginal && !cur.removeImage && !cur.pendingImage) return `images/${cur.imageOriginal}?v=${cur.updatedAt || ''}`;
  return currentImageUrl();
}

// The painting's real proportions (width / height), for straightening to the right shape.
function paintingAspect() {
  const p = paintingInput();
  const w = (p.top + p.bottom) / 2, h = (p.left + p.right) / 2;
  return w > 0 && h > 0 ? w / h : 0;
}

// Open the crop screen on a photo; on Apply, the straightened image becomes the painting's image.
async function cropImage(originalUrl, { isNew = false } = {}) {
  const hasOriginal = isNew || !!cur.pendingOriginal || (!!cur.imageOriginal && !cur.pendingImage);
  const saved = hasOriginal ? cur.imageCrop : null; // saved corners only apply to the original photo
  let res;
  try {
    res = await openCropper({
      src: originalUrl,
      corners: saved ? saved.corners : null,
      enhance: saved ? !!saved.enhance : loadUi().enhanceImage !== false,
      aspect: paintingAspect(),
    });
  } catch (err) { toast(err.message, true); return; }
  if (!res) return;
  saveUi({ enhanceImage: res.enhance });
  if (isNew || !hasOriginal) cur.pendingOriginal = originalUrl.startsWith('data:') ? originalUrl : await urlToDataUrl(originalUrl);
  cur.pendingImage = res.dataUrl;
  cur.imageCrop = { corners: res.corners, enhance: res.enhance };
  cur.removeImage = false;
  updateImageUi();
  recompute();
}

async function downscale(file, max = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}

function updateImageUi() {
  const url = currentImageUrl();
  const t = $('#imgThumb');
  t.style.backgroundImage = url ? `url("${url}")` : '';
  t.classList.toggle('has-image', !!url);
  $('#imgRemove').hidden = !url;
  $('#imgCrop').hidden = !url || viewOnly;
  $('#imgNote').textContent = cur.pendingImage ? 'New image - saved with the painting.' : cur.removeImage ? 'Image will be removed on save.' : url ? '' : 'Shown on the 3D model.';
  if (viewer) viewer.setImage(url);
}

// ---------------------------------------------------------------- Library dialog
function statusPill(p) {
  const st = statusOf(p);
  if (st === 'none') return '<span class="sub">Not started</span>';
  const icon = st === 'made' ? '\u2713' : STATUS.building.icon;
  return `<span class="status-pill ${st}" title="${esc(statusSince(p))}">${icon} ${STATUS[st].label}</span>`;
}

function renderLibrary() {
  const q = norm($('#libSearch').value);
  const show = $('#libStatus').value;
  const rows = [...db.paintings]
    .filter((p) => show === 'all' || (show === 'notmade' ? statusOf(p) !== 'made' : statusOf(p) === show))
    .filter((p) => !q || [p.sku, p.title, p.artist].some((v) => norm(v).includes(q)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const size = (p) => {
    const w = p.sameWidth ? p.topWidth : `${f1(p.topWidth)}/${f1(p.bottomWidth)}`;
    const h = p.sameHeight ? p.leftHeight : `${f1(p.leftHeight)}/${f1(p.rightHeight)}`;
    return `${typeof w === 'number' ? f1(w) : w} × ${typeof h === 'number' ? f1(h) : h} × ${f1(p.depth)}`;
  };
  $('#libTable').innerHTML = `<thead><tr><th>SKU</th><th>Title</th><th>Artist</th><th>Size (W × H × D)</th><th>Status</th><th class="num">Time</th><th>Updated</th><th></th></tr></thead><tbody>${
    rows.map((p) => `<tr class="clickable status-${statusOf(p)}" data-id="${p.id}">
      <td><b>${esc(p.sku || '-')}</b>${p.shareToken ? ' <span class="sub" title="Shared with a read-only link">&#128279;</span>' : ''}</td><td>${esc(p.title || '-')}</td><td>${esc(p.artist || '-')}</td>
      <td class="sub">${size(p)}</td>
      <td>${statusPill(p)}</td>
      <td class="num sub">${(p.timeLog || []).length || (timerOn() && statusOf(p) === 'building') ? esc(fmtDuration(timeSpent(p))) : '-'}</td>
      <td class="sub">${p.updatedAt ? new Date(p.updatedAt * 1000).toLocaleDateString() : ''}</td>
      <td><button type="button" class="link danger" data-del="${p.id}">Delete</button></td></tr>`).join('')
    || `<tr><td colspan="8" class="sub">${db.paintings.length ? 'No matches.' : 'Nothing saved yet - fill in a painting and press Save.'}</td></tr>`
  }</tbody>`;
}

function renderArtists() {
  const counts = new Map();
  for (const p of db.paintings) if (p.artist) counts.set(norm(p.artist), (counts.get(norm(p.artist)) || 0) + 1);
  $('#artistTable').innerHTML = `<thead><tr><th>Artist</th><th class="num">Paintings</th><th></th></tr></thead><tbody>${
    db.artists.map((a) => {
      const n = counts.get(norm(a)) || 0;
      return `<tr><td>${esc(a)}</td><td class="num">${n}</td><td>${n ? '<span class="sub">in use</span>' : `<button type="button" class="link danger" data-del-artist="${esc(a)}">Remove</button>`}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="sub">No artists yet.</td></tr>'
  }</tbody>`;
}

// ---------------------------------------------------------------- UI helpers
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2200);
}

function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { return {}; }
}

function saveUi(patch) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUi(), ...patch })); } catch { /* ignore */ }
}

function setTab(tab) {
  activeTab = tab;
  for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== tab;
  saveUi({ tab });
  if (tab === 'model' && viewer) viewer.resize();
  refreshVisiblePanel();
}

// ---------------------------------------------------------------- Wire up
function bindEvents() {
  const form = $('#form');
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset.p && !el.dataset.s) return;
    readField(el);
    if (el.dataset.p === 'sameWidth' || el.dataset.p === 'sameHeight' || el.dataset.p === 'topWidth' || el.dataset.p === 'leftHeight') {
      // When un-ticking "same", start the other side from the current value.
      if (el.dataset.p === 'sameWidth' && !el.checked && cur.bottomWidth == null) cur.bottomWidth = cur.topWidth;
      if (el.dataset.p === 'sameHeight' && !el.checked && cur.rightHeight == null) cur.rightHeight = cur.leftHeight;
      syncSameFields();
      if (!cur.sameWidth) $('#f-bottom').value = cur.bottomWidth ?? '';
      if (!cur.sameHeight) $('#f-right').value = cur.rightHeight ?? '';
    }
    if (el.dataset.s === 'species' && viewer) viewer.setSpecies(el.value);
    recompute();
  });

  $('#quickLoad').addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (!v) return;
    const st = Object.values(STATUS).find((x) => v.startsWith(x.icon + ' '));
    if (st) v = v.slice(st.icon.length + 1).trim();
    const rec = db.paintings.find((p) => paintingLabel(p) === v)
      || db.paintings.find((p) => norm(p.sku) === norm(v) || norm(p.title) === norm(v));
    if (rec) { loadPainting(rec.id); e.target.value = ''; }
    else toast('No saved painting matches that.', true);
  });

  $('#btnNew').onclick = newPainting;
  $('#btnSave').onclick = () => save();
  $('#btnSaveAsNew').onclick = saveAsNew;
  $('#btnReload').onclick = reloadSaved;
  const settings = $('#settingsDialog');
  $('#btnSettings').onclick = () => { settings.showModal(); markChanges(); }; // place revert buttons now it's visible
  $('#settingsClose').onclick = () => settings.close();
  settings.addEventListener('click', (e) => { if (e.target === settings) settings.close(); });
  for (const b of $$('#statusSeg button')) b.onclick = () => setFrameStatus(b.dataset.status);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (e.shiftKey) saveAsNew(); else save(); }
  });

  $('#btnSaveDefaults').onclick = async () => {
    try {
      const res = await api.saveSettings(cur.settings);
      db.settings = res.settings;
      updateDefaultsButtons();
      toast('Saved as default frame settings');
    } catch (e) { toast(e.message, true); }
  };
  $('#btnResetDefaults').onclick = () => {
    cur.settings = { ...db.settings };
    writeForm();
    if (viewer) viewer.setSpecies(cur.settings.species);
    recompute();
    toast('Frame settings reset to defaults');
  };

  // Image
  $('#imgFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let original;
    try { original = await downscale(file); } catch (err) { toast(err.message, true); return; }
    await cropImage(original, { isNew: true });
  });
  $('#imgCrop').onclick = () => { const url = originalImageUrl(); if (url) cropImage(url); };
  $('#imgRemove').onclick = () => {
    if (cur.pendingImage) {
      // Drop the new photo: back to the saved image (and how it was cropped), if any.
      cur.pendingImage = cur.pendingOriginal = null;
      cur.imageCrop = (savedRec() || {}).imageCrop || null;
    }
    else if (cur.image) cur.removeImage = true;
    updateImageUi();
    recompute();
  };

  // Tabs
  for (const b of $$('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
  $('#panel-cut').addEventListener('change', (e) => {
    const box = e.target.closest('[data-cut]');
    if (box) setCut(box.dataset.cut, box.checked);
  });
  $('#panel-cut').addEventListener('click', (e) => {
    if (e.target.closest('label.tick, input')) return; // ticking a cut, handled above
    const view = e.target.closest('[data-cut-view]');
    if (view) { saveUi({ cutView: view.dataset.cutView }); renderCutList(); return; }
    if (e.target.closest('[data-workshop]')) { openWorkshop(); return; }
    if (e.target.closest('[data-cuts-clear]')) { clearCuts(); return; }
    const pick = e.target.closest('[data-end]');
    if (pick || e.target.closest('[data-corner-clear]')) {
      const end = pick ? pick.dataset.end : null;
      selectedEnd = end === selectedEnd ? null : end;
      renderCutList();
      if (pick) $('#tapeGuide').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const btn = e.target.closest('[data-fence-edge]');
    if (!btn) return;
    const sel = $('#s-fence');
    sel.value = btn.dataset.fenceEdge;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 3D options
  $('#optCanvas').onchange = (e) => viewer && viewer.setOptions({ showCanvas: e.target.checked });
  $('#optMeasure').onchange = (e) => viewer && viewer.setOptions({ showMeasurements: e.target.checked });
  $('#optExplode').onchange = (e) => viewer && viewer.setOptions({ explode: e.target.checked });
  $('#optBlackTop').onchange = (e) => {
    saveUi({ blackCheapTop: e.target.checked });
    if (viewer) viewer.setOptions({ blackCheapTop: e.target.checked });
  };
  for (const b of $$('[data-view]')) b.onclick = () => viewer && viewer.setView(b.dataset.view);
  $('#btnSnapshot').onclick = async () => {
    if (!viewer) return;
    const blob = await (await fetch(viewer.snapshot())).blob();
    download(drawingFileName('3D.png'), blob);
  };

  // Drawing
  $('#btnDownloadSvg').onclick = () => {
    const svg = $('#drawingHost svg');
    if (!svg) return;
    download(drawingFileName('drawing.svg'), new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
  };
  $('#btnPrintDrawing').onclick = () => {
    const svg = $('#drawingHost svg');
    if (!svg) return;
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print the drawing.', true); return; }
    w.document.write(`<!doctype html><title>${esc(drawingFileName('drawing'))}</title>
      <style>@page{size:A4 portrait;margin:8mm}body{margin:0}svg{width:100%;height:auto;display:block}</style>${svg.outerHTML}`);
    w.document.close();
    w.onload = () => { w.focus(); w.print(); };
    setTimeout(() => { try { w.focus(); w.print(); } catch { /* ignore */ } }, 400);
  };

  // Library
  const dlg = $('#libraryDialog');
  $('#btnLibrary').onclick = () => { renderLibrary(); renderArtists(); dlg.showModal(); $('#libSearch').focus(); };
  $('#libClose').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#libSearch').addEventListener('input', renderLibrary);
  $('#libStatus').addEventListener('change', renderLibrary);
  $('#libTable').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deletePainting(del.dataset.del); return; }
    const row = e.target.closest('tr[data-id]');
    if (row && isDirty() && !confirm('You have unsaved changes to the current painting. Discard them?')) return;
    if (row) { savedSnapshot = snapshotOf(cur); dlg.close(); loadPainting(row.dataset.id); }
  });
  for (const b of $$('#libTabs button')) {
    b.onclick = () => {
      for (const x of $$('#libTabs button')) x.classList.toggle('active', x === b);
      for (const p of $$('[data-libpanel]')) p.hidden = p.dataset.libpanel !== b.dataset.lib;
    };
  }
  $('#artistForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#artistName').value.trim();
    if (!name) return;
    try { setDb(await api.addArtist(name)); $('#artistName').value = ''; refreshLists(); } catch (err) { toast(err.message, true); }
  });
  $('#artistTable').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-artist]');
    if (!b) return;
    try { setDb(await api.deleteArtist(b.dataset.delArtist)); refreshLists(); } catch (err) { toast(err.message, true); }
  });

  window.addEventListener('beforeunload', saveDraft);
}

// ---------------------------------------------------------------- Accounts (hosted version only)
let authMode = 'login';

function showAuth(mode = 'login', message = '') {
  setAuthMode(mode);
  $('#authError').hidden = !message;
  $('#authError').textContent = message;
  $('#authScreen').hidden = false;
  $('#authUser').focus();
}

function setAuthMode(mode) {
  authMode = mode;
  for (const b of $$('#authTabs button')) b.classList.toggle('active', b.dataset.authMode === mode);
  for (const el of $$('[data-signup-only]')) el.hidden = mode !== 'signup';
  $('#authPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#authError').hidden = true;
}

function bindAuthEvents(auth) {
  $('#authTabs').hidden = !auth.signup;
  $('#authNote').textContent = auth.signup ? '' : 'Ask the site owner if you need an account.';
  for (const b of $$('#authTabs button')) b.onclick = () => setAuthMode(b.dataset.authMode);

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#authError');
    const body = { username: $('#authUser').value.trim(), password: $('#authPass').value };
    if (authMode === 'signup') {
      if (body.password !== $('#authPass2').value) { err.textContent = "The passwords don't match."; err.hidden = false; return; }
      body.inviteCode = $('#authInvite').value;
    }
    $('#authSubmit').disabled = true;
    try {
      await api.authPost(authMode, body);
      location.reload(); // start fresh with this user's library
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      $('#authSubmit').disabled = false;
    }
  });

  $('#btnSignOut').onclick = async () => {
    saveDraft();
    await api.authPost('logout').catch(() => {});
    location.reload();
  };

  const dlg = $('#passwordDialog');
  $('#btnChangePassword').onclick = () => { $('#passwordForm').reset(); $('#pwError').hidden = true; dlg.showModal(); };
  $('#pwCancel').onclick = () => dlg.close();
  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwError');
    if ($('#pwNew').value !== $('#pwRepeat').value) { err.textContent = "The new passwords don't match."; err.hidden = false; return; }
    try {
      await api.authPost('password', { current: $('#pwCurrent').value, new: $('#pwNew').value });
      dlg.close();
      toast('Password changed. Other devices have been signed out.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// ---------------------------------------------------------------- Version / what's new
const SEEN_VERSION_KEY = 'floating-frame:seen-version';

function formatDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function setupVersion() {
  for (const el of $$('[data-version]')) el.textContent = 'v' + VERSION;
  let seen = null;
  try { seen = localStorage.getItem(SEEN_VERSION_KEY); } catch { /* ignore */ }
  // Flag an update the person hasn't looked at yet (not on their very first visit).
  $('#versionNew').hidden = !seen || seen === VERSION;
  if (!seen) try { localStorage.setItem(SEEN_VERSION_KEY, VERSION); } catch { /* ignore */ }

  const dlg = $('#changelogDialog');
  $('#btnVersion').onclick = () => {
    $('#changelogList').innerHTML = CHANGELOG.map((v, i) => `
      <section class="changelog-entry">
        <h3>v${esc(v.version)} <span class="date">${esc(formatDate(v.date))}</span>${i === 0 ? '<span class="current">current</span>' : ''}</h3>
        <ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </section>`).join('');
    dlg.showModal();
    $('#versionNew').hidden = true;
    try { localStorage.setItem(SEEN_VERSION_KEY, VERSION); } catch { /* ignore */ }
  };
  $('#changelogClose').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// ---------------------------------------------------------------- Guided tour
// Shown automatically the first time someone uses the app (per user, per browser);
// "Tour" under the title runs it again.
const tourKey = () => 'floating-frame:tour-done' + (currentUser ? ':' + currentUser : '');

function runTour() {
  const tabBefore = activeTab;
  startTour([
    { target: null, title: 'Welcome to the Floating Frame Calculator',
      text: '<p>This quick tour shows how to get from a painting’s measurements to a cut list for its floating frame. It takes about a minute.</p><p>You can leave any time, and run it again from <b>Tour</b> under the title.</p>' },
    { target: '#cardPainting', title: 'The painting',
      text: '<p>Give each painting an SKU (or press <b>Generate</b>), a title and the artist. Artists you’ve used before appear in the list as you type.</p>' },
    { target: '#cardSize', title: 'Measure the canvas',
      text: '<p>Enter the top and bottom widths and the left and right heights in mm. Stretched canvases are rarely perfectly square, so measure all four; tick <b>same as</b> when they match.</p><p>Adding the two diagonals gives the most accurate corner angles.</p>' },
    { target: '#cardFrame', title: 'Frame settings',
      text: '<p>Your wood sizes, the gap around the painting and the lip. They’re saved with each painting, and <b>Save as defaults</b> makes them the starting point for new ones.</p>' },
    { target: '#btnSettings', title: 'Settings',
      text: '<p>Tell the app how you cut: how far the far tape point is from the blade, how thick one layer of tape is, and which face of the L goes against the 45° fence. This is also where you set how SKUs are numbered.</p>' },
    { target: '#panel-cut', before: () => setTab('cut'), title: 'The cut list',
      text: '<p>Once the painting is measured, this shows the length of all 8 strips (cut to the <b>long point</b>), the mitre angle at each end, and how many layers of masking tape to put where for each corner.</p><p>Each piece shows the length to cut and, for each end, the mitre angle and tape setup. Tap a setup to see it on the sled diagram, tick ends off as you cut them, or open the Workshop view for big, one-piece-at-a-time instructions.</p>' },
    { target: '[data-tab="model"]', title: '3D model',
      text: '<p>See the finished frame from any angle, show the measurements, and upload a photo of the painting to see it in the frame.</p>' },
    { target: '[data-tab="drawing"]', title: 'Technical drawing',
      text: '<p>A drawing of the frame and every strip with its dimensions, to print or download for the workshop.</p>' },
    { target: '#btnSave', title: 'Save your work',
      text: '<p><b>Save</b> stores the painting in your library. <b>Save as new</b> makes a copy (handy for similar paintings) and <b>New</b> starts a blank one. <b>Share</b> gives you a read-only link to send to someone else.</p>' },
    { target: '.quickload', title: 'Find saved paintings',
      text: '<p>Search by SKU, title or artist, or open the <b>Library</b> to see everything you’ve saved.</p>' },
    { target: '.brand-sub', title: 'That’s it!',
      text: '<p>Click the version number to see what’s changed in each update, or <b>Tour</b> to see this again.</p>' },
  ], {
    onFinish: () => {
      try { localStorage.setItem(tourKey(), '1'); } catch { /* ignore */ }
      setTab(tabBefore);
    },
  });
}

function maybeStartTour() {
  let done = true;
  try { done = !!localStorage.getItem(tourKey()); } catch { /* ignore */ }
  if (!done) setTimeout(runTour, 500);
}

// Admins can see and change the sign-up invite code.
function setupInviteDialog() {
  const dlg = $('#inviteDialog');
  let code = null;
  const show = (c) => {
    code = c;
    $('#inviteOpen').hidden = !code;
    $('#inviteClosed').hidden = !!code;
    $('#inviteCode').textContent = code || '';
  };
  const run = async (fn) => { try { show((await fn()).inviteCode); } catch (e) { toast(e.message, true); } };
  $('#btnInvite').hidden = false;
  $('#btnInvite').onclick = async () => { await run(api.invite); dlg.showModal(); };
  $('#inviteClose').onclick = () => dlg.close();
  $('#inviteNew').onclick = () => {
    if (confirm('Make a new invite code? The current one will stop working.')) run(() => api.inviteAction('new'));
  };
  $('#inviteDisable').onclick = () => {
    if (confirm('Turn off sign-up? Nobody new will be able to create an account.')) run(() => api.inviteAction('disable'));
  };
  $('#inviteEnable').onclick = () => run(() => api.inviteAction('new'));
  $('#inviteCopy').onclick = async () => {
    const url = location.origin + location.pathname;
    const msg = `You're invited to the Floating Frame Calculator: ${url}\nChoose "Create account" and use the invite code ${code}`;
    try { await navigator.clipboard.writeText(msg); toast('Invite message copied'); }
    catch { toast("Copying isn't available here - select the code and copy it instead.", true); }
  };
}

// Installable app: register the service worker, and offer "Install app" when Chrome allows it.
function setupInstall() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* e.g. plain http on the network */ });
  let prompt = null;
  const show = (on) => { $('#btnInstall').hidden = !on; $('.install-sep').hidden = !on; };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; if (!viewOnly) show(true); });
  window.addEventListener('appinstalled', () => { prompt = null; show(false); toast('Installed - open it from your home screen or apps'); });
  $('#btnInstall').onclick = async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice.catch(() => null);
    prompt = null;
    show(false);
  };
}

async function init() {
  setupVersion();
  setupInstall();
  setupWorkshop();
  if (viewOnly) return initShared();
  // Accounts are only on for the hosted version; locally this just says "off".
  let auth = { accounts: false };
  try { auth = await api.auth(); } catch { /* older server or offline - carry on */ }
  if (auth.accounts) {
    bindAuthEvents(auth);
    if (!auth.user) { showAuth(); return; }
    currentUser = auth.user;
    $('#userName').textContent = auth.user;
    if (auth.admin) setupInviteDialog();
    $('#userMenu').hidden = false;
  }

  $('#s-species').innerHTML = Object.entries(SPECIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  bindEvents();
  setupShareDialog();
  setupTimer();
  try {
    setDb(await api.state());
  } catch (e) {
    if (!$('#authScreen').hidden) return;
    toast('Could not reach the server - is it running?', true);
  }
  refreshLists();
  bindSkuSettings();

  const draft = loadDraft();
  if (draft) {
    // Drop a stale link if the painting was deleted elsewhere.
    if (draft.cur.id && !db.paintings.some((p) => p.id === draft.cur.id)) draft.cur.id = null;
    setCurrent({ ...blankPainting(), ...draft.cur }, draft.savedSnapshot);
  } else {
    setCurrent(blankPainting());
  }

  const ui = loadUi();
  $('#optBlackTop').checked = !!ui.blackCheapTop;
  setTab(ui.tab || 'cut');
  $('#btnTour').onclick = runTour;
  maybeStartTour();
}

init();
