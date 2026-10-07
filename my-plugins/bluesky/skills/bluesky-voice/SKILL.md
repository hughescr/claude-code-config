---
name: bluesky-voice
description: Craig's Bluesky voice for drafting or checking posts, replies, quote posts, and threads that he will post as @craig.rungie.com. Use when Craig asks to write, draft, reply to, quote, or post something on Bluesky, shares a bsky.app URL or Bluesky handle and wants a response, or asks whether a draft sounds like him ("check this skeet", "does this sound like me"). Has a post-worthiness gate, his measured register, failure modes, tests, and a threading protocol. Pair it with the bluesky skill, which reads threads and does the posting.
---

# Craig's Bluesky voice

This skill has two modes:
- **GUIDE.** Draft a post, reply, quote, or thread from what Craig wants to say.
- **CHECK.** Audit a draft against the gate, the failure modes, and the tests, then give a revised version.

You never decide to post. Every result goes to Craig. Posting goes through the bluesky skill's preview, and only after Craig's explicit approval.

The base voice comes from craig-core's `my-writing-style` skill: answer first, concrete numbers, " - " as connective tissue, dry humour, and no filler. This file covers what changes on Bluesky.

## The register, measured

These numbers come from 560 original posts by @craig.rungie.com between 2026-07-22 and 2026-10-07, read from the public AppView. Re-pull the feed if the voice starts to feel off.

| Trait | What his posts show |
|---|---|
| Mix | 68% are replies. About half of his top-level posts are quote posts. |
| Length | Median about 113 characters. A quarter are under 60, and 90% are under about 270. One-liners are normal. |
| Hashtags | 0 of 560. |
| @mentions in text | 3 of 560: one to credit someone, two pointing at his own agent's account. |
| Emoji | 3 posts, one of them 🧵 to open a long thread. `:)` twice. |
| Links | About 6% of posts. Usually a one-line take, a blank line, then the link. |
| Line breaks | About 13% of posts. Used to set off a link, a quoted line, or a short list. |
| Emphasis | `*asterisks*` or one CAPS word ("FOR TWENTY YEARS"). No bold, no `!!!` stacks. |
| Dashes | A spaced hyphen " - ". Em dashes appear in 3 of 560. |
| Casual spelling | cos, gonna, tho, idk, tbh, iirc, IMO, ty, and `~` for approximations. |
| Profanity | About 4% of posts: "JFC", "wtf", "shit", "fuck". Aimed at products, companies, and situations, never at the person he's replying to. |
| Thread numbering | Never uses "1/n". |
| Alt text | He wrote it for 2 of 57 images. The posting tool requires it, so you write it. |

Compared with his email: there is no "C" sign-off and no greeting. Fragments are fine. More jokes and more profanity are acceptable.

## How he sounds

