#!/bin/sh
# Retakes the README screenshots in docs/screenshots/ using headless Chrome.
# Run from Git Bash in the project folder:   sh docs/take-screenshots.sh
# Uses a temporary data folder with one example painting; your own data isn't touched.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8757
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
TMP="$(mktemp -d)"
mkdir -p "$ROOT/docs/screenshots"
OUT="$(cd "$ROOT/docs/screenshots" && pwd)"
# Chrome on Windows wants a Windows path for --screenshot.
command -v cygpath >/dev/null && OUT_NATIVE="$(cygpath -m "$OUT")" || OUT_NATIVE="$OUT"

cat > "$TMP/db.json" <<'EOF'
{"settings":{"fenceEdge":"goodInner","species":"walnut","skuPrefix":"FF"},
 "paintings":[{"id":"ex1","sku":"FF-2026-0012","title":"Evening Hills","artist":"Jane Doe",
  "topWidth":598,"bottomWidth":603,"sameWidth":false,"leftHeight":401,"rightHeight":397.5,"sameHeight":false,"depth":38,
  "diagA":null,"diagB":null,"image":null,"updatedAt":1790600000,
  "settings":{"goodThickness":15,"cheapThickness":12,"cheapWidth":30,"cheapPosition":"inside","gap":5,"lip":3,"species":"walnut",
              "tapeDistance":250,"tapeThickness":0.12,"fenceEdge":"goodInner","kerf":3}}],
 "artists":["Jane Doe"]}
EOF

# A temporary page that loads the example painting and sets up one scene per screenshot.
SHOT_PAGE="$ROOT/static/_shot.html"
cat > "$SHOT_PAGE" <<'EOF'
<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}iframe{border:0;width:100vw;height:100vh;display:block}</style>
<iframe id="f" src="/"></iframe><script>
localStorage.clear();
localStorage.setItem('floating-frame:tour-done', '1');
const scene = new URLSearchParams(location.search).get('scene');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('f').onload = async () => {
  const w = document.getElementById('f').contentWindow, d = w.document;
  const style = d.createElement('style');
  style.textContent = '*{transition:none!important} #versionNew{display:none!important}';
  d.head.append(style);
  const set = (sel, v) => { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  await sleep(700);
  d.querySelector('#quickLoad').value = 'FF-2026-0012';
  d.querySelector('#quickLoad').dispatchEvent(new w.Event('change'));
  await sleep(500);
  if (scene === 'tape') {
    d.querySelector('.cut-table [data-end="top:TL"]').click(); await sleep(200);
    d.querySelector('#tapeGuide').scrollIntoView({ block: 'end' }); w.scrollBy(0, 20);
  } else if (scene === 'model') {
    d.querySelector('[data-tab="model"]').click();
  } else if (scene === 'drawing') {
    d.querySelector('[data-tab="drawing"]').click();
  } else if (scene === 'changes') {
    set('#f-top', '605'); set('#s-gap', '6'); set('#s-species', 'jarrah');
    style.textContent += '.field:has(#f-top) .revert-btn, .field:has(#f-top) .revert-btn::after{opacity:1!important}';
  }
};
</script>
EOF
cleanup() { rm -f "$SHOT_PAGE"; rm -rf "$TMP"; [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true; }
trap cleanup EXIT

FRAME_DATA="$TMP" FRAME_PORT=$PORT FRAME_HOST=127.0.0.1 python "$ROOT/server.py" --no-browser >/dev/null 2>&1 &
SERVER=$!
sleep 2

for scene in cutlist tape model drawing changes; do
  rm -rf "$TMP/profile"
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --blink-settings=preferredColorScheme=1 --enable-unsafe-swiftshader --use-angle=swiftshader \
    --user-data-dir="$TMP/profile" --window-size=1440,900 --virtual-time-budget=10000 \
    --screenshot="$OUT_NATIVE/$scene.png" "http://127.0.0.1:$PORT/_shot.html?scene=$scene" 2>/dev/null
  echo "docs/screenshots/$scene.png"
done
