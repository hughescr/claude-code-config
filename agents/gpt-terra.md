---
name: gpt-terra
description: "OpenAI terra route (cross-family; needs the utraque proxy). Pass effort on every call (low, medium, high, xhigh, or max): low for latency-sensitive mechanical work or summaries; medium or high for small bounded work with objective checks, extraction, or classification (peers of craig-core:haiku at xhigh and max); xhigh for bounded or middle-weight coding, analysis, extraction, test and gate runs, and visual or 3D work, as a cheaper, faster peer of gpt-sol at medium; max for visual, 3D, or geometry work that needs more than xhigh. Use gpt-sol at high or xhigh, or gpt-astra, for the most complex multi-file coding. Prefer gpt-sol or a Claude route for prompts well over 100k tokens."
model: terra
---
