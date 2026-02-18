#!/usr/bin/env bash
# Claude Code Notification hook -> ntfy
# Reads notification JSON from stdin

data=$(cat)
msg=$(printf '%s' "$data" | jq -r '.message // empty')
[ -z "$msg" ] && exit 0

notification_type=$(printf '%s' "$data" | jq -r '.notification_type // empty')
title=$(printf '%s' "$data" | jq -r '.title // empty')

case "$notification_type" in
  permission_prompt)
    title="${title:-Permission needed}"
    priority="high"
    type_tag="lock"
    ;;
  elicitation_dialog)
    title="${title:-Input needed}"
    priority="high"
    type_tag="speech_balloon"
    ;;
  idle_prompt)
    title="${title:-Idle}"
    priority="low"
    type_tag="zzz"
    ;;
  *)
    exit 0
    ;;
esac

ntfy publish \
  --priority "$priority" \
  --title "Claude Code: $title" \
  --tag robot \
  --tag "$type_tag" \
  0oaXqomqjk3J5950 \
  "$msg"
