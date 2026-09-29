#!/bin/sh
# Installs (or updates) Floating Frame Calculator on a cloud VPS (e.g. Oracle
# Cloud). Caddy provides HTTPS; the app has its own accounts, each with a
# private library, and people can sign up with your invite code.
#
# Put this script next to floating-frame.pyz on the server and run:
#
#   sh install-vps.sh                          install, or update (keeps everything)
#   sh install-vps.sh --domain frames.example.com   use your own domain
#   sh install-vps.sh --duckdns NAME           use NAME.duckdns.org and keep its IP up to date
#   sh install-vps.sh --path /framingapp       serve the app under a path (--path / for the root)
#
# Accounts (run on the server any time after installing):
#   sh install-vps.sh --list-users             who has an account; the invite code
#   sh install-vps.sh --add-user NAME          create an account yourself
#   sh install-vps.sh --reset-password NAME    set a new password for someone
#   sh install-vps.sh --remove-user NAME       delete an account (their data is kept)
#   sh install-vps.sh --new-invite-code        make a new code (the old one stops working)
#   sh install-vps.sh --disable-signup         turn sign-up off
#
# Options are remembered, so a plain re-run keeps the same address and path.
#   sh install-vps.sh --update                 update without asking anything (for scripts)
# Without --domain the address is <public-ip>.sslip.io. Data is kept in
# ~/floating-frame/data. Intended for Ubuntu 22.04/24.04 and Oracle Linux 8/9.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/floating-frame"
APP="$APP_DIR/floating-frame.pyz"
APP_PORT="${FRAME_PORT:-8765}"
DOMAIN=""
BASE_PATH="" PATH_SET=no
DUCK_NAME=""
DUCK_ENV=/etc/floating-frame/duckdns.env
CADDYFILE="${FRAME_CADDYFILE:-/etc/caddy/Caddyfile}"  # override only for testing
MARKER="# floating-frame (managed by install-vps.sh)"

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 not found. Install it first (sudo apt install python3 / sudo dnf install python3)."; exit 1; }
app() { "$PYTHON" "$APP" "$@"; }

# ---------------------------------------------------------------- account commands
ACCOUNT_CMD=""
UNATTENDED=no
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --duckdns) DUCK_NAME="${2%.duckdns.org}"; shift 2 ;;
    --path) BASE_PATH="/$(echo "$2" | sed 's#^/*##; s#/*$##')"; [ "$BASE_PATH" = / ] && BASE_PATH=""; PATH_SET=yes; shift 2 ;;
    --add-user) ACCOUNT_CMD="--create-user $2"; shift 2 ;;
    --reset-password) ACCOUNT_CMD="--reset-password $2"; shift 2 ;;
    --remove-user) ACCOUNT_CMD="--delete-user $2"; shift 2 ;;
    --list-users) ACCOUNT_CMD="--list-users"; shift ;;
    --new-invite-code) ACCOUNT_CMD="--new-invite-code"; shift ;;
    --disable-signup) ACCOUNT_CMD="--disable-signup"; shift ;;
    --update) UNATTENDED=yes; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

if [ -n "$ACCOUNT_CMD" ]; then
  [ -f "$APP" ] || { echo "The app isn't installed yet - run 'sh install-vps.sh' first."; exit 1; }
  # shellcheck disable=SC2086  # split "--flag NAME" into two arguments on purpose
  app $ACCOUNT_CMD
  exit $?
fi

# ---------------------------------------------------------------- install / update
say() { printf '\n==> %s\n' "$*"; }

[ -f "$HERE/floating-frame.pyz" ] || { echo "floating-frame.pyz must be in the same folder as this script."; exit 1; }
command -v systemctl >/dev/null || { echo "This script needs a systemd-based Linux."; exit 1; }
if command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
else echo "Unsupported Linux: need apt (Ubuntu/Debian) or dnf (Oracle Linux/RHEL)."; exit 1
fi

case "$DUCK_NAME" in *[!a-z0-9-]*) echo "DuckDNS names use lowercase letters, numbers and - only."; exit 1 ;; esac
[ -z "$DUCK_NAME" ] || [ -n "$DOMAIN" ] || DOMAIN="$DUCK_NAME.duckdns.org"

MANAGED=no
if sudo test -f "$CADDYFILE" && sudo grep -q "$MARKER" "$CADDYFILE"; then
  MANAGED=yes
  # Keep the address and path used last time.
  [ -n "$DOMAIN" ] || DOMAIN="$(sudo awk 'f {print $1; exit} $0 ~ /floating-frame \(managed/ {f=1}' "$CADDYFILE")"
  [ "$PATH_SET" = yes ] || BASE_PATH="$(sudo awk '$1 == "handle_path" {sub(/\/\*$/, "", $2); print $2; exit}' "$CADDYFILE")"
fi