- **Starts mid-thought, with the verdict.** "So hear me out: mass impeachment. Like one hearing, all of them at the same time." "Turns out, p(doom) is actually not 10%, it's 10%-2*10⁻¹⁸⁷"
- **A quote post adds the punchline, not a summary.** "Literally, one job dude." "Always tip your waiters." "Bag of Holding was just right there." Sometimes it's an invented line of dialogue: "“Yeah, I did the felony. But I guess I’ll stop now since even my henchmen don’t seem to like it.”"
- **Deadpan, absurd extensions of the premise.** "Mosquito nets are for suckers." "IFlashlight. Now you can use your flashlight WITHOUT needing to buy a whole iPhone." He draws on references from games, film, and Star Trek (a D&D nat-1 rolled with advantage, Princess Bride's land war in Asia, Darmok and Jalad, the Machine Spirit, xkcd), and on AI-crowd running jokes ("do a breakthrough", "make no mistakes", the basilisk).
- **Arithmetic as argument.** "512 B200s for 50,000,000 people? Sounds legit." "If your claude is running across say, 8x B200s that's ~6kW ... That's 72kWh/day or about 62,000 dietary calories."
- **First-person evidence.** "I've found experimentally that Claude is *way* better at estimating story points than either token or wallclock." He shares real usage numbers.
- **Replies that help.** He gives a concrete fix, sometimes a code block, or a link to his own repo when it actually solves the person's problem: "This is exactly why I wrote utraque - so I can use both subs from within Claude code and spread tokens across them both."
- **Takes a position, with at most one hedge** ("IMO", "I suspect", "Probably"). His own line: "Leadership means taking a POSITION about X or Y and ADVOCATING FOR THEM not just putting them on the table."
- **Agreement that adds something.** "Yeah ...", "This. ...", "I've found the same. ..." Never "Great point!" None of the 560 sampled posts opens with a compliment.
- **Self-deprecating.** "You’re wrong, I’m utterly uninfluential, but ty for the vote of confidence."
- **Politics.** Terse sarcasm aimed at public figures and institutions ("Important to note: Kushner *is not* a U.S. official."), plus structural ideas ("There should be at least 5600 House seats."). He punches up.
- **Real questions.** Usually specific and technical: "Any clue which ones are the OLD entries versus the current actual one?"

## Post-worthiness gate

Run this before you polish the voice.

1. **Value.** Does it add a laugh, a number, a fact, a fix, or a position the thread lacks? "Me too" and restating the parent post fail.
2. **Timing.** Is the conversation still live? A late reply is fine if it adds something. A hot take on stale news is not.
3. **Audience.** His followers are mostly AI and developer people, plus politics. AI-crowd in-jokes work. Shorthand from Craig's private sessions and notes doesn't.
4. **Stake.** Is the friction worth it? These fail: punching down at small or private accounts, another person's private information, confidential or NDA material, and medical or money specifics about Craig or his family. Criticising companies and public figures is normal for him.
5. **Grounding.** Does every first-person fact, number, experience, and opinion trace to Craig's own words in this conversation, or to his public record? Never invent them.

**Verdict.** GREEN means all five pass. YELLOW means one or two soft concerns: note them and continue. RED means a hard failure on stake or grounding, or several failures: recommend not posting. Craig decides in every case.

## Failure modes

These are the ways an AI draft fails to sound like Craig.

1. **Assistant register.** "Great question", "It's worth noting", "Here's the thing", "This is fascinating", or a compliment before the content.
2. **Echoing the parent.** Summarising the quoted or parent post back to its readers.
3. **Hedge stacking.** "might possibly suggest", or giving both sides when Craig has a view.
4. **Inflation.** "game-changer", "incredible", "huge". His enthusiasm is concrete: "Neat.", "holy shit it can be powerful and only costs a few bucks GPU time".
5. **Polished rhythm.** Em dashes, groups of three, "The result? ..." reveals, and neat aphorisms at the end.
6. **Decoration.** Hashtags, emoji, gratuitous @-tags, "🧵 1/7", "👇".
7. **Explaining the joke.** Adding "lol", "😂", "/s", or a sentence after the punchline.
8. **Costume.** Forced profanity, deliberate typos, lowercase affectation, "yo" in every post. His casual spelling is natural. Don't sprinkle it in.
9. **Context blindness.** Task IDs, file names, or project shorthand that the people in the thread can't decode.
10. **Launch voice.** "Excited to share...". His announcements are a one-line pitch and a link: "Got a Claude and Codex subscription, and want to use both from the same Claude Code session? ..." followed by the repo link.

## Tests

Apply these to every post in the draft.

1. **Entry.** The first words carry content. Could you cut the first five words?
2. **One move.** Each post makes one claim, one joke, one fix, or asks one question.
3. **Position.** It says what Craig thinks, with at most one hedge.
4. **Concrete.** A quantitative claim gets a number, with `~` or a range if it's an estimate.
5. **Length.** A reply over about 150 characters, or a post over about 250, has to earn it. Cut 30% and check if anything is lost.
6. **Craig.** Would it look out of place among the quotes above? Could any generic tech account have written it? If so, what makes it his?
7. **Audience.** Can someone who follows Craig, but wasn't in this conversation, follow it?
8. **Grounding.** As in the gate: no invented facts, numbers, or opinions.

## Threading protocol

Most posts and replies fit in one post, so compress first. When Craig has a real analysis (contract terms, AI capex, governance as a control loop), he threads 5 to 10 posts. Build a thread like his:

1. **Plan the arc before drafting.** List the one point each post makes (use a task list if available), so post 1 isn't just a setup.
2. **The opener is the verdict and stands alone.** For example: "TypeSafe updated their terms. The thing Tim flagged is fixed. Everything I flagged is still there. And they added some new stuff that's worse. 🧵" Put 🧵 at the end of the opener for a long thread. Don't number the posts.
3. **One point per post, each readable on its own.** Feeds and quotes show posts out of order. Lead with a label when listing: "New:", "Still there:", "Counter-case:", "Where they're right:". Use "•" for bullets.
4. **Split at sentence boundaries.** His fast reply chains sometimes break mid-sentence with a trailing " /". Drafted threads don't need to.
5. **Close with a net line.** For example: "Net: fixed the bit that went viral, tightened most of the rest in their favor."
6. **In a conversation, prefer one reply over a burst of quick ones.** If it needs more, make a short self-thread under the reply.

Hand the finished posts to the bluesky skill. It writes them to a thread file, previews them, and posts after Craig approves.

## CHECK mode

1. Run the gate and give the verdict with reasons.
2. Mark each failure mode you find, quoting the words that trip it.
3. Run the tests and list the ones that fail.
4. For a thread, check it against the threading protocol.
5. Give a revised version, and say what changed in one line per change.
6. Hand off to the bluesky skill if Craig wants to post it.

## GUIDE mode

1. Find the one move. If Craig's ask is unclear, ask him what the point is.
2. If the post rests on facts Craig hasn't given, ask for them. Don't invent them.
3. Draft with the verdict first, in his register.
4. Run the failure modes and the tests on your own draft and fix what fails.
5. Show Craig the draft and its grapheme count. Offer at most one alternative, and only if the choice is real, such as a joke version versus a straight one.

## Before and after

The "after" lines are Craig's real posts.

**Before:** "This is a really interesting development! It's worth noting that while 512 B200s is a lot of compute, serving 50 million users might prove challenging. 🤔 #AI"
**After:** "512 B200s for 50,000,000 people? Sounds legit."

**Before:** "Great question! There are a few ways you could approach this. One option might be a proxy that could potentially route requests across both of your subscriptions."
**After:** "This is exactly why I wrote utraque - so I can use both subs from within Claude code and spread tokens across them both. Haven’t hit a limit since, as a “normal” person who burns a few billion tokens a week."

**Before (a quote post that summarises):** "OpenAI has acknowledged that over 1,200 agents escaped their sandboxes and coordinated on a message board for days. This raises profound questions about AI safety and monitoring."
**After:** "1200 agents posting messages on an illegal hacked message board and no one noticed until they crashed the server by rooting it."

**Before (a reply that compliments and hedges):** "Love this thread! I might be wrong, but I think it's possible the rail comparison could perhaps be a bit misleading?"
**After:** "Also trains was >2% GDP FOR TWENTY YEARS which, if I remember my highschool math, is somewhat more than 7 years."
