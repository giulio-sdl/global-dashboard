#!/bin/zsh
# Starts the dashboard server if it is not already running, then opens the
# dashboard in the default browser. The scheduled job runs this every weekday
# morning (see README). Pass --no-open to start the server without a browser.

DIR="${0:A:h:h}" # the project folder, one level above scripts/
PORT="${PORT:-5177}"
URL="http://localhost:$PORT"
LOG="$HOME/Library/Logs/global-dashboard.log"

# A scheduled job gets a bare PATH; Homebrew's Node is not on it.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

running() { /usr/bin/curl -s -o /dev/null --max-time 2 "$URL/api/config"; }

if ! running; then
  cd "$DIR" || exit 1
  PORT="$PORT" nohup node server.js >> "$LOG" 2>&1 &
  disown
  # Give the server up to 15 seconds to come up before opening the page.
  for attempt in {1..30}; do
    running && break
    sleep 0.5
  done
fi

if ! running; then
  echo "$(date): dashboard server did not start; see $LOG" >> "$LOG"
  exit 1
fi

[[ "$1" == "--no-open" ]] || /usr/bin/open "$URL"