# DuckDNS: ask for the token now (hidden), so the rest can run unattended.
DUCK_TOKEN=""
if [ -n "$DUCK_NAME" ]; then
  if sudo test -f "$DUCK_ENV"; then TOKEN_PROMPT="DuckDNS token (Enter to keep the saved one): "
  else TOKEN_PROMPT="DuckDNS token (shown at the top of duckdns.org once signed in): "; fi
  while :; do
    stty -echo 2>/dev/null || true
    printf '%s' "$TOKEN_PROMPT"; read -r DUCK_TOKEN || DUCK_TOKEN=""; printf '\n'
    stty echo 2>/dev/null || true
    if [ -z "$DUCK_TOKEN" ] && sudo test -f "$DUCK_ENV"; then break; fi
    case "$DUCK_TOKEN" in
      ''|*[!0-9a-fA-F-]*) echo "That doesn't look like a DuckDNS token (e.g. 1a2b3c4d-....). Try again." ;;
      *) break ;;
    esac
  done
fi
if [ -z "$DOMAIN" ]; then
  IP="$(curl -s --max-time 8 https://api.ipify.org || curl -s --max-time 8 https://ifconfig.me || true)"
  if [ -n "$IP" ]; then
    DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
  else
    printf 'Could not detect the public IP. Enter the domain or public IP to use: '
    read -r DOMAIN
    case "$DOMAIN" in *[!0-9.]*) ;; *) DOMAIN="$(echo "$DOMAIN" | tr '.' '-').sslip.io" ;; esac
  fi
fi

if [ -n "$DUCK_NAME" ]; then
  say "Setting up DuckDNS for $DUCK_NAME.duckdns.org"
  sudo mkdir -p "$(dirname "$DUCK_ENV")"
  if [ -n "$DUCK_TOKEN" ]; then
    printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "$DUCK_NAME" "$DUCK_TOKEN" | sudo tee "$DUCK_ENV" >/dev/null
  else
    sudo sed -i "s/^DUCKDNS_DOMAIN=.*/DUCKDNS_DOMAIN=$DUCK_NAME/" "$DUCK_ENV"
  fi
  sudo chmod 600 "$DUCK_ENV"
  DUCK_TOKEN=""
  sudo tee /usr/local/bin/floating-frame-duckdns >/dev/null <<'SCRIPT'
#!/bin/sh
# Points the DuckDNS name at this server's public IP. Only contacts DuckDNS when
# the IP has changed since the last successful update (or after a reboot).
. /etc/floating-frame/duckdns.env
STATE=/run/floating-frame-duckdns.ip
IP="$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 https://ifconfig.me || true)"
case "$IP" in ''|*[!0-9.]*) echo "Could not find the public IP - will try again later."; exit 0 ;; esac
[ -f "$STATE" ] && [ "$(cat "$STATE")" = "$IP" ] && exit 0
# The URL (with the token) goes to curl on stdin, so it isn't visible in the process list.
RESULT="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=%s"\n' \
  "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" "$IP" | curl -s --max-time 15 -K -)"
if [ "$RESULT" = OK ]; then
  echo "$IP" > "$STATE"
  echo "DuckDNS: $DUCKDNS_DOMAIN.duckdns.org -> $IP"
else
  echo "DuckDNS update failed (answer: '$RESULT'). Check the name and token in /etc/floating-frame/duckdns.env"
  exit 1
fi
SCRIPT
  sudo chmod 755 /usr/local/bin/floating-frame-duckdns
  sudo tee /etc/systemd/system/floating-frame-duckdns.service >/dev/null <<'UNIT'
[Unit]
Description=Update DuckDNS with this server's public IP
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/floating-frame-duckdns
UNIT
  sudo tee /etc/systemd/system/floating-frame-duckdns.timer >/dev/null <<'UNIT'
[Unit]
Description=Keep DuckDNS pointing at this server (at boot and every 5 minutes)

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  sudo rm -f /run/floating-frame-duckdns.ip  # force an update now
  sudo systemctl daemon-reload
  sudo systemctl enable --now floating-frame-duckdns.timer >/dev/null
  if ! sudo systemctl start floating-frame-duckdns.service; then
    sudo journalctl -u floating-frame-duckdns -n 5 --no-pager || true
    echo "DuckDNS didn't accept the update - check the name and token, then run this script again."
    exit 1
  fi
  sudo journalctl -u floating-frame-duckdns -n 1 --no-pager -o cat 2>/dev/null || true
fi

say "Installing the app to $APP_DIR"
mkdir -p "$APP_DIR"
cp "$HERE/floating-frame.pyz" "$APP"

sudo tee /etc/systemd/system/floating-frame.service >/dev/null <<UNIT
[Unit]
Description=Floating Frame Calculator
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP_DIR
# Only reachable from this machine - Caddy is the public entry point.
Environment=FRAME_HOST=127.0.0.1
Environment=FRAME_PORT=$APP_PORT
# Everyone signs in; each account has its own private library.
Environment=FRAME_ACCOUNTS=1
Environment=PYTHONUNBUFFERED=1
ExecStart=$PYTHON $APP --no-browser
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable floating-frame >/dev/null
sudo systemctl restart floating-frame

