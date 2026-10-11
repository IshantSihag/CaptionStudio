#!/bin/bash
# Builds a native macOS app:  dist/Caption Studio.app
# Run this ON THE MAC:   ./build_app.sh
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required: https://www.python.org/downloads/"
  exit 1
fi

echo "==> Installing PyInstaller…"
python3 -m pip install --user --upgrade pyinstaller

echo "==> Building the app (this takes a minute)…"
python3 -m PyInstaller \
  --noconfirm \
  --windowed \
  --name "Caption Studio" \
  --add-data "static:static" \
  run.py

echo ""
echo "==> Done! Find it in:  $(pwd)/dist/Caption Studio.app"
echo "    First time: right-click the app -> Open (macOS security prompt)."
open dist 2>/dev/null || true
