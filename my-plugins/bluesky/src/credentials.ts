import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

export const DEFAULT_HANDLE = 'craig.rungie.com';
export const DEFAULT_OP_REF = 'op://Private/ev3yijxphjzfz6lm5ziuqaj5c4/App Passwords/claude-posting-key';
export const CREDENTIAL_HELP = 'Set BSKY_APP_PASSWORD to a Bluesky app password (not your main password). Local CLI: export it in your shell, or install/sign in to 1Password op. Cloud Code: claude.ai/code → environment settings → Environment variables; use a private environment (others using it can read these values). Network-header secrets cannot supply the createSession JSON password. Cowork arbitrary env vars and node/op availability are unverified: use a supported connector or configure the runtime through its documented secret mechanism. Do not paste secrets into committed files, command arguments, or logs. Chat without a runtime is read-only.';

export interface CredentialDeps {
  hasOp(): Promise<boolean>;
  readOp(ref: string): Promise<string>;
}
const run = promisify(execFile);
export function systemCredentialDeps(env: NodeJS.ProcessEnv): CredentialDeps {
  let opPath: string | undefined;
  return {
    async hasOp() {
      for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, 'op');
        try { await access(candidate, constants.X_OK); opPath = candidate; return true; }
        catch { /* Try the next PATH entry, never a shell command. */ }
      }
      return false;
    },
    async readOp(ref) {
      if (!opPath) throw new Error('op is unavailable.');
      const { stdout } = await run(opPath, ['read', ref], { env, timeout: 30_000, maxBuffer: 16_384 });
      return stdout;
    },
  };
}

export async function resolveCredentials(env: NodeJS.ProcessEnv, deps: CredentialDeps) {
  const handle = env.BSKY_HANDLE?.trim() || DEFAULT_HANDLE;
  if (env.BSKY_APP_PASSWORD?.trim()) return { handle, password: env.BSKY_APP_PASSWORD.trim() };
  if (await deps.hasOp()) {
    try {
      const password = (await deps.readOp(env.BSKY_OP_REF || DEFAULT_OP_REF)).trim();
      if (password) return { handle, password };
    } catch { /* Never propagate op stderr, which can contain secret material. */ }
    throw new Error(`Could not read the Bluesky app password from op. ${CREDENTIAL_HELP}`);
  }
  throw new Error(`No Bluesky app password available. ${CREDENTIAL_HELP}`);
}