if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  if [ "$PKG" = apt ]; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq caddy
  else
    # shellcheck disable=SC1091  # only exists on the server
    . /etc/os-release
    sudo dnf install -y -q 'dnf-command(copr)'
    sudo dnf copr enable -y @caddy/caddy "epel-${VERSION_ID%%.*}-$(uname -m)"
    sudo dnf install -y -q caddy
  fi
fi

say "Configuring Caddy for https://$DOMAIN"
if sudo test -f "$CADDYFILE" && [ "$MANAGED" = no ]; then
  sudo cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
  echo "Backed up the existing Caddyfile to $CADDYFILE.bak.*"
fi
if sudo grep -q basic_auth "$CADDYFILE" 2>/dev/null; then
  echo "Replacing the old Caddy password box with the app's own sign-in."
fi
sudo mkdir -p "$(dirname "$CADDYFILE")"
if [ -z "$BASE_PATH" ]; then
  sudo tee "$CADDYFILE" >/dev/null <<CADDY
$MARKER
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDY
else
  # The app lives under $BASE_PATH/; Caddy strips the prefix before passing requests on.
  sudo tee "$CADDYFILE" >/dev/null <<CADDY
$MARKER
$DOMAIN {
	encode gzip
	redir / $BASE_PATH/
	redir $BASE_PATH $BASE_PATH/
	handle_path $BASE_PATH/* {
		reverse_proxy 127.0.0.1:$APP_PORT
	}
	handle {
		respond "Not found" 404
	}
}
CADDY
fi
sudo chmod 640 "$CADDYFILE"
sudo chown root:caddy "$CADDYFILE" 2>/dev/null || true
if ! OUT="$(sudo caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
  echo "$OUT"; echo "Caddy rejected the new configuration (see above)."; exit 1
fi

say "Opening ports 80 and 443 in the server's firewall"
if command -v firewall-cmd >/dev/null && sudo firewall-cmd --state >/dev/null 2>&1; then
  sudo firewall-cmd --quiet --permanent --add-service=http --add-service=https
  sudo firewall-cmd --quiet --reload
elif command -v iptables >/dev/null; then
  # Oracle's Ubuntu images end the INPUT chain with a REJECT rule; insert above it.
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      POS="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
      if [ -n "$POS" ]; then sudo iptables -I INPUT "$POS" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      else sudo iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT; fi
    fi
  done
  if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1 || true
  elif [ -d /etc/iptables ]; then sudo sh -c 'iptables-save > /etc/iptables/rules.v4'; fi
fi

sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

# ---------------------------------------------------------------- first account & invite code
if [ "$UNATTENDED" = yes ]; then
  if app --list-users | grep -q '(none)'; then
    echo "Note: there are no accounts yet - run 'sh install-vps.sh' once without --update to create yours."
  fi
elif app --list-users | grep -q '(none)'; then
  say "Create your account"
  echo "The first account takes over any paintings already in $APP_DIR/data."
  while :; do
    printf 'Username: '
    read -r FIRST_USER || { echo; echo "No input - create one later with: sh install-vps.sh --add-user NAME"; break; }
    [ -n "$FIRST_USER" ] && app --create-user "$FIRST_USER" && break
  done
fi
if [ "$UNATTENDED" = no ] && app --show-invite-code | grep -q 'closed'; then
  printf '\nLet other people create their own accounts with an invite code? [Y/n] '
  read -r ANSWER || ANSWER=""
  case "$ANSWER" in
    [Nn]*) echo "Sign-up stays off. Turn it on later with: sh install-vps.sh --new-invite-code" ;;
    *) app --new-invite-code ;;
  esac
fi

cat <<DONE

Floating Frame Calculator is installed.

  Address:   https://$DOMAIN$BASE_PATH/
  Data:      $APP_DIR/data

$(app --list-users | sed 's/^/  /')

To invite someone, send them the address and the invite code. Manage accounts
with the options in: sh install-vps.sh --help

$(sudo test -f "$DUCK_ENV" && echo "DuckDNS keeps $(sudo sed -n 's/^DUCKDNS_DOMAIN=//p' "$DUCK_ENV").duckdns.org pointing here (at boot and every 5 minutes).
")
One more step in the Oracle Cloud console (only needed once):
  Networking > Virtual cloud networks > your VCN > Security Lists > Default
  > Add Ingress Rules: source 0.0.0.0/0, TCP, destination ports 80,443

If the address doesn't load, check:
  sudo journalctl -u caddy -n 50            (HTTPS)
  sudo journalctl -u floating-frame -n 50   (the app)
DONE
