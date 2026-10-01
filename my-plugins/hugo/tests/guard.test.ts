import { test, expect } from 'claude-code/testing'
import { hugoGuard, HUGO_REASON } from '../hooks/guard'

// Golden corpus: expectations proven against the original
// block-serverless-deploy.sh (git HEAD) with the same inputs.
const CORPUS: ReadonlyArray<readonly [string, 'deny' | 'allow']> = [
  ['serverless deploy', 'deny'],
  ['sls deploy', 'deny'],
  ['npx serverless deploy --stage prod', 'deny'],
  ['sls deploy function -f x', 'deny'],
  ['serverless\ndeploy', 'deny'],
  ['sls\tdeploy', 'deny'],
  ['sls deploy', 'deny'],
  ['sls﻿deploy', 'allow'],
  ['serverless deployment', 'deny'],
  ['echo "sls deploy"', 'deny'],
  ['jsls deploy', 'deny'],
  ['sls package', 'allow'],
  ['slsdeploy', 'allow'],
  ['SLS deploy', 'allow'],
  ['cdk deploy', 'allow'],
  ['sls  --verbose deploy', 'allow'],
  ['', 'allow'],
  // Extra quirks, also checked against the script.
  ['sls\u0000 deploy', 'deny'],
  ['sls\u0085deploy', 'allow'],
  ['sls　deploy', 'deny'],
  ['sls​deploy', 'allow'],
  // jq rejects a lone high surrogate (script exits 0, allowing the call);
  // lone low surrogates and valid pairs parse fine. Checked against the script.
  ['\uD800sls deploy', 'allow'],
  ['sls deploy\uD800', 'allow'],
  ['\uD800 x sls deploy', 'allow'],
  ['\uD800\u0000sls deploy', 'allow'],
  ['\uDC00\uD800sls deploy', 'allow'],
  ['\uD800\uD800sls deploy', 'allow'],
  ['\uDC00sls deploy', 'deny'],
  ['sls deploy\uDC00', 'deny'],
  ['😀sls deploy', 'deny'],
  ['serverless deploy 😀', 'deny'],
]

test('golden corpus through the Bash tool.call path', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' as never }))
  for (const [command, expected] of CORPUS) {
    const r = await $.tool.call({ tool: 'Bash', command })
    if (expected === 'deny') {
      expect(r.deny).toBe(HUGO_REASON)
    } else {
      expect(r.deny).toBeUndefined()
    }
  }
})

test('malformed input passes through', () => {
  expect(hugoGuard(undefined)).toBeUndefined()
  expect(hugoGuard(null)).toBeUndefined()
  expect(hugoGuard(42)).toBeUndefined()
})

test('deny reason is the human message with real newlines', () => {
  expect(HUGO_REASON.startsWith('BLOCKED: Manual serverless deploy is prohibited.\n\n')).toBe(true)
  expect(HUGO_REASON.includes('\\n')).toBe(false)
})

test('1 MB adversarial inputs stay linear', () => {
  const inputs = [
    'sls' + ' '.repeat(1_000_000),
    'serverless' + ' '.repeat(1_000_000),
    ('sls' + ' '.repeat(100)).repeat(9_700),
  ]
  for (const input of inputs) {
    const t0 = performance.now()
    expect(hugoGuard(input)).toBeUndefined()
    expect(performance.now() - t0).toBeLessThan(250)
  }
})
