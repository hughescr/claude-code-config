import { describe, expect, test } from 'bun:test';
import type { AppBskyFeedDefs, AppBskyFeedPost, BlobRef } from '@atproto/api';
import type { Api, Ref } from '../src/api';
import { withImageUrls } from '../src/api';
import { runCli, type CliDeps } from '../src/cli';
import { CREDENTIAL_HELP, DEFAULT_OP_REF, resolveCredentials, type CredentialDeps } from '../src/credentials';
import { confirmationCode, executeDelete, executePost, loadImage, PartialWriteError,
  postUri, prepareDelete, preparePost, preview } from '../src/tool';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const URI = `at://${DID}/app.bsky.feed.post/abc`;
const REF = { uri: URI, cid: 'cid-original' };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function view(uri = URI): AppBskyFeedDefs.PostView {
  return { uri, cid: REF.cid, author: { did: uri.split('/')[2]!, handle: 'craig.rungie.com' },
    record: { $type: 'app.bsky.feed.post', text: 'Original', createdAt: '2026-10-07T00:00:00Z' }, indexedAt: '2026-10-07T00:00:00Z' };
}
function fakeApi(did: string | undefined = DID) {
  const created: AppBskyFeedPost.Record[] = [], removed: Ref[] = [], uploads: Uint8Array[] = [];
  const handles: string[] = [];
  const api: Api = {
    did,
    async resolveHandle(handle) { handles.push(handle); return handle === 'other.test' ? OTHER : DID; },
    async profile(actor) { return { did: DID, handle: actor }; },
    async feed() { return { feed: [] }; },
    async search() { return { posts: [] }; },
    async thread(uri) { return { thread: { post: view(uri), parent: { post: view() }, replies: [] } }; },
    async getPost(uri) { return view(uri); },
    async getOwnRecord(uri) { return { ref: { ...REF, uri }, value: view(uri).record }; },
    async upload(bytes) { uploads.push(bytes); return {} as BlobRef; },
    async create(record) { created.push(record); return { uri: `at://${DID}/app.bsky.feed.post/${created.length}`, cid: `cid-${created.length}` }; },
    async remove(ref) { removed.push(ref); },
  };
  return { api, created, removed, uploads, handles };
}
function fakeCli() {
  const fixture = fakeApi(), search = fakeApi();
  let authCalls = 0, opCalls = 0;
  const deps: CliDeps = {
    publicApi: fixture.api, searchApi: search.api, env: { BSKY_APP_PASSWORD: 'fake-only' },
    credentials: { async hasOp() { opCalls++; throw new Error('Must not use real op.'); }, async readOp() { throw new Error('Must not use real op.'); } },
    async authenticate() { authCalls++; return fixture.api; },
    async readText() { return '["first","second"]'; },
  };
  return { ...fixture, search, deps, authCalls: () => authCalls, opCalls: () => opCalls };
}
const fakeImage: typeof loadImage = async input => ({
  bytes: PNG, plan: { ...input, mime: 'image/png', size: PNG.length, sha256: 'image-hash' },
});

describe('credentials: only injected fakes, never real op', () => {
  test('environment wins without even probing op', async () => {
    const deps: CredentialDeps = { async hasOp() { throw new Error('Unexpected probe'); }, async readOp() { throw new Error('Unexpected read'); } };
    expect(await resolveCredentials({ BSKY_APP_PASSWORD: 'from-env' }, deps)).toEqual({ handle: 'craig.rungie.com', password: 'from-env' });
  });
  test('op follows env and uses default reference', async () => {
    const seen: string[] = [];
    const result = await resolveCredentials({ BSKY_HANDLE: 'other.test' }, {
      async hasOp() { return true; }, async readOp(ref) { seen.push(ref); return 'from-fake-op\n'; },
    });
    expect(seen).toEqual([DEFAULT_OP_REF]);
    expect(result).toEqual({ handle: 'other.test', password: 'from-fake-op' });
  });
  test('custom reference and missing credential error', async () => {
    expect(await resolveCredentials({ BSKY_OP_REF: 'op://test/item/password' }, {
      async hasOp() { return true; }, async readOp(ref) { expect(ref).toBe('op://test/item/password'); return 'fake'; },
    })).toHaveProperty('password', 'fake');
    await expect(resolveCredentials({}, { async hasOp() { return false; }, async readOp() { throw new Error('Not called'); } })).rejects.toThrow(CREDENTIAL_HELP);
  });
  test('op errors/empty output never expose stderr or secret', async () => {
    for (const readOp of [async () => { throw new Error('SECRET_STDERR'); }, async () => '   ']) {
      try { await resolveCredentials({}, { async hasOp() { return true; }, readOp }); throw new Error('Expected refusal'); }
      catch (error) { expect(String(error)).not.toContain('SECRET_STDERR'); expect(String(error)).toContain('Could not read'); }
    }
  });
});

