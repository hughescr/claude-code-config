# Reading Bluesky without the tool

Use these endpoints when there is no node or bun, for example in claude.ai chat. They are plain HTTPS GETs that return JSON and need no login.

## Turn a URL into an at:// URI

`https://bsky.app/profile/<actor>/post/<rkey>` becomes `at://<actor>/app.bsky.feed.post/<rkey>`.

`<actor>` can be a handle or a DID. The AppView accepts a handle in the URI. If you need the DID:
`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<handle>`

To go the other way, an at:// URI `at://<did>/app.bsky.feed.post/<rkey>` is `https://bsky.app/profile/<did>/post/<rkey>`.

## Endpoints

Base: `https://public.api.bsky.app/xrpc/`. URL-encode the `uri` parameter.

| Need | Endpoint |
|---|---|
| Post plus thread | `app.bsky.feed.getPostThread?uri=<at-uri>&depth=6&parentHeight=20` |
| Profile | `app.bsky.actor.getProfile?actor=<handle-or-did>` |
| Someone's posts | `app.bsky.feed.getAuthorFeed?actor=<handle-or-did>&limit=50&filter=posts_no_replies` (or `posts_with_replies`); page with `&cursor=<cursor>` |
| Who quoted a post | `app.bsky.feed.getQuotes?uri=<at-uri>&limit=50` |
| Search | `app.bsky.feed.searchPosts?q=<query>&limit=25` |

For search, `public.api.bsky.app` returned 403 on 2026-10-07, while `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts` answered without a login. Try the second host when the first refuses.

## Where things are in the JSON

- **Thread.** `thread.post` is the post. `thread.parent` chains upward. `thread.replies[]` holds the replies, each with its own `.post` and `.replies`.
- **Post text.** `post.record.text`, plus `post.author.handle`, `post.record.createdAt`, and `likeCount`, `repostCount`, `replyCount`, `quoteCount`.
- **Embeds, in `post.embed`, by `$type`:**
  - `app.bsky.embed.images#view`: `images[]` with `fullsize`, `thumb`, and `alt`
  - `app.bsky.embed.external#view`: a link card, `external.uri`, `title`, `description`
  - `app.bsky.embed.record#view`: a quoted post, `record.author`, `record.value.text`, `record.embeds`
  - `app.bsky.embed.recordWithMedia#view`: a quote plus media, `record.record` and `media.images[]`
  - `app.bsky.embed.video#view`: `playlist` (an HLS URL), `thumbnail`, and `alt`
- **Facets.** `post.record.facets` hold the full link URLs. The text shows a shortened form such as `github.com/hughescr/utr...`, so read the real link from the facet.

## Chat limits

In chat, the fetch tool may refuse a URL you built yourself and allow only URLs Craig gave or that came from search results. If it refuses, fetch the bsky.app URL Craig gave. Its preview metadata carries the post text and the first image. Otherwise ask Craig to paste the post.
