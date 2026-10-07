import { AtpAgent, type AppBskyFeedDefs, type AppBskyFeedPost, type BlobRef } from '@atproto/api';

export const PUBLIC_SERVICE = 'https://public.api.bsky.app';
// public.api.bsky.app refuses searchPosts (403 since at least 2026-10-07);
// api.bsky.app still answers it without a login.
export const SEARCH_SERVICE = 'https://api.bsky.app';
export interface Ref { uri: string; cid: string }
export interface Api {
  readonly did: string | undefined;
  resolveHandle(handle: string): Promise<string>;
  profile(actor: string): Promise<unknown>;
  feed(actor: string, limit: number): Promise<unknown>;
  search(q: string, limit: number): Promise<unknown>;
  thread(uri: string, depth: number): Promise<unknown>;
  getPost(uri: string): Promise<AppBskyFeedDefs.PostView>;
  getOwnRecord(uri: string): Promise<{ ref: Ref; value: unknown }>;
  upload(bytes: Uint8Array, mime: string): Promise<BlobRef>;
  create(record: AppBskyFeedPost.Record): Promise<Ref>;
  remove(ref: Ref): Promise<void>;
}

export class SdkApi implements Api {
  private readonly agent: AtpAgent;
  constructor(service = PUBLIC_SERVICE) { this.agent = new AtpAgent({ service }); }
  get did() { return this.agent.session?.did; }
  async login(handle: string, password: string) {
    // Do not print SDK errors here: an auth error must never echo credential input.
    try { await this.agent.login({ identifier: handle, password }); }
    catch { throw new Error('Bluesky login failed. Check the handle and app password; credentials were not logged.'); }
  }
  async resolveHandle(handle: string) {
    return (await this.agent.resolveHandle({ handle })).data.did;
  }
  async profile(actor: string) { return (await this.agent.getProfile({ actor })).data; }
  async feed(actor: string, limit: number) { return (await this.agent.getAuthorFeed({ actor, limit })).data; }
  async search(q: string, limit: number) { return (await this.agent.app.bsky.feed.searchPosts({ q, limit })).data; }
  async thread(uri: string, depth: number) {
    return (await this.agent.getPostThread({ uri, depth, parentHeight: 80 })).data;
  }
  async getPost(uri: string) {
    const post = (await this.agent.getPosts({ uris: [uri] })).data.posts[0];
    if (!post) throw new Error('Post not found or unavailable.');
    return post;
  }
  async getOwnRecord(uri: string) {
    const rkey = uri.slice(uri.lastIndexOf('/') + 1);
    const result = await this.agent.com.atproto.repo.getRecord({
      repo: this.agent.assertDid, collection: 'app.bsky.feed.post', rkey,
    });
    if (!result.data.cid) throw new Error('The post has no record CID.');
    return { ref: { uri: result.data.uri, cid: result.data.cid }, value: result.data.value };
  }
  async upload(bytes: Uint8Array, mime: string) {
    return (await this.agent.uploadBlob(bytes, { encoding: mime })).data.blob;
  }
  async create(record: AppBskyFeedPost.Record) {
    // Like Isambard's replyToPost, create exactly once. Never retry a write.
    const result = await this.agent.com.atproto.repo.createRecord({
      repo: this.agent.assertDid, collection: 'app.bsky.feed.post', record,
    });
    return { uri: result.data.uri, cid: result.data.cid };
  }
  async remove(ref: Ref) {
    await this.agent.com.atproto.repo.deleteRecord({
      repo: this.agent.assertDid, collection: 'app.bsky.feed.post',
      rkey: ref.uri.slice(ref.uri.lastIndexOf('/') + 1), swapRecord: ref.cid,
    });
  }
}

// Preserve all XRPC fields/embeds, adding a convenient {alt,url} for every image,
// including images inside quoted posts and record-with-media embeds.
export function withImageUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withImageUrls);
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, withImageUrls(v)]));
  if (typeof obj.alt === 'string' && typeof obj.fullsize === 'string') result.url = obj.fullsize;
  return result;
}
