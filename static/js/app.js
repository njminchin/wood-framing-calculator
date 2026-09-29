import { computeFrame, solveQuad, FENCE_FACES, onInnerSide } from './geometry.js';
import { buildDrawing } from './drawing.js';
import { SPECIES } from './textures.js';
import { VERSION, CHANGELOG } from './version.js';
import { nextSku, DEFAULT_SKU_FORMAT } from './sku.js';
import { startTour } from './tour.js';

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
  uploadImage: (id, blob) => api.req('POST', `api/paintings/${id}/image`, blob),
  deleteImage: (id) => api.req('DELETE', `api/paintings/${id}/image`),
  setShare: (id, share) => api.req('POST', `api/paintings/${id}/share`, { share }),
  shared: (token) => api.req('GET', `api/share/${encodeURIComponent(token)}`),
  setMade: (id, made) => api.req('POST', `api/paintings/${id}/made`, { made }),
  addArtist: (name) => api.req('POST', 'api/artists', { name }),
  deleteArtist: (name) => api.req('DELETE', `api/artists/${encodeURIComponent(name)}`),
};

// ---------------------------------------------------------------- State
let db = { settings: {}, paintings: [], artists: [] };
let cur = null; // the painting being edited
let savedSnapshot = null; // JSON of `cur` as last saved/loaded, for dirty tracking
let frame = null;
let viewer = null;
let activeTab = 'cut';
let drawingDirty = true, modelDirty = true;
let selectedCorner = null; // corner index shown in the tape guide, or null for the general view
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
    madeAt: null, // when the frame was marked as made (seconds), saved straight away
    pendingImage: null, // data URL of a newly chosen image (uploaded on save)
    removeImage: false,
    settings: { ...db.settings },
  };
}

function fromRecord(rec) {
  const p = blankPainting();
  for (const k of [...PAINTING_TEXT, ...PAINTING_NUM, ...PAINTING_BOOL, 'id', 'image', 'updatedAt', 'madeAt', 'shareToken']) if (k in rec) p[k] = rec[k];
  p.settings = { ...db.settings, ...(rec.settings || {}) };
  return p;
}

function toRecord(p) {
  const r = { id: p.id || undefined, settings: p.settings };
  for (const k of [...PAINTING_TEXT, ...PAINTING_NUM, ...PAINTING_BOOL]) r[k] = p[k];
  return r;
}

const snapshotOf = (p) => JSON.stringify({ ...toRecord(p), pendingImage: !!p.pendingImage, removeImage: p.removeImage });
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

