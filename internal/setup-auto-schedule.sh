#!/usr/bin/env bash
###############################################################################
# setup-auto-schedule.sh
#
# Sets up auto start/stop for the ArcGIS Server EC2 instance:
#   - Shutdown at 6pm ET via crontab on the instance
#   - Startup at 8am ET via launchd on your Mac
#
# Usage:
#   ./setup-auto-schedule.sh <INSTANCE_ID> <INSTANCE_IP>
#
# Example:
#   ./setup-auto-schedule.sh i-0abc123def456 54.123.45.67
###############################################################################
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
hdr()  { echo -e "\n${CYAN}${BOLD}========== $* ==========${NC}\n"; }

if [[ $# -lt 2 ]]; then
    err "Usage: $0 <INSTANCE_ID> <INSTANCE_IP>"
    exit 1
fi

INSTANCE_ID="$1"
IP="$2"
SSH_KEY="$HOME/.ssh/AnandTrivediRSAPEM.pem"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
AWS_REGION="us-east-1"
AWS_PROFILE="default"

###############################################################################
# 1. Auto-shutdown: crontab on the EC2 instance
###############################################################################
hdr "Setting up auto-shutdown at 6pm ET on EC2"

info "Adding cron job for auto-shutdown..."
ssh $SSH_OPTS "ubuntu@${IP}" 'bash -s' << 'EOF'
# Set timezone to Eastern
sudo timedatectl set-timezone America/New_York 2>/dev/null || true

# Create shutdown script
sudo tee /opt/arcgis/auto-shutdown.sh > /dev/null << 'SCRIPT'
#!/bin/bash
# Auto-shutdown at 6pm ET
# Stops ArcGIS Server gracefully first, then shuts down the instance
logger "Auto-shutdown: Stopping ArcGIS Server..."
sudo -u arcgis /opt/arcgis/server/stopserver.sh 2>/dev/null || true
sleep 10
logger "Auto-shutdown: Shutting down instance..."
/usr/sbin/shutdown -h now
SCRIPT
sudo chmod +x /opt/arcgis/auto-shutdown.sh

# Add to root's crontab (6pm ET = 18:00 in America/New_York)
# CRON_TZ sets the timezone for this cron entry
(sudo crontab -l 2>/dev/null | grep -v 'auto-shutdown' || true; \
 echo "CRON_TZ=America/New_York"; \
 echo "0 18 * * * /opt/arcgis/auto-shutdown.sh >> /var/log/auto-shutdown.log 2>&1") \
 | sudo crontab -

echo "Crontab set:"
sudo crontab -l
EOF
ok "Auto-shutdown cron job installed (6pm ET daily)"

###############################################################################
# 2. Auto-startup: launchd on Mac
###############################################################################
hdr "Setting up auto-startup at 8am ET on Mac"

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_NAME="com.arcgis.ec2-autostart"
PLIST_PATH="${PLIST_DIR}/${PLIST_NAME}.plist"
START_SCRIPT="$HOME/.local/bin/arcgis-ec2-start.sh"

info "Creating start script at ${START_SCRIPT}..."
mkdir -p "$(dirname "$START_SCRIPT")"
cat > "$START_SCRIPT" << STARTEOF
#!/bin/bash
# Auto-start ArcGIS Server EC2 instance
# Runs at 8am ET via launchd

INSTANCE_ID="${INSTANCE_ID}"
REGION="${AWS_REGION}"
PROFILE="${AWS_PROFILE}"
LOG_FILE="\$HOME/.local/log/arcgis-ec2-start.log"
mkdir -p "\$(dirname "\$LOG_FILE")"

echo "\$(date): Checking instance state..." >> "\$LOG_FILE"

# Check if instance is stopped
STATE=\$(aws ec2 describe-instances --instance-ids "\$INSTANCE_ID" --region "\$REGION" --profile "\$PROFILE" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>> "\$LOG_FILE")

if [[ "\$STATE" == "stopped" ]]; then
    echo "\$(date): Instance is stopped, starting..." >> "\$LOG_FILE"
    aws ec2 start-instances --instance-ids "\$INSTANCE_ID" --region "\$REGION" --profile "\$PROFILE" >> "\$LOG_FILE" 2>&1
    echo "\$(date): Start command sent" >> "\$LOG_FILE"

    # Wait for running state
    aws ec2 wait instance-running --instance-ids "\$INSTANCE_ID" --region "\$REGION" --profile "\$PROFILE" >> "\$LOG_FILE" 2>&1
    echo "\$(date): Instance is running" >> "\$LOG_FILE"
elif [[ "\$STATE" == "running" ]]; then
    echo "\$(date): Instance already running, skipping" >> "\$LOG_FILE"
else
    echo "\$(date): Instance in state '\$STATE', skipping" >> "\$LOG_FILE"
fi
STARTEOF
chmod +x "$START_SCRIPT"
ok "Start script created"

info "Creating launchd plist at ${PLIST_PATH}..."
mkdir -p "$PLIST_DIR"
cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${START_SCRIPT}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${HOME}/.local/log/arcgis-ec2-start-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.local/log/arcgis-ec2-start-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
PLISTEOF
ok "Launchd plist created"

info "Loading launchd job..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
ok "Launchd job loaded"

###############################################################################
# Summary
###############################################################################
hdr "SCHEDULE CONFIGURED"

echo -e "  ${BOLD}Instance:${NC}     ${INSTANCE_ID} (${IP})"
echo -e "  ${BOLD}Auto-stop:${NC}    6:00 PM ET daily (crontab on EC2)"
echo -e "  ${BOLD}Auto-start:${NC}   8:00 AM ET daily (launchd on this Mac)"
echo ""
echo -e "  ${YELLOW}Note:${NC} The auto-start launchd job requires:"
echo "    - This Mac to be awake/on at 8am"
echo "    - AWS SSO session to be valid (refresh with: aws sso login --profile default)"
echo ""
echo "  Manual control:"
echo "    Start:  aws ec2 start-instances --instance-ids ${INSTANCE_ID} --region ${AWS_REGION} --profile ${AWS_PROFILE}"
echo "    Stop:   aws ec2 stop-instances --instance-ids ${INSTANCE_ID} --region ${AWS_REGION} --profile ${AWS_PROFILE}"
echo ""
ok "Done!"
