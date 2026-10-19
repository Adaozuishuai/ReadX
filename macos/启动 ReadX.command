#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ ! -x .retain-runtime/bin/python3 ]]; then npm run setup:runtime; fi
exec npm start