function tapeCell(t) {
  if (t.invalid) return '<span class="tag none">check cutting setup</span>';
  if (t.layers === 0) return '<span class="tag none">no tape</span>';
  return `<span class="tag ${t.location}">${t.location === 'far' ? 'FAR end' : 'NEAR blade'}</span> <b>${t.layers}</b> layer${t.layers === 1 ? '' : 's'} <span class="sub">(${f2(t.shim)} mm)</span>`;
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
  const stripsRows = stripGroups(frame).map((g) => {
    const st = g.strips[0];
    const ends = g.ends.map((e) => `<span class="angle">${e.angle}°</span> <span class="sub">${e.keys.join(' / ')}</span>`).join(' &nbsp;·&nbsp; ');
    const painting = g.strips.length > 1 && f1(g.strips[0].paintingLength) !== f1(g.strips[1].paintingLength)
      ? g.strips.map((x) => f1(x.paintingLength)).join(' / ')
      : f1(st.paintingLength);
    return `<tr>
      <td><b>${g.name}</b>${g.strips.length > 1 ? ' <span class="sub">×2</span>' : ''}<div class="sub">painting ${painting}</div></td>
      <td class="num big">${f1(st.good.longPoint)}</td>
      <td class="num">${f1(st.good.shortPoint)}</td>
      <td class="num">${f1(st.cheap.longPoint)}</td>
      <td class="num">${f1(st.cheap.shortPoint)}</td>
      <td>${ends}</td>
    </tr>`;
  }).join('');
  const dg = frame.diagonals;
  const diagDiff = (d) => Math.abs(d.a - d.b);

  const cornerRows = frame.corners.map((c, i) => `<tr class="clickable${i === selectedCorner ? ' selected' : ''}" data-corner="${i}" title="Show this corner in the tape diagram">
      <td><b>${c.key}</b> <span class="sub">${c.name}</span></td>
      <td class="num">${f2(c.angle)}°</td>
      <td class="num angle">${f2(c.mitre)}°</td>
      <td>${tapeCell(c.tape)}</td>
      <td class="num">${f2(c.tape.result)}°</td>
      <td class="num">${Math.abs(c.tape.error) < 0.005 ? '0.00' : (c.tape.error > 0 ? '+' : '') + f2(c.tape.error)}°</td>
      <td class="num">${c.jointOpening < 0.05 ? '<span class="sub">&lt; 0.05</span>' : f2(c.jointOpening)} <span class="sub">${c.jointOpening < 0.05 ? '' : c.openingAt === 'inner' ? 'inside' : 'outside'}</span></td>
    </tr>`).join('');

  const perLayer = (Math.atan(s.tapeThickness / s.tapeDistance) * 180) / Math.PI;
  const face = FENCE_FACES[s.fenceEdge] || FENCE_FACES.outer;
  const outerFence = !onInnerSide(s.fenceEdge);
  const farEffect = outerFence ? 'smaller (more acute)' : 'larger';
  const nearEffect = outerFence ? 'larger' : 'smaller (more acute)';

  host.innerHTML = `
    ${alerts ? `<div class="alerts">${alerts}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Outer frame size</div><div class="v">${f1(frame.outerSize.top)} × ${f1(frame.outerSize.left)}</div><div class="s">top × left, outside edges</div></div>
      <div class="stat"><div class="k">Good wood stock</div><div class="v">${f1(s.goodThickness)} × ${f1(frame.goodWidth)}</div><div class="s">thickness × width · need ≥ ${f1(frame.stock.good)} long</div></div>
      <div class="stat"><div class="k">Cheap wood stock</div><div class="v">${f1(s.cheapThickness)} × ${f1(s.cheapWidth)}</div><div class="s">thickness × width · need ≥ ${f1(frame.stock.cheap)} long</div></div>
      <div class="stat"><div class="k">Canvas support</div><div class="v">${f1(frame.support)}</div><div class="s">cheap strip reaches under the canvas</div></div>
    </div>

    <h3>Cut list - 4 L assemblies</h3>
    <p class="note" style="margin-top:0">Glue each cheap strip to its good wood strip ${frame.inside ? '(against the inside face, at the back)' : '(underneath, outer edges flush)'}, then mitre both ends of the L in one cut. Long point = outer (visible) edge of the good wood.</p>
    <div class="table-wrap"><table class="table">
      <thead>
        <tr class="group-head"><th></th><th colspan="2" class="num">Good wood</th><th colspan="2" class="num">Cheap wood</th><th></th></tr>
        <tr><th>Side</th><th class="num">Long point</th><th class="num">Short point</th><th class="num">Outer edge</th><th class="num">Inner edge</th><th>Mitre at each end</th></tr>
      </thead>
      <tbody>${stripsRows}</tbody>
    </table></div>

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

    <h3>Corners &amp; tape shims</h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Corner</th><th class="num">Frame angle</th><th class="num">Mitre (both strips)</th><th>Tape on the 45° fence</th><th class="num">You'll cut</th><th class="num">Error</th><th class="num">Joint gap (mm)</th></tr></thead>
      <tbody>${cornerRows}</tbody>
    </table></div>
    <p class="note">Click a corner to see its tape setup in the diagram below. Each layer of tape (${s.tapeThickness} mm at ${s.tapeDistance} mm) turns the strip about ${f2(perLayer)}°. Layers are rounded towards the slightly more acute side so the joint closes at the visible outside corner and any gap is on the inside, hidden against the painting.</p>

    <h3>Using the tape shims</h3>
    <div class="guide" id="tapeGuide">
      ${tapeGuideSvg(s, selectedCorner === null ? null : frame.corners[selectedCorner])}
      <div>
        ${cornerCaption(frame)}
        <div class="guide-label">Against the 45° fence:</div>
        <div class="seg guide-toggle" role="group" aria-label="Face against the fence">
          ${Object.entries(FENCE_FACES).map(([k, f]) => `<button type="button" data-fence-edge="${k}" class="${k === s.fenceEdge ? 'active' : ''}">${f.short}</button>`).join('')}
        </div>
        <div>The strip goes on the <b>${face.side} side</b> of the fence so the long point ends up on the outside of the frame${
          s.fenceEdge === 'goodInner' ? '. Lay the L <b>upside down</b>: the good wood\'s front edge on the sled, the cheap wood on top reaching over the fence.' : '.'}</div>
        <ul>
          <li><span class="tag far">FAR end</span> tape on the fence ~${f1(s.tapeDistance)} mm from the blade makes the mitre <b>${farEffect}</b> than 45°.</li>
          <li><span class="tag near">NEAR blade</span> tape on the fence right next to the blade makes it <b>${nearEffect}</b> than 45°.</li>
          <li>Stack the layers at one point only - the strip should still touch the bare fence (or its tape) at both points.</li>
        </ul>
        <p class="note">Painting shape ${q.method === 'diagonals' ? `fitted to your diagonal${p.diagA && p.diagB ? 's' : ''} (off by ${f1(q.diagResidual)} mm)` : 'assumed "most square". Measure its diagonals to check'}: BL→TR <b>${f1(q.diagA)}</b>, TL→BR <b>${f1(q.diagB)}</b>.</p>
      </div>
    </div>`;
}

// Cut list rows in Top, Bottom, Left, Right order. Opposite strips that come out
// identical (same lengths and the same pair of mitre angles) share one row.
function stripGroups(frame) {
  const byKey = Object.fromEntries(frame.strips.map((st) => [st.key, st]));
  const lengths = (st) => [st.good.longPoint, st.good.shortPoint, st.cheap.longPoint, st.cheap.shortPoint].map(f1).join('|');
  const endsOf = (st) => [st.corners[1], st.corners[0]].map((c) => ({ angle: f2(frame.corners[c].mitre), key: frame.corners[c].key }));
  const angles = (st) => endsOf(st).map((e) => e.angle).sort().join('|');
  const groups = [];
  for (const [a, b, name] of [['top', 'bottom', 'Top & Bottom'], ['left', 'right', 'Left & Right']]) {
    const A = byKey[a], B = byKey[b];
    if (lengths(A) === lengths(B) && angles(A) === angles(B)) {
      // Pair up the ends that share an angle, e.g. "45.03° TL / BR".
      const bEnds = endsOf(B);
      const ends = endsOf(A).map((e) => {
        const k = bEnds.findIndex((x) => x.angle === e.angle);
        return { angle: e.angle, keys: [e.key, bEnds.splice(k, 1)[0].key] };
      });
      groups.push({ name, strips: [A, B], ends });
    } else {
      for (const st of [A, B]) groups.push({ name: st.name, strips: [st], ends: endsOf(st).map((e) => ({ angle: e.angle, keys: [e.key] })) });
    }
  }
  return groups;
}

// Which corner the tape diagram is showing, and which strip ends that setup cuts.
function cornerCaption(frame) {
  if (selectedCorner === null) {
    return '<p class="guide-pick">Click a row in the corners table above to show that corner\'s tape setup here.</p>';
  }
  const c = frame.corners[selectedCorner], t = c.tape;
  const ends = frame.strips.filter((st) => st.corners.includes(selectedCorner)).map((st) => `${st.name.toLowerCase()} strip`);
  const setup = t.layers === 0
    ? 'no tape - cut it straight off the 45° fence'
    : `<b>${t.layers} layer${t.layers === 1 ? '' : 's'}</b> of tape (${f2(t.shim)} mm) at the <b>${t.location === 'far' ? 'FAR point' : 'NEAR point, by the blade'}</b>`;
  return `<div class="guide-pick active"><b>${c.key} (${c.name})</b>: ${setup}, to cut <span class="angle">${f2(t.result)}°</span>
    for the ${f2(c.mitre)}° mitre. Used for the ${c.key} end of the ${ends.join(' and the ')}.
    <button type="button" class="link" data-corner-clear>Show both points</button></div>`;
}

// Bird's-eye view of the 45° sled: blade at the top, the fence running away from
// the kerf down to the right, and the L strip against one side of it. With a
// corner, only that corner's tape point is lit and its stack of layers is drawn.
function tapeGuideSvg(s, corner = null) {
  const c = Math.SQRT1_2;
  const K = 150, AY = 112; // kerf x, and where the fence's blade-side face meets the kerf
  // P(a, o): a along the fence away from the blade, o off the fence's blade-side
  // face (+ towards the blade, - towards the operator).
  const P = (a, o) => [K + c * a + c * o, AY + c * a - c * o];
  const pts = (arr) => arr.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ');
  const rot = (q) => `rotate(45 ${q[0].toFixed(1)} ${q[1].toFixed(1)})`;
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
  const lblAnchor = bladeSide ? 'end' : 'start'; // keep labels clear of the fence
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
  const title = corner
    ? `<text class="g-title" x="16" y="66">${corner.key} corner</text>
       <text class="g-muted" x="16" y="80">mitre ${f2(corner.mitre)}° → cut ${f2(tape.result)}°</text>`
    : '';
  const bandLabel = (b) => {
    const q = P(b.over ? 60 : 75, (b.oa + b.ob) / 2);
    return `<text class="g-band-t" x="${q[0]}" y="${q[1]}" text-anchor="middle" dominant-baseline="middle" transform="${rot(q)}">${b.label}</text>`;
  };
  return `<svg viewBox="0 0 330 300" role="img" aria-label="Sled seen from above: blade, 45 degree fence and strip">
    <defs><clipPath id="sledClip"><rect x="6" y="46" width="318" height="248" rx="6"/></clipPath>
      <marker id="gArrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" class="g-arrowhead"/></marker></defs>
    <rect class="g-sled" x="6" y="46" width="318" height="248" rx="6"/>
    <line class="g-kerf" x1="${K}" y1="46" x2="${K}" y2="294"/>
    <g clip-path="url(#sledClip)">
      <polygon class="g-offcut" points="${pts(offcut)}"/>
      <polygon class="g-fence" points="${pts(fence)}"/>
      ${bands.map((b) => `<polygon class="g-${b.k}${b.over ? ' g-over' : ''}" points="${pts(band(b))}"/>`).join('')}
    </g>
    ${bands.map(bandLabel).join('')}
    <text class="g-fence-t" x="${fenceL[0]}" y="${fenceL[1]}" text-anchor="middle" dominant-baseline="middle" transform="${rot(fenceL)}">45° fence</text>
    <rect class="g-blade" x="${K - 2.5}" y="6" width="5" height="36" rx="1"/>
    <text class="g-blade-t" x="${K + 8}" y="24">blade</text>
    <circle class="g-tip" cx="${tip[0]}" cy="${tip[1]}" r="3.5"/>
    <text class="g-ink" x="${K - 7}" y="${tip[1] + 4}" text-anchor="end">long point</text>
    ${stack}
    <circle class="${lit('near') ? 'g-near' : 'g-off'}" cx="${near[0]}" cy="${near[1]}" r="5.5"/>
    ${pointLabel('near', nearL[0], nearL[1] + 4, 'NEAR')}
    <circle class="${lit('far') ? 'g-far' : 'g-off'}" cx="${far[0]}" cy="${far[1]}" r="5.5"/>
    ${pointLabel('far', farL[0], farL[1] + 4, `FAR · ${f1(s.tapeDistance)} mm`)}
    ${title}
    <line class="g-arrow" x1="28" y1="270" x2="28" y2="215" marker-end="url(#gArrow)"/>
    <text class="g-muted" x="28" y="284" text-anchor="middle">feed</text>
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
// SKU numbering is a personal preference saved straight to the defaults, not a frame setting.
const SKU_SETTINGS = ['skuFormat', 'skuPrefix'];

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
      cur.pendingImage = null;
      cur.removeImage = false;
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
    db = await api.state();
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
  updateMade();
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
  $('#dlPaintings').innerHTML = sorted.map((p) => opt(paintingLabel(p))).join('');
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
    try { localStorage.setItem(draftKey(), JSON.stringify({ cur: { ...cur, pendingImage: null }, savedSnapshot })); } catch { /* ignore */ }
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
      const blob = await (await fetch(cur.pendingImage)).blob();
      res = await api.uploadImage(cur.id, blob);
    } else if (cur.removeImage && cur.image) {
      res = await api.deleteImage(cur.id);
      res.painting = res.paintings.find((p) => p.id === cur.id);
    }
    db = { settings: res.settings, paintings: res.paintings, artists: res.artists };
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
  const onChange = () => {
    db.settings.skuFormat = $('#sku-format').value.trim() || DEFAULT_SKU_FORMAT;
    db.settings.skuPrefix = $('#sku-prefix').value.trim();
    updateSkuPreview();
    clearTimeout(skuSaveTimer);
    skuSaveTimer = setTimeout(async () => {
      try { db.settings = (await api.saveSettings(db.settings)).settings; }
      catch (e) { toast("Couldn't save the SKU format: " + e.message, true); }
    }, 700);
  };
  $('#sku-format').addEventListener('input', onChange);
  $('#sku-prefix').addEventListener('input', onChange);
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
  // Give the copy its own copy of the painting image.
  if (!cur.pendingImage && cur.image && !cur.removeImage) {
    try {
      const blob = await (await fetch(currentImageUrl())).blob();
      cur.pendingImage = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      toast("Couldn't copy the painting image - the new painting won't have one.", true);
    }
  }
  cur.id = null;
  cur.image = null;
  cur.removeImage = false;
  cur.madeAt = null; // the copy's frame hasn't been made yet
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
    db = res;
    if (cur.id === id) { cur.id = null; cur.image = null; savedSnapshot = 'deleted'; updateStatus(); updateImageUi(); }
    refreshLists();
    toast('Deleted');
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- Made
// A frame can be marked as made. This is saved straight away (it isn't one of
// the painting's values, so it doesn't count as an unsaved change).
const madeDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function updateMade() {
  const made = !!(cur.id && cur.madeAt);
  const box = $('#madeBox');
  box.classList.toggle('is-made', made);
  $('#madeBadge').hidden = !made;
  $('#madeBadge').title = made ? `This frame was made on ${madeDate(cur.madeAt)}` : '';
  $('#cardPainting').classList.toggle('made', made);
  const text = $('#madeText'), btn = $('#btnMade');
  btn.disabled = !cur.id;
  if (made) {
    text.innerHTML = `<b>&#10003; Made</b> on ${esc(madeDate(cur.madeAt))}`
      + (isDirty() && !viewOnly ? '<span class="made-warn">You’re changing a frame that’s already been made.</span>' : '');
    btn.textContent = 'Not made';
    btn.title = 'Mark this frame as not made yet';
  } else {
    text.textContent = cur.id ? 'Frame not made yet' : 'Save the painting to mark its frame as made';
    btn.textContent = 'Mark as made';
    btn.title = cur.id ? 'Record that this frame has been made' : 'Save the painting first';
  }
}

