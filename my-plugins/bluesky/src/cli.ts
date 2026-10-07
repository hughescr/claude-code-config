import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { SdkApi, SEARCH_SERVICE, type Api, withImageUrls } from './api';
import { DEFAULT_HANDLE, resolveCredentials, systemCredentialDeps, type CredentialDeps } from './credentials';
import { executeDelete, executePost, PartialWriteError, prepareDelete, preparePost, preview,
  readPost, requireConfirmation, type PostInput } from './tool';

export const HELP = `Bluesky public reads and confirmation-gated writes (Node 22+)
Usage: node scripts/bsky.mjs <command> [args] --json
  read <post-url|at-uri> [--depth N]        Post, parents, replies; depth 0–1000 (default 6)
  profile <handle|did>                    Public profile
  feed <handle|did> [--limit N]            Author feed; limit 1–100 (default 20)
  search <query> [--limit N]               Public search (two AppView hosts), then authenticated
  post --text T [--image PATH --alt ALT]... [--reply-to URL] [--quote URL]
  post --thread-file FILE [--reply-to URL] [--quote URL]
  delete <post-url|at-uri>
  --confirm CODE                         Execute only a matching preview (post/delete)
  --json                                 Machine-readable output (also the default)
  --help                                 Show this help

Thread JSON: ["first", "second"] or [{"text":"first","images":[{"path":"image.png","alt":"description"}]}].
Each entry must be at most 300 graphemes; no automatic splitting. Images require alt text.
Without --confirm, writes show a deterministic preview; no upload or mutation occurs.
Get explicit human approval of that preview before passing its confirmationCode.
Credentials: BSKY_HANDLE (default craig.rungie.com); BSKY_APP_PASSWORD, else op read BSKY_OP_REF.
Read commands require no credentials, except optional search fallback. See README for surface setup.
`;
export interface CliDeps {
  publicApi: Api;
  searchApi: Api;
  env: NodeJS.ProcessEnv;
  credentials: CredentialDeps;
  authenticate(handle: string, password: string): Promise<Api>;
  readText(path: string): Promise<string>;
}
export function defaultDeps(): CliDeps {
  const env = process.env;
  return {
    publicApi: new SdkApi(), searchApi: new SdkApi(SEARCH_SERVICE), env, credentials: systemCredentialDeps(env),
    async authenticate(handle, password) {
      const api = new SdkApi('https://bsky.social');
      await api.login(handle, password);
      return api;
    },
    readText: path => readFile(path, 'utf8'),
  };
}
function numberOption(value: string | undefined, fallback: number, min: number, max: number, flag: string) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
function threadInputs(value: unknown): PostInput[] {
  if (!Array.isArray(value)) throw new Error('Thread file must be a JSON array of strings or post objects.');
  return value.map(entry => {
    if (typeof entry === 'string') return { text: entry };
    if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' ||
      Object.keys(entry).some(k => !['text', 'images'].includes(k))) throw new Error('Invalid thread entry: expected {text, images?}.');
    if (entry.images !== undefined && (!Array.isArray(entry.images) || entry.images.some((image: unknown) => {
      if (!image || typeof image !== 'object') return true;
      const obj = image as Record<string, unknown>;
      return typeof obj.path !== 'string' || typeof obj.alt !== 'string' || Object.keys(obj).some(k => !['path', 'alt'].includes(k));
    }))) throw new Error('Invalid thread images: expected [{path, alt}].');
    return { text: entry.text, ...(entry.images !== undefined ? { images: entry.images } : {}) };
  });
}

