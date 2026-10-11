#!/bin/bash
# Caption Studio — double-click me to start the app.
# (If macOS says the file cannot be opened, run once in Terminal:
#   chmod +x CaptionStudio.command  )

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "Python 3 is required" message "Install Python 3 from https://www.python.org/downloads/ and then double-click CaptionStudio.command again." as critical' 2>/dev/null
  exit 1
fi

exec python3 run.py
