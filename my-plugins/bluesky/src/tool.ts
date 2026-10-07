import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RichText, type AppBskyFeedPost, type AppBskyRichtextFacet } from '@atproto/api';
import { type Api, type Ref, withImageUrls } from './api';

export interface ImageInput { path: string; alt: string }
export interface PostInput { text: string; images?: ImageInput[] }
export interface PostOptions { posts: PostInput[]; replyTo?: string; quote?: string }
export interface ImagePlan extends ImageInput { mime: string; size: number; sha256: string }
interface PlannedPost {
  text: string;
  facets: AppBskyRichtextFacet.Main[];
  images: ImagePlan[];
  reply?: { root: Ref; parent: Ref };
  quote?: Ref;
}
export interface PostPlan { action: 'post'; actor: string; posts: PlannedPost[] }
export interface DeletePlan { action: 'delete'; actor: string; ref: Ref; record: unknown }
export type Plan = PostPlan | DeletePlan;
export interface PreparedPost { plan: PostPlan; imageBytes: Uint8Array[][] }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}
export function confirmationCode(plan: Plan): string {
  return createHash('sha256').update(canonical(plan)).digest('hex').slice(0, 16);
}
export function preview(plan: Plan) { return { ...plan, confirmationCode: confirmationCode(plan) }; }
export function requireConfirmation(plan: Plan, code: string) {
  if (code !== confirmationCode(plan)) throw new Error('Confirmation code does not match the current payload. Preview it again and obtain approval; nothing was written.');
}

export async function actorDid(actor: string, api: Api): Promise<string> {
  if (/^did:(plc:[a-z2-7]+|web:[A-Za-z0-9._:%-]+)$/.test(actor)) return actor;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z][A-Za-z0-9.-]*$/.test(actor)) {
    throw new Error('Expected a Bluesky handle or DID.');
  }
  return api.resolveHandle(actor.toLowerCase());
}
export async function postUri(input: string, api: Api): Promise<string> {
  let actor: string, key: string;
  if (input.startsWith('at://')) {
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]{1,512})$/.exec(input);
    if (!match) throw new Error('Expected an at:// post URI (app.bsky.feed.post).');
    actor = match[1]!; key = match[2]!;
  } else {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('Expected a bsky.app post URL or at:// post URI.'); }
    const match = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~:-]{1,512})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'bsky.app' || url.port || url.username || url.password || !match) {
      throw new Error('Expected https://bsky.app/profile/HANDLE/post/KEY.');
    }
    actor = decodeURIComponent(match[1]!); key = match[2]!;
  }
  return `at://${await actorDid(actor, api)}/app.bsky.feed.post/${key}`;
}

function imageMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Image must be PNG, JPEG, or WebP (checked by file signature).');
}
export async function loadImage(image: ImageInput, read: (path: string) => Promise<Uint8Array> = readFile): Promise<{ plan: ImagePlan; bytes: Uint8Array }> {
  if (typeof image.path !== 'string' || !image.path || typeof image.alt !== 'string' || !image.alt.trim()) {
    throw new Error('Every image requires a path and non-empty alt text.');
  }
  // Resolve once and capture bytes before hashing; execution never re-reads the file.
  const path = resolve(image.path);
  const bytes = await read(path);
  if (bytes.length > 1_000_000) throw new Error('Image exceeds the 1 MB upload limit. Resize it before previewing.');
  const mime = imageMime(bytes);
  return { plan: { path, alt: image.alt, mime, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }, bytes };
}

export async function preparePost(options: PostOptions, actor: string, api: Api,
  readImage: typeof loadImage = loadImage): Promise<PreparedPost> {
  if (!options.posts.length || options.posts.length > 100) throw new Error('A thread must contain 1–100 posts.');
  const texts = options.posts.map(input => {
    if (typeof input.text !== 'string') throw new Error('Every thread entry requires string text.');
    const rt = new RichText({ text: input.text });
    // Reuse Isambard's RichText grapheme validation and SDK facet detection.
    if (rt.graphemeLength > 300) throw new Error(`Post exceeds 300 graphemes (${rt.graphemeLength}). Split it explicitly with --thread-file.`);
    if (!input.text.trim() && !input.images?.length) throw new Error('A post must contain text or images.');
    if ((input.images?.length ?? 0) > 4) throw new Error('A post may contain at most four images.');
    if (input.images?.some(i => typeof i.path !== 'string' || !i.path || typeof i.alt !== 'string' || !i.alt.trim())) {
      throw new Error('Every image requires a path and non-empty alt text.');
    }
    rt.detectFacetsWithoutResolution();
    return rt;
  });
  // Resolve unique mentions across the whole thread concurrently, not once per post.
  // SDK detectFacets normally resolves these itself but can silently keep empty DIDs;
  // this boundary fails closed instead and shares lookups across all thread entries.
  const mentions = new Set<string>();
  for (const rt of texts) for (const facet of rt.facets ?? []) for (const f of facet.features) {
    if (f.$type === 'app.bsky.richtext.facet#mention' && 'did' in f) mentions.add(String(f.did));
  }
  const didMap = new Map(await Promise.all([...mentions].map(async handle => [handle, await actorDid(handle, api)] as const)));
  for (const rt of texts) for (const facet of rt.facets ?? []) for (const f of facet.features) {
    if (f.$type === 'app.bsky.richtext.facet#mention' && 'did' in f) f.did = didMap.get(String(f.did))!;
  }
  const [did, replyPost, quotePost, images] = await Promise.all([
    actorDid(actor, api),
    options.replyTo ? postUri(options.replyTo, api).then(uri => api.getPost(uri)) : undefined,
    options.quote ? postUri(options.quote, api).then(uri => api.getPost(uri)) : undefined,
    Promise.all(options.posts.map(p => Promise.all((p.images ?? []).map(i => readImage(i))))),
  ]);
  const reply = replyPost ? { parent: { uri: replyPost.uri, cid: replyPost.cid },
    root: (replyPost.record as AppBskyFeedPost.Record).reply?.root ?? { uri: replyPost.uri, cid: replyPost.cid } } : undefined;
  const firstRef = { uri: '$thread:1', cid: '$thread:1' };
  const posts = texts.map((rt, index): PlannedPost => ({
    text: rt.text, facets: rt.facets ?? [], images: images[index]!.map(i => i.plan),
    ...(index === 0 ? (reply ? { reply } : {}) : { reply: {
      root: reply?.root ?? firstRef,
      parent: { uri: `$thread:${index}`, cid: `$thread:${index}` },
    } }),
    ...(index === 0 && quotePost ? { quote: { uri: quotePost.uri, cid: quotePost.cid } } : {}),
  }));
  return { plan: { action: 'post', actor: did, posts }, imageBytes: images.map(p => p.map(i => i.bytes)) };
}

