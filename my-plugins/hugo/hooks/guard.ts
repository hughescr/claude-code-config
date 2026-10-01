// Pure guard logic for the hugo plugin's serverless-deploy block. No imports,
// no Node: a hooks module runs in a restricted environment (no eval, no
// dynamic import), so this is plain string and regex work.

export const HUGO_REASON =
  "BLOCKED: Manual serverless deploy is prohibited.\n\nDeployment workflow:\n1. Commit changes: git add . && git commit -m 'description'\n2. Push to trigger CI: git push origin develop\n3. Monitor GitHub Actions for deployment status\n\nThe CI pipeline handles Hugo build, S3 sync, and CloudFront invalidation automatically.";

// bash [[:space:]] under a UTF-8 locale (measured against /bin/bash 3.2 on
// macOS over U+0001..U+10FFFF): \t \n \v \f \r, space, NBSP, U+1680,
// U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. Not JS \s: that adds
// U+FEFF, which bash does not treat as space.
const SP = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

// The script ran bash [[ =~ ]] on the whole command: no word boundaries, no
// line split, case-sensitive, "deploy" may be a prefix of a longer word.
const RE_SERVERLESS = new RegExp(`serverless${SP}+deploy`, 'u');
const RE_SLS = new RegExp(`sls${SP}+deploy`, 'u');

// A high surrogate not followed by a low one. No u flag: this scans UTF-16
// code units. jq rejects such a command ("Invalid \uXXXX\uXXXX surrogate pair
// escape"), the script exits 0, and the call goes through. A lone LOW
// surrogate is accepted by jq, so it is deliberately not matched here.
const RE_LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// Mirrors what `command=$(echo "$input" | jq -r ...)` handed to bash: a shell
// variable cannot hold NUL, so bash drops it ("sls\0 deploy" is "sls deploy").
// A command jq cannot parse (lone high surrogate) yields '' (no opinion). The
// surrogate check runs on the raw string, before NUL stripping.
export function shellNormalize(raw: unknown): string {
  if (typeof raw !== 'string' || RE_LONE_HIGH.test(raw)) return '';
  return raw.replace(/\u0000/g, '');
}

/** The deny reason for a command the script blocked, else undefined. */
export function hugoGuard(raw: unknown): string | undefined {
  const cmd = shellNormalize(raw);
  return RE_SERVERLESS.test(cmd) || RE_SLS.test(cmd) ? HUGO_REASON : undefined;
}