describe('post previews and confirmation', () => {
  test('preview performs no authentication, upload, post or op', async () => {
    const f = fakeCli();
    const result = await runCli(['post', '--text', 'hello', '--json'], f.deps) as { confirmationCode: string; posts: {text: string}[] };
    expect(result.posts[0]!.text).toBe('hello');
    expect(result.confirmationCode).toMatch(/^[a-f0-9]{16}$/);
    expect([f.authCalls(), f.opCalls(), f.created.length, f.uploads.length]).toEqual([0, 0, 0, 0]);
  });
  test('confirm exact preview succeeds; changed text or bad code refuses before auth', async () => {
    const f = fakeCli();
    const draft = await runCli(['post', '--text', 'hello'], f.deps) as { confirmationCode: string };
    await expect(runCli(['post', '--text', 'changed', '--confirm', draft.confirmationCode], f.deps)).rejects.toThrow('does not match');
    await expect(runCli(['post', '--text', 'hello', '--confirm', 'wrong'], f.deps)).rejects.toThrow('does not match');
    expect(f.authCalls()).toBe(0);
    await runCli(['post', '--text', 'hello', '--confirm', draft.confirmationCode], f.deps);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]!.text).toBe('hello');
  });
  test('canonical hash ignores object key order, but binds actor and all payload fields', async () => {
    const f = fakeApi();
    const p = await preparePost({ posts: [{ text: 'hello', images: [{ path: 'image.png', alt: 'An image' }] }] }, DID, f.api, fakeImage);
    expect(confirmationCode(p.plan)).toBe(confirmationCode({ posts: p.plan.posts, actor: p.plan.actor, action: 'post' }));
    const code = confirmationCode(p.plan);
    for (const plan of [
      { ...p.plan, actor: OTHER },
      { ...p.plan, posts: [{ ...p.plan.posts[0]!, images: [{ ...p.plan.posts[0]!.images[0]!, alt: 'Changed' }] }] },
      { ...p.plan, posts: [{ ...p.plan.posts[0]!, images: [{ ...p.plan.posts[0]!.images[0]!, sha256: 'changed-bytes' }] }] },
    ]) expect(confirmationCode(plan)).not.toBe(code);
    await expect(executePost(p, code, fakeApi(OTHER).api)).rejects.toThrow('account does not match');
  });
  test('images require meaningful alt; capture content before execution', async () => {
    const read = async () => PNG;
    await expect(loadImage({ path: 'fake.png', alt: ' ' }, read)).rejects.toThrow('non-empty alt');
    const image = await loadImage({ path: 'fake.png', alt: 'Pixel' }, read);
    expect(image.plan.mime).toBe('image/png'); expect(image.plan.sha256).toHaveLength(64);
    await expect(loadImage({ path: 'fake', alt: 'Image' }, (async () => Buffer.from('not an image')))).rejects.toThrow('file signature');
    await expect(loadImage({ path: 'fake', alt: 'Image' }, (async () => Buffer.alloc(1_000_001)))).rejects.toThrow('1 MB');
    const f = fakeApi();
    await expect(preparePost({ posts: [{ text: 'draft', images: [{ path: 'a', alt: ' ' }] }] }, DID, f.api, fakeImage)).rejects.toThrow('non-empty alt');
    expect(f.handles).toHaveLength(0);
    const p = await preparePost({ posts: [{ text: '', images: [{ path: 'a', alt: 'Image' }] }] }, DID, f.api, fakeImage);
    expect(f.uploads).toHaveLength(0);
    await executePost(p, confirmationCode(p.plan), f.api);
    expect(f.uploads[0]).toBe(PNG);
    expect(f.created[0]!.embed).toHaveProperty('images.0.alt', 'Image');
  });
  test('CLI refuses omitted/extra alt and incompatible thread flags', async () => {
    const f = fakeCli();
    for (const args of [ ['--text', 't', '--image', 'file'], ['--text', 't', '--alt', 'orphan'], ['--text', 't', '--thread-file', 'f'] ]) {
      await expect(runCli(['post', ...args], f.deps)).rejects.toThrow();
    }
    expect(f.created).toHaveLength(0);
  });
  test('300 graphemes is allowed; 301 refuses even in a thread', async () => {
    const f = fakeApi();
    await preparePost({ posts: [{ text: 'é'.repeat(300) }] }, DID, f.api);
    await expect(preparePost({ posts: [{ text: '👨‍👩‍👦'.repeat(301) }] }, DID, f.api)).rejects.toThrow('300 graphemes');
    await expect(preparePost({ posts: [{ text: 'fine' }, { text: 'x'.repeat(301) }] }, DID, f.api)).rejects.toThrow('300 graphemes');
    expect(f.created).toHaveLength(0);
  });
  test('SDK facets use UTF-8 offsets and batched unique mention resolution', async () => {
    const f = fakeApi();
    const text = 'é @other.test https://example.com/path';
    const p = await preparePost({ posts: [{ text }, { text: '@other.test again' }] }, DID, f.api);
    expect(f.handles).toEqual(['other.test']);
    const facets = p.plan.posts[0]!.facets;
    expect(facets[0]!.index).toEqual({ byteStart: 3, byteEnd: 14 });
    expect(facets[0]!.features[0]).toMatchObject({ $type: 'app.bsky.richtext.facet#mention', did: OTHER });
    expect(facets[1]!.features[0]).toMatchObject({ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/path' });
  });
  test('unresolvable mentions fail closed', async () => {
    const f = fakeApi(); f.api.resolveHandle = async () => { throw new Error('Cannot resolve'); };
    await expect(preparePost({ posts: [{ text: '@other.test hello' }] }, DID, f.api)).rejects.toThrow('Cannot resolve');
    expect(f.created).toHaveLength(0);
  });
});