export class PartialWriteError extends Error {
  constructor(readonly succeeded: Ref[], readonly failedIndex: number, readonly uncertain: boolean) {
    super('Write failed. Do not retry blindly: inspect the account feed/repository before deciding what to do next.');
  }
  toJSON() { return { error: this.message, succeeded: this.succeeded, failedIndex: this.failedIndex, uncertain: this.uncertain }; }
}
function materialize(ref: Ref, succeeded: Ref[]): Ref {
  if (!ref.uri.startsWith('$thread:')) return ref;
  const found = succeeded[Number(ref.uri.slice(8)) - 1];
  if (!found) throw new Error('Unresolved thread reference.');
  return found;
}
export async function executePost(prepared: PreparedPost, code: string, api: Api,
  now = () => new Date().toISOString()): Promise<{ action: 'post'; succeeded: Ref[] }> {
  requireConfirmation(prepared.plan, code);
  if (api.did !== prepared.plan.actor) throw new Error('The authenticated account does not match the preview actor; nothing was written.');
  const succeeded: Ref[] = [];
  // Sequential by design: each next post depends on the previous strong reference.
  for (const [index, post] of prepared.plan.posts.entries()) {
    let attemptedRecord = false;
    try {
      const images = await Promise.all(post.images.map(async (image, i) => ({
        alt: image.alt, image: await api.upload(prepared.imageBytes[index]![i]!, image.mime),
      })));
      const media = images.length ? { $type: 'app.bsky.embed.images' as const, images } : undefined;
      const quote = post.quote ? { $type: 'app.bsky.embed.record' as const, record: post.quote } : undefined;
      const embed = media && quote ? { $type: 'app.bsky.embed.recordWithMedia' as const, media, record: quote } : media ?? quote;
      const record: AppBskyFeedPost.Record = {
        $type: 'app.bsky.feed.post', text: post.text, facets: post.facets, createdAt: now(),
        ...(embed ? { embed } : {}),
        ...(post.reply ? { reply: { root: materialize(post.reply.root, succeeded), parent: materialize(post.reply.parent, succeeded) } } : {}),
      };
      attemptedRecord = true;
      succeeded.push(await api.create(record));
    } catch { throw new PartialWriteError([...succeeded], index + 1, attemptedRecord); }
  }
  return { action: 'post', succeeded };
}

export async function prepareDelete(input: string, api: Api): Promise<DeletePlan> {
  if (!api.did) throw new Error('Deletion requires authentication.');
  const uri = await postUri(input, api);
  if (uri.split('/')[2] !== api.did) throw new Error('Refusing to delete a post owned by another account.');
  const { ref, value } = await api.getOwnRecord(uri);
  if (ref.uri !== uri) throw new Error('Repository returned an unexpected post URI.');
  return { action: 'delete', actor: api.did, ref, record: value };
}
export async function executeDelete(plan: DeletePlan, code: string, api: Api) {
  requireConfirmation(plan, code);
  if (api.did !== plan.actor || plan.ref.uri.split('/')[2] !== api.did) throw new Error('Refusing to delete a post owned by another account.');
  try { await api.remove(plan.ref); }
  catch { throw new Error('Deletion failed; outcome may be uncertain. Inspect the repository before retrying.'); }
  return { action: 'delete', deleted: plan.ref.uri };
}

export async function readPost(input: string, depth: number, api: Api) {
  const data = await api.thread(await postUri(input, api), depth);
  const thread = (data as { thread?: { post?: unknown } }).thread;
  return withImageUrls({ ...data as object, post: thread?.post });
}
