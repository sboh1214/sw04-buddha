#!/usr/bin/env bash
# Idempotent host configuration, run as root by the SSM deploy command BEFORE deploy.sh on every
# deploy. Everything that is not needed to reach this point lives here rather than in Terraform's
# user-data (which runs once and is ignore_changes'd), so host settings roll forward with git.
set -euo pipefail

COMPOSE_VERSION="${COMPOSE_VERSION:-v5.5.1}"
PLUGIN_DIR=/usr/local/lib/docker/cli-plugins
PLUGIN="$PLUGIN_DIR/docker-compose"

# --- docker daemon: rotated json logs, keep containers up across a dockerd restart -----------------
mkdir -p /etc/docker
DAEMON_JSON='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
if [ ! -f /etc/docker/daemon.json ] || [ "$(cat /etc/docker/daemon.json)" != "$DAEMON_JSON" ]; then
  printf '%s\n' "$DAEMON_JSON" >/etc/docker/daemon.json
  # A restart, not a reload: log-driver/log-opts are not among dockerd's SIGHUP-reloadable keys.
  # live-restore (already active from the previous config, or no containers yet on a fresh host)
  # keeps running containers up across the daemon restart.
  systemctl restart docker
fi

# --- compose plugin: AL2023 ships no package; pin a release and verify its checksum ----------------
if [ ! -x "$PLUGIN" ] || ! "$PLUGIN" version 2>/dev/null | grep -q "$COMPOSE_VERSION"; then
  mkdir -p "$PLUGIN_DIR"
  BASE="https://github.com/docker/compose/releases/download/$COMPOSE_VERSION"
  ASSET=docker-compose-linux-aarch64
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET"
  curl -fsSL "$BASE/$ASSET.sha256" -o "$TMP/$ASSET.sha256"
  (cd "$TMP" && sha256sum -c "$ASSET.sha256")
  install -m 0755 "$TMP/$ASSET" "$PLUGIN"
  rm -rf "$TMP"
fi
docker compose version

# --- unattended security updates (kernel updates still need a reboot; see terraform/README.md) ----
if ! rpm -q dnf-automatic >/dev/null 2>&1; then
  dnf install -y dnf-automatic
fi
sed -i -e 's/^upgrade_type = .*/upgrade_type = security/' \
  -e 's/^apply_updates = .*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic-install.timer

# --- sanity -----------------------------------------------------------------------------------------
systemctl is-active amazon-ssm-agent
findmnt -rno SOURCE,FSTYPE /data
swapon --show --noheadings || true