describe('threads, reply/quote embeds, partial failure', () => {
  test('thread file is fully previewed and sequential refs are materialized', async () => {
    const f = fakeCli();
    const draft = await runCli(['post', '--thread-file', 'fake.json'], f.deps) as { confirmationCode: string; posts: unknown[] };
    expect(draft.posts).toHaveLength(2); expect(f.created).toHaveLength(0);
    await runCli(['post', '--thread-file', 'fake.json', '--confirm', draft.confirmationCode], f.deps);
    expect(f.created[1]!.reply).toEqual({ root: { uri: `at://${DID}/app.bsky.feed.post/1`, cid: 'cid-1' }, parent: { uri: `at://${DID}/app.bsky.feed.post/1`, cid: 'cid-1' } });
  });
  test('partial failure reports succeeded URIs and never retries/rolls back', async () => {
    const f = fakeApi(); let calls = 0;
    const create = f.api.create;
    f.api.create = async record => { calls++; if (calls === 2) throw new Error('Lost response'); return create(record); };
    const p = await preparePost({ posts: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }, DID, f.api);
    try { await executePost(p, confirmationCode(p.plan), f.api); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(PartialWriteError);
      expect((error as PartialWriteError).toJSON()).toMatchObject({ succeeded: [{ uri: `at://${DID}/app.bsky.feed.post/1`, cid: 'cid-1' }], failedIndex: 2, uncertain: true });
    }
    expect(calls).toBe(2); expect(f.removed).toHaveLength(0);
  });
  test('upload failure is distinguished from uncertain record creation', async () => {
    const f = fakeApi(); f.api.upload = async () => { throw new Error('Upload failed'); };
    const p = await preparePost({ posts: [{ text: 'one', images: [{ path: 'fake', alt: 'Image' }] }] }, DID, f.api, fakeImage);
    try { await executePost(p, confirmationCode(p.plan), f.api); throw new Error('Expected failure'); }
    catch (error) { expect((error as PartialWriteError).toJSON()).toMatchObject({ succeeded: [], failedIndex: 1, uncertain: false }); }
    expect(f.created).toHaveLength(0);
  });
  test('reply root is retained across a thread; quote+images uses recordWithMedia', async () => {
    const f = fakeApi(); const root = { uri: `at://${OTHER}/app.bsky.feed.post/root`, cid: 'cid-root' };
    f.api.getPost = async uri => ({ ...view(uri), record: { ...view().record as object, reply: { root, parent: REF } } });
    const p = await preparePost({ posts: [{ text: 'reply', images: [{ path: 'fake', alt: 'Image' }] }, { text: 'continued' }], replyTo: URI, quote: URI }, DID, f.api, fakeImage);
    expect(p.plan.posts[0]!.reply).toEqual({ root, parent: REF });
    await executePost(p, confirmationCode(p.plan), f.api);
    expect(f.created[0]!.embed?.$type).toBe('app.bsky.embed.recordWithMedia');
    expect(f.created[1]!.reply?.root).toEqual(root);
  });
  test('invalid thread file schemas refuse', async () => {
    const f = fakeCli();
    for (const json of ['{}', '[]', '[{"text":42}]', '[{"text":"a","images":[{"path":"x"}]}]', '[{"text":"a","unexpected":true}]']) {
      f.deps.readText = async () => json;
      await expect(runCli(['post', '--thread-file', 'fake'], f.deps)).rejects.toThrow();
    }
  });
});

