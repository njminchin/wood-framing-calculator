"""Build distributable packages into ./dist

    python build.py        -> dist/floating-frame.pyz   (runs anywhere with Python 3.9+:
                              Windows, Raspberry Pi, Mac, Linux)
                              dist/install-pi.sh        (Raspberry Pi service installer)
                              dist/install-vps.sh       (cloud VPS installer: Caddy, HTTPS, login)
    python build.py exe    -> the above, plus a single-file executable for THIS platform
                              (dist/FloatingFrame.exe on Windows) that needs no Python.
                              PyInstaller is installed into a private venv under ./build.
"""

import os
import shutil
import subprocess
import sys
import zipapp

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")


def build_pyz():
    stage = os.path.join(BUILD, "pyz")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    for module in ("server.py", "accounts.py"):
        shutil.copy2(os.path.join(ROOT, module), stage)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(stage, "static"))
    os.makedirs(DIST, exist_ok=True)
    target = os.path.join(DIST, "floating-frame.pyz")
    zipapp.create_archive(stage, target, interpreter="/usr/bin/env python3", main="server:main", compressed=True)
    # Copy with LF line endings preserved (binary copy).
    shutil.copyfile(os.path.join(ROOT, "pi", "install-pi.sh"), os.path.join(DIST, "install-pi.sh"))
    shutil.copyfile(os.path.join(ROOT, "deploy", "install-vps.sh"), os.path.join(DIST, "install-vps.sh"))
    print(f"Built {target} ({os.path.getsize(target) // 1024} KB)")


def build_exe():
    venv = os.path.join(BUILD, "venv")
    py = os.path.join(venv, "Scripts" if os.name == "nt" else "bin", "python")
    if not os.path.exists(py + (".exe" if os.name == "nt" else "")):
        print("Creating build venv…")
        subprocess.check_call([sys.executable, "-m", "venv", venv])
    subprocess.check_call([py, "-m", "pip", "install", "--quiet", "--upgrade", "pyinstaller"])
    name = "FloatingFrame"
    subprocess.check_call([
        py, "-m", "PyInstaller", "--noconfirm", "--onefile", "--name", name,
        "--add-data", f"{os.path.join(ROOT, 'static')}{os.pathsep}static",
        "--distpath", DIST,
        "--workpath", os.path.join(BUILD, "pyinstaller"),
        "--specpath", BUILD,
        os.path.join(ROOT, "server.py"),
    ])
    exe = os.path.join(DIST, name + (".exe" if os.name == "nt" else ""))
    print(f"Built {exe} ({os.path.getsize(exe) // (1024 * 1024)} MB)")


if __name__ == "__main__":
    build_pyz()
    if "exe" in sys.argv[1:]:
        build_exe()
