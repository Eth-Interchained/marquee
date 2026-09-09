---
name: First verified post
description: What has actually been watched landing on a real account, and what that does and does not prove.
---

On 2026-09-02 the owner published a real post on X from the macOS shell:
account `@interchained`, workspace "Product Updates" (Chrome · Windows UA
profile), body "Shipping the smallest useful version is a strategy, not a
compromise." The review-queue card flipped to *posted* and its "View it on X"
link resolved to the live status. That is the first time any adapter in this
repo was observed doing the thing it claims to do.

**Why this matters:** every earlier note said "no adapter has been watched
working, X included" because the development surface has no display and no
sessions. That sentence is now false for X and still true for the other six
driven networks. The docs (`AGENTS.md § 7/§ 11`, `README.md`, `DEPLOY.md § 5/§ 10`)
were updated in the same commit as this file.

**How to apply:**
- Describe X's approve → publish → confirm path as verified. Do not describe it
  as covered: one post, one account, one OS. X UI states that were not
  exercised (media prompts, rate-limit interstitials, a changed composer) can
  still fail — loudly, as designed.
- Keep LinkedIn, Facebook, Threads, Bluesky, Mastodon and Tumblr marked as
  written-from-product-knowledge until someone watches each land a real post.
- When another adapter is verified, record the same four facts here: date, OS
  the shell ran on, account, and what the UI showed — then update the same
  three docs in one commit.