async function toggleMade() {
  if (!cur.id) return;
  const made = !cur.madeAt;
  if (!made && !confirm('Mark this frame as not made yet?')) return;
  try {
    const res = await api.setMade(cur.id, made);
    db = { settings: res.settings, paintings: res.paintings, artists: res.artists };
    cur.madeAt = res.painting.madeAt ?? null;
    refreshLists();
    updateStatus();
    saveDraft();
    toast(made ? 'Marked as made' : 'Marked as not made');
  } catch (e) { toast(e.message, true); }
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
    db = { settings: res.settings, paintings: res.paintings, artists: res.artists };
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
  $('#imgNote').textContent = cur.pendingImage ? 'New image - saved with the painting.' : cur.removeImage ? 'Image will be removed on save.' : url ? '' : 'Shown on the 3D model.';
  if (viewer) viewer.setImage(url);
}

// ---------------------------------------------------------------- Library dialog
function renderLibrary() {
  const q = norm($('#libSearch').value);
  const show = $('#libMade').value;
  const rows = [...db.paintings]
    .filter((p) => show === 'all' || (show === 'made') === !!p.madeAt)
    .filter((p) => !q || [p.sku, p.title, p.artist].some((v) => norm(v).includes(q)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const size = (p) => {
    const w = p.sameWidth ? p.topWidth : `${f1(p.topWidth)}/${f1(p.bottomWidth)}`;
    const h = p.sameHeight ? p.leftHeight : `${f1(p.leftHeight)}/${f1(p.rightHeight)}`;
    return `${typeof w === 'number' ? f1(w) : w} × ${typeof h === 'number' ? f1(h) : h} × ${f1(p.depth)}`;
  };
  $('#libTable').innerHTML = `<thead><tr><th>SKU</th><th>Title</th><th>Artist</th><th>Size (W × H × D)</th><th>Made</th><th>Updated</th><th></th></tr></thead><tbody>${
    rows.map((p) => `<tr class="clickable${p.madeAt ? ' made' : ''}" data-id="${p.id}">
      <td><b>${esc(p.sku || '-')}</b>${p.shareToken ? ' <span class="sub" title="Shared with a read-only link">&#128279;</span>' : ''}</td><td>${esc(p.title || '-')}</td><td>${esc(p.artist || '-')}</td>
      <td class="sub">${size(p)}</td>
      <td>${p.madeAt ? `<span class="made-pill" title="Made on ${esc(madeDate(p.madeAt))}">&#10003; ${esc(madeDate(p.madeAt))}</span>` : '<span class="sub">-</span>'}</td>
      <td class="sub">${p.updatedAt ? new Date(p.updatedAt * 1000).toLocaleDateString() : ''}</td>
      <td><button type="button" class="link danger" data-del="${p.id}">Delete</button></td></tr>`).join('')
    || `<tr><td colspan="7" class="sub">${db.paintings.length ? 'No matches.' : 'Nothing saved yet - fill in a painting and press Save.'}</td></tr>`
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
    const v = e.target.value.trim();
    if (!v) return;
    const rec = db.paintings.find((p) => paintingLabel(p) === v)
      || db.paintings.find((p) => norm(p.sku) === norm(v) || norm(p.title) === norm(v));
    if (rec) { loadPainting(rec.id); e.target.value = ''; }
    else toast('No saved painting matches that.', true);
  });

  $('#btnNew').onclick = newPainting;
  $('#btnSave').onclick = () => save();
  $('#btnSaveAsNew').onclick = saveAsNew;
  $('#btnReload').onclick = reloadSaved;
  $('#btnMade').onclick = toggleMade;
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
    try {
      cur.pendingImage = await downscale(file);
      cur.removeImage = false;
      updateImageUi();
      recompute();
    } catch (err) { toast(err.message, true); }
  });
  $('#imgRemove').onclick = () => {
    if (cur.pendingImage) cur.pendingImage = null;
    else if (cur.image) cur.removeImage = true;
    updateImageUi();
    recompute();
  };

  // Tabs
  for (const b of $$('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
  $('#panel-cut').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-corner]');
    if (row || e.target.closest('[data-corner-clear]')) {
      const i = row ? Number(row.dataset.corner) : null;
      selectedCorner = i === selectedCorner ? null : i;
      renderCutList();
      if (row) $('#tapeGuide').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  $('#libMade').addEventListener('change', renderLibrary);
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
    try { db = await api.addArtist(name); $('#artistName').value = ''; refreshLists(); } catch (err) { toast(err.message, true); }
  });
  $('#artistTable').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-artist]');
    if (!b) return;
    try { db = await api.deleteArtist(b.dataset.delArtist); refreshLists(); } catch (err) { toast(err.message, true); }
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
    { target: '#cardCutting', title: 'Your mitre sled',
      text: '<p>Tell the app how you cut: how far the far tape point is from the blade, how thick one layer of tape is, and which face of the L goes against the 45° fence.</p>' },
    { target: '#panel-cut', before: () => setTab('cut'), title: 'The cut list',
      text: '<p>Once the painting is measured, this shows the length of all 8 strips (cut to the <b>long point</b>), the mitre angle at each end, and how many layers of masking tape to put where for each corner.</p><p>Click a corner to see its setup on the sled diagram.</p>' },
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

async function init() {
  setupVersion();
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
  try {
    db = await api.state();
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