describe('delete owns-only, preview, CID-bound confirmation', () => {
  test('foreign posts refuse before fetching a record', async () => {
    const f = fakeApi(); let reads = 0;
    f.api.getOwnRecord = async () => { reads++; throw new Error('Not reached'); };
    await expect(prepareDelete(`https://bsky.app/profile/other.test/post/abc`, f.api)).rejects.toThrow('another account');
    expect(reads).toBe(0); expect(f.removed).toHaveLength(0);
  });
  test('own delete previews, confirms, and never deletes on mismatch', async () => {
    const f = fakeCli();
    const plan = await prepareDelete(URI, f.api);
    expect(preview(plan)).toHaveProperty('record'); expect(f.removed).toHaveLength(0);
    await expect(executeDelete(plan, 'wrong', f.api)).rejects.toThrow('does not match');
    await expect(executeDelete(plan, confirmationCode(plan), fakeApi(OTHER).api)).rejects.toThrow('another account');
    await executeDelete(plan, confirmationCode(plan), f.api);
    expect(f.removed).toEqual([REF]);
  });
  test('changed record CID/content invalidates confirmation', async () => {
    const f = fakeApi(); const plan = await prepareDelete(URI, f.api);
    expect(confirmationCode({ ...plan, ref: { ...plan.ref, cid: 'changed' } })).not.toBe(confirmationCode(plan));
    expect(confirmationCode({ ...plan, record: { text: 'changed' } })).not.toBe(confirmationCode(plan));
  });
});

describe('reads and CLI validation', () => {
  test('public reads have no credential lookup/auth and include thread/images', async () => {
    const f = fakeCli();
    await runCli(['profile', 'craig.rungie.com'], f.deps);
    await runCli(['feed', DID, '--limit', '10'], f.deps);
    const data = await runCli(['read', 'https://bsky.app/profile/craig.rungie.com/post/abc', '--depth', '0'], f.deps);
    expect(data).toHaveProperty('thread.parent'); expect(data).toHaveProperty('post.uri', URI);
    expect([f.authCalls(), f.opCalls()]).toEqual([0, 0]);
    expect(withImageUrls({ embed: { images: [{ alt: '', fullsize: 'https://cdn.example/image', thumb: 'small' }] } })).toHaveProperty('embed.images.0.url', 'https://cdn.example/image');
  });
  test('search tries both public hosts before an authenticated read', async () => {
    const f = fakeCli(); await runCli(['search', 'query'], f.deps); expect(f.authCalls()).toBe(0);
    f.api.search = async () => { throw new Error('403 from public.api.bsky.app'); };
    f.search.api.search = async () => ({ posts: [{ uri: URI }] });
    expect(await runCli(['search', 'query'], f.deps)).toEqual({ posts: [{ uri: URI }] });
    expect(f.authCalls()).toBe(0);
    const authed = fakeApi(); f.deps.authenticate = async () => authed.api;
    f.search.api.search = async () => { throw new Error('api.bsky.app unavailable'); };
    expect(await runCli(['search', 'query'], f.deps)).toEqual({ posts: [] });
    expect(f.created).toHaveLength(0); expect(authed.created).toHaveLength(0);
    f.deps.authenticate = async () => { throw new Error('No Bluesky app password available.'); };
    await expect(runCli(['search', 'query'], f.deps)).rejects.toThrow(/Both public search hosts refused.*No Bluesky app password/);
  });
  test('URL/URI parsing refuses foreign hosts, credentials, wrong collections', async () => {
    const f = fakeApi();
    expect(await postUri('https://bsky.app/profile/craig.rungie.com/post/abc?ref=x', f.api)).toBe(URI);
    expect(await postUri(URI, f.api)).toBe(URI);
    for (const value of ['https://evil.test/profile/craig.rungie.com/post/abc', 'https://user@bsky.app/profile/craig.rungie.com/post/abc', `at://${DID}/app.bsky.feed.like/abc`]) {
      await expect(postUri(value, f.api)).rejects.toThrow();
    }
  });
  test('help, unknown flags, command-specific flags and integer bounds', async () => {
    const f = fakeCli(); expect(await runCli(['--help'], f.deps)).toContain('Bluesky public reads');
    for (const args of [ ['feed', DID, '--limit', '101'], ['read', URI, '--depth', '-1'], ['feed', DID, '--limit', '1.5'], ['read', URI, '--confirm', 'x'], ['post', '--text', 'hi', '--typo'], ['profile'], ['search', 'a', 'b'] ]) {
      await expect(runCli(args, f.deps)).rejects.toThrow();
    }
    expect(f.created).toHaveLength(0);
  });
});
