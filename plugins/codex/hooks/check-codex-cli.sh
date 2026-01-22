#!/usr/bin/env bash

# Check if codex alias is configured in the user's shell
# We check the config files directly to avoid spawning interactive shells
# (which can cause terminal crashes due to oh-my-zsh/iTerm2 interactions)

# Check 1: Is codex available as a command in PATH?
if command -v codex &>/dev/null; then
    exit 0
fi

# Check 2: Is the codex alias defined in zsh custom config?
if grep -q "alias codex=" ~/.zshd/*.zsh 2>/dev/null; then
    exit 0
fi

# Check 3: Is the codex alias defined in .zshrc or .bashrc?
if grep -q "alias codex=" ~/.zshrc ~/.bashrc 2>/dev/null; then
    exit 0
fi

echo "⚠️ Codex alias not found. Add this to your shell config (~/.zshrc or ~/.bashrc):"
echo "   alias codex='/opt/homebrew/bin/bunx @openai/codex --search'"

exit 0
