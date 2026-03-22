#!/bin/bash
# Setup script for cockpit relay on .221
# Run once from: ~/projects/claude-cockpit/relay
# Usage: bash deploy/setup.sh

set -e

PROJECT_DIR="$HOME/projects/claude-cockpit/relay"
DATA_DIR="/data/cockpit-relay"

echo "=== Setting up Cockpit Relay ==="

# Create data directory
sudo mkdir -p "$DATA_DIR"
sudo chown $USER:$USER "$DATA_DIR"

# Create virtual environment
cd "$PROJECT_DIR"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Build dashboard frontend
cd dashboard
npm install
npm run build
cd ..

# Copy .env if not exists
if [ ! -f .env ]; then
    cp .env.example .env
    # Generate random secret key
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/change-me-to-a-random-string/$SECRET/" .env
    echo "⚠️  Edit .env to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAILS"
fi

# Update DATA_DIR in .env
sed -i "s|DATA_DIR=.*|DATA_DIR=$DATA_DIR|" .env

# Install systemd service
sudo cp deploy/cockpit-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable cockpit-relay
sudo systemctl start cockpit-relay

echo ""
echo "=== Cockpit Relay is running on port 8430 ==="
echo ""
echo "Next steps:"
echo "  1. Add Caddyfile block for cockpit.boord-its.com"
echo "  2. Edit .env with Google OAuth credentials and admin emails"
echo "  3. Restart: sudo systemctl restart cockpit-relay"
echo ""
echo "Check status: sudo systemctl status cockpit-relay"
echo "View logs:    sudo journalctl -u cockpit-relay -f"