export async function runCli(argv: string[], deps: CliDeps): Promise<unknown> {
  const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean' }, confirm: { type: 'string' },
    text: { type: 'string' }, image: { type: 'string', multiple: true }, alt: { type: 'string', multiple: true },
    'reply-to': { type: 'string' }, quote: { type: 'string' }, 'thread-file': { type: 'string' },
    limit: { type: 'string' }, depth: { type: 'string' },
  } });
  if (values.help || argv.length === 0) return HELP;
  const [command, input] = positionals;
  const allowed: Record<string, string[]> = {
    read: ['depth'], profile: [], feed: ['limit'], search: ['limit'],
    post: ['text', 'image', 'alt', 'reply-to', 'quote', 'thread-file', 'confirm'], delete: ['confirm'],
  };
  if (!command || !allowed[command]) throw new Error('Unknown command. Run --help.');
  for (const key of Object.keys(values)) {
    if (!['json', 'help', ...allowed[command]!].includes(key)) throw new Error(`--${key} is not supported by ${command}.`);
  }
  if (positionals.length !== (command === 'post' ? 1 : 2)) throw new Error(`${command} received missing or extra positional arguments. Run --help.`);
  const authenticate = async () => {
    const { handle, password } = await resolveCredentials(deps.env, deps.credentials);
    return deps.authenticate(handle, password);
  };
  switch (command) {
    case 'read': return readPost(input!, numberOption(values.depth, 6, 0, 1000, '--depth'), deps.publicApi);
    case 'profile': return deps.publicApi.profile(input!);
    case 'feed': return withImageUrls(await deps.publicApi.feed(input!, numberOption(values.limit, 20, 1, 100, '--limit')));
    case 'search': {
      const limit = numberOption(values.limit, 20, 1, 100, '--limit');
      for (const api of [deps.publicApi, deps.searchApi]) {
        try { return withImageUrls(await api.search(input!, limit)); }
        catch { /* Try the next unauthenticated host. */ }
      }
      // Only this read may fall back to authenticated access. No write retry loop.
      let api: Api;
      try { api = await authenticate(); }
      catch (error) {
        throw new Error(`Both public search hosts refused the query, and the authenticated fallback is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      return withImageUrls(await api.search(input!, limit));
    }
    case 'post': {
      let posts: PostInput[];
      if (values['thread-file'] !== undefined) {
        if (values.text !== undefined || values.image !== undefined || values.alt !== undefined) throw new Error('--thread-file cannot be combined with --text, --image, or --alt.');
        let data: unknown;
        try { data = JSON.parse(await deps.readText(values['thread-file'])); }
        catch { throw new Error('Could not read/parse the thread JSON file.'); }
        posts = threadInputs(data);
      } else {
        if (values.text === undefined) throw new Error('post requires --text or --thread-file.');
        const paths = values.image ?? [], alts = values.alt ?? [];
        if (paths.length !== alts.length) throw new Error('Every --image must have exactly one --alt, paired in argument order.');
        posts = [{ text: values.text, images: paths.map((path, i) => ({ path, alt: alts[i]! })) }];
      }
      const prepared = await preparePost({ posts, replyTo: values['reply-to'], quote: values.quote },
        deps.env.BSKY_HANDLE?.trim() || DEFAULT_HANDLE, deps.publicApi);
      if (values.confirm === undefined) return preview(prepared.plan);
      // Reject mismatches even before accessing op/login. Only approved payloads reach auth.
      requireConfirmation(prepared.plan, values.confirm);
      return executePost(prepared, values.confirm, await authenticate());
    }
    case 'delete': {
      const api = await authenticate();
      const plan = await prepareDelete(input!, api);
      return values.confirm === undefined ? preview(plan) : executeDelete(plan, values.confirm, api);
    }
  }
  throw new Error('Unknown command. Run --help.');
}

export async function main() {
  try {
    const result = await runCli(process.argv.slice(2), defaultDeps());
    process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // SDK XRPC errors carry request context. Do not dump them or credential-bearing objects.
    const result = error instanceof PartialWriteError ? error.toJSON() : {
      error: error instanceof Error && !('status' in error) ? error.message : 'Bluesky request failed. Check network access, the target, and service availability.',
    };
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  }
}
