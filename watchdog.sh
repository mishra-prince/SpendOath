#!/bin/bash
# SpendOath keep-alive watchdog: restarts API (4000), preview (4173), tunnel if dead.
API_OK=0; PREVIEW_OK=0; TUNNEL_OK=0
while true; do
  curl -s -m 4 http://localhost:4000/api/health > /dev/null 2>&1 || API_OK=1
  curl -s -m 4 -o /dev/null http://localhost:4173 2>/dev/null || PREVIEW_OK=1

  if [ "$API_OK" = "1" ]; then
    pkill -f "tsx src/index" 2>/dev/null; sleep 1
    (cd /opt/data/SpendOath/server && nohup npx tsx src/index.ts >> /opt/data/pp-api.log 2>&1 &)
    echo "$(date -Is) restarted API" >> /opt/data/pp-watchdog.log
  fi

  if [ "$PREVIEW_OK" = "1" ]; then
    pkill -f "vite preview" 2>/dev/null; sleep 1
    (cd /opt/data/SpendOath/web && nohup npm run preview >> /opt/data/pp-preview.log 2>&1 &)
    echo "$(date -Is) restarted preview" >> /opt/data/pp-watchdog.log
  fi

  # tunnel: check the log for a URL and that the process is alive
  if ! pgrep -f "cloudflared tunnel --url http://localhost:4173" > /dev/null 2>&1; then
    pkill -f "cloudflared tunnel --url http://localhost:4173" 2>/dev/null; sleep 1
    (nohup /opt/data/cloudflared tunnel --url http://localhost:4173 --no-autoupdate > /opt/data/pp-tunnel3.log 2>&1 &)
    echo "$(date -Is) restarted tunnel" >> /opt/data/pp-watchdog.log
  fi

  API_OK=0; PREVIEW_OK=0
  sleep 30
done
