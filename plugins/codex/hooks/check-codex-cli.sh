#!/usr/bin/env bash

# Check if codex alias is defined
if ! type codex &> /dev/null; then
    echo "⚠️ Codex alias not found. Add this to your shell config (~/.zshrc or ~/.bashrc):"
    echo "   alias codex='/opt/homebrew/bin/bunx @openai/codex --search'"
fi

# Always exit 0 to avoid blocking the session
exit 0
