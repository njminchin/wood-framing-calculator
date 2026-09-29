# Floating Frame Calculator

Web app for calculating the wood strips for floating picture frames: cut lists, mitre angles with masking-tape shims for a fixed 45° sled, a 3D model and a technical drawing. See README.md for what it does and how to run it.

## Layout

- `server.py` is a zero-dependency Python HTTP server. `accounts.py` handles sign-in, sign-up and sessions (on only when `FRAME_ACCOUNTS=1`).
- `static/` is the vanilla JS front end. `js/geometry.js` does all the maths; `js/app.js` is the UI; `js/viewer3d.js` is the 3D model (three.js is vendored in `static/vendor/`); `js/drawing.js` is the SVG technical drawing.
- `build.py` builds `dist/floating-frame.pyz` (any OS with Python), and with `exe` also `dist/FloatingFrame.exe`.
- `deploy/install-vps.sh` is the cloud VM installer (Caddy for HTTPS, accounts, DuckDNS, path). `deploy/deploy.ps1` builds, backs up the server data, uploads and installs in one step. `pi/install-pi.sh` is the Raspberry Pi installer.

## Conventions

- Australian English in all user-facing text ("mitre", "colour").
- No third-party runtime dependencies: Python standard library only, and plain JS modules.
- The front end must use relative URLs (`api/...`, `images/...`, never `/api/...`), because the app is served under `/framingapp/`.
- The app must keep working without accounts (local PC and Pi use) as well as with them (the hosted VM).
- Keep secrets out of the repo. `deploy/deploy.local.json` (server address and SSH key path) is git-ignored. The DuckDNS token only lives on the server.

## Testing

- There's no test suite. Check changes by running the server on a spare port with a temporary data folder, e.g. `FRAME_PORT=8790 FRAME_HOST=127.0.0.1 FRAME_DATA="$TEMP/ff-test" python server.py --no-browser`, then use `curl` or a small Python script, and headless Chrome (`--screenshot`, `--dump-dom`) for UI checks. Delete temporary test pages afterwards.
- Lint shell scripts with `build/venv/Scripts/shellcheck -s sh <file>`.

## After every change (standing instruction from the owner)

Once a code change is finished and checked, do all of the following without being asked. Skip it for turns that only answer a question or make no changes to the project.

1. **Version:** add an entry at the top of `static/js/version.js` (the version shown in the app and its "What's new" list). Bump patch for fixes and small tweaks, minor for new features, major for big changes. Write the changes for the people using the app.
2. **Build:** `python build.py exe`
3. **Commit** everything relevant with a descriptive message that starts with the version (e.g. `v1.2.0: ...`), tag it (`git tag v1.2.0`), and **push** to `origin main` with tags (`git push origin main --tags`).
4. **Deploy** to the Oracle Cloud VM: `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/deploy.ps1 -SkipBuild`. It backs up the server's data first and checks the site answers afterwards.
5. Report the version, the commit and the deploy result in the reply. If any step fails, stop and say so; don't retry blindly.
