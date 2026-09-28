#!/bin/sh
# Installs (or updates) Floating Frame Calculator as a service on a Raspberry Pi.
# Put this script next to floating-frame.pyz and run:   sh install-pi.sh
# Your saved paintings stay in ~/floating-frame/data and survive updates.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/floating-frame"
PORT="${FRAME_PORT:-8765}"
PYTHON="$(command -v python3 || true)"

if [ -z "$PYTHON" ]; then
  echo "python3 not found. Install it with:  sudo apt install python3"
  exit 1
fi
if [ ! -f "$HERE/floating-frame.pyz" ]; then
  echo "floating-frame.pyz must be in the same folder as this script."
  exit 1
fi

mkdir -p "$APP_DIR"
cp "$HERE/floating-frame.pyz" "$APP_DIR/"

sudo tee /etc/systemd/system/floating-frame.service >/dev/null <<UNIT
[Unit]
Description=Floating Frame Calculator
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP_DIR
Environment=FRAME_HOST=0.0.0.0
Environment=FRAME_PORT=$PORT
Environment=PYTHONUNBUFFERED=1
ExecStart=$PYTHON $APP_DIR/floating-frame.pyz --no-browser
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable floating-frame >/dev/null
sudo systemctl restart floating-frame

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "Floating Frame Calculator is running and will start on every boot."
echo "  On the Pi:            http://127.0.0.1:$PORT/"
[ -n "$IP" ] && echo "  From other devices:   http://$IP:$PORT/"
echo "  Data folder:          $APP_DIR/data"
echo "  Logs:                 journalctl -u floating-frame -f"
