---
name: gpt-terra
description: "OpenAI terra route (cross-family; needs the utraque proxy). Pass effort on every call (low, medium, high, xhigh, or max): low for latency-sensitive mechanical work or summaries; medium or high for small bounded work with objective checks, extraction, or classification (peers of craig-core:haiku at xhigh and max); xhigh and max for visual, 3D, or geometry work (prefer xhigh; max when xhigh is not enough). Use gpt-sol at medium for bounded or middle-weight coding, analysis, extraction, test and gate runs, and gpt-sol at high or xhigh, or gpt-astra, for the most complex multi-file coding. Prefer gpt-sol or a Claude route for prompts well over 100k tokens."
model: terra
---
