---
name: No seed data, and why the approver name is required
description: How fictional boot state produced a real post signed by a person who does not exist, and the two rules that keep it from recurring.
---

`artifacts/studio/src/data.ts` (`initialState`) is what a fresh
install boots with and what "Reset to defaults" returns to. It contains UA
profiles — declared device configurations, real browser strings — and nothing
else. No workspaces, drafts, accounts, activity, or approver name.

**Why:** it used to contain a fictional tenant: operator "Alex Morgan", accounts
`@alex.morgan` / `@northstarhq`, sample drafts. On 2026-09-02 the owner approved
one of the sample drafts while the sample name was still in Settings and
published it from a real X account. The card, the activity log, and the ledger
all recorded the sign-off as "Alex Morgan". Approvals are snapshots of who
signed at the time (`approvedBy` is stamped in `approve()` and rendered from the
draft), so changing the name in Settings afterwards changed nothing, correctly.
The only real fix was for the fiction never to have existed.

**How to apply:**
- `settings.operatorName` starts empty. `lib/approver.ts#approverName` returns
  `null` for an empty name, and the review queue disables Approve, shows a
  notice pointing at Settings, and refuses in `approve()` while it is null.
  There is no default name — `'Operator'` was removed on purpose.
- Publishing sends `recordedApproval(draft)` verbatim or refuses. It never
  fills in a missing `approvedBy` or `approvedAt` at send time.
- History is not rewritten. Approvals already recorded under the placeholder
  stay as the ledger has them; that is what the ledger is for.
- Do not reintroduce sample content to make an empty UI look better. Every
  section has an honest empty state; extend those instead.
