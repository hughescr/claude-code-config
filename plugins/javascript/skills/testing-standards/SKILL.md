---
name: testing-standards
description: This skill should be used when the user mentions "write tests", "unit test", "fake timers", "mock timers", "test setTimeout", "test setInterval", "flaky tests", "test timing", "test concurrency", "mutation testing quality gate", "test quality", or any testing of JavaScript/TypeScript code. Provides mandatory standards for testing time-dependent code and mutation testing as a secondary quality gate.
---

# JavaScript/TypeScript Testing Standards

## Test Runner: Bun Test

All JavaScript/TypeScript testing uses `bun test` with its Jest-compatible API from `bun:test`.

```javascript
import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
```

## MANDATORY: Fake Timers for Time-Dependent Code

When writing or reviewing tests involving `setTimeout`, `setInterval`, `Date.now()`, or any time-dependent code, **always use fake timers**.

### Why Fake Timers Are Mandatory

- **Real timers are slow**: A 5-second timeout means 5 seconds of test time
- **Real timers are flaky**: Race conditions cause intermittent failures
- **Real timers are non-deterministic**: Results vary based on system load
- **Fake timers give control**: Advance time precisely and instantly

### Basic Setup Pattern

```javascript
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';

describe('Timer-dependent feature', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('delays execution', () => {
    const callback = jest.fn();
    setTimeout(callback, 1000);

    expect(callback).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalled();
  });
});
```

### Timer Control Methods

```javascript
// Advance time by specific milliseconds
jest.advanceTimersByTime(1000);

// Run all pending timers to completion
jest.runAllTimers();

// Run only currently scheduled timers (not new ones they create)
jest.runOnlyPendingTimers();

// Clear all pending timers without running them
jest.clearAllTimers();

// Set fake system time for Date.now() and new Date()
jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));
```

### Test Concurrency Warning

Fake timers are global state. They affect ALL code running in the process.

**Implications:**
- Tests using fake timers should not run in parallel with each other
- Always clean up in `afterEach` to prevent state leakage between tests
- Consider using `describe.sequential` for timer test suites

```javascript
// Force sequential execution for timer tests
describe.sequential('Timer-dependent features', () => {
  // These tests run one at a time, preventing timer conflicts
});
```

### Common Patterns

**Testing debounce:**
```javascript
test('debounces rapid calls', () => {
  const mockFn = jest.fn();
  const debounced = debounce(mockFn, 300);

  debounced('a');
  debounced('ab');
  debounced('abc');

  expect(mockFn).not.toHaveBeenCalled();
  jest.advanceTimersByTime(300);
  expect(mockFn).toHaveBeenCalledTimes(1);
  expect(mockFn).toHaveBeenCalledWith('abc');
});
```

**Testing setInterval:**
```javascript
test('calls at regular intervals', () => {
  const callback = jest.fn();
  setInterval(callback, 100);

  jest.advanceTimersByTime(350);
  expect(callback).toHaveBeenCalledTimes(3);
});
```

**Testing Date-dependent code:**
```javascript
test('formats current date', () => {
  jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

  const result = getFormattedDate();
  expect(result).toBe('January 15, 2024');
});
```

**Combining with DOM (happy-dom):**
```javascript
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { Window } from 'happy-dom';

describe('Auto-hiding notification', () => {
  let window;

  beforeEach(() => {
    jest.useFakeTimers();
    window = new Window();
    globalThis.document = window.document;
    globalThis.window = window;
  });

  afterEach(() => {
    jest.useRealTimers();
    window.close();
  });

  test('hides after delay', async () => {
    document.body.innerHTML = `<div id="msg" class="visible">Hello</div>`;

    const { initAutoHide } = await import('../../src/notification.js');
    initAutoHide();

    expect(document.querySelector('#msg').classList.contains('visible')).toBe(true);
    jest.advanceTimersByTime(3000);
    expect(document.querySelector('#msg').classList.contains('visible')).toBe(false);
  });
});
```

## Mutation Testing as Quality Gate

Mutation testing verifies that your tests actually catch bugs, not just execute code. A test suite can have 100% code coverage yet fail to detect real defects if assertions are weak or missing.

### When to Run

If the project has a `mutate` script in `package.json`, run `bun run mutate` after all tests pass. Mutation testing is a secondary quality gate — tests must pass first.

### What It Catches

- Tests that execute code but don't assert on results
- Assertions that are too loose (e.g., checking truthiness instead of exact values)
- Missing edge case coverage that lets mutants survive

### Stryker-Specific Patterns

For projects using Stryker, load the `stryker-mutation-testing` skill for comprehensive guidance on disable comments, NoCoverage patterns, survived mutant strategies, and incremental cache management.
