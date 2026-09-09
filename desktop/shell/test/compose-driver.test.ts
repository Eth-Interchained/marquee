import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  runComposeFlow,
  type ComposeFlowOptions,
  type ComposerPage,
  type ConfirmState,
  type ProbeState,
} from "../src/publisher/compose-driver";
import { unconfirmedOutcome } from "../src/idempotency";
import type { PublishOutcome } from "../src/session-bridge-server";

/**
 * "Submitted, outcome unknown" is a refusal carrying a specific status, not a
 * kind of its own — so asserting the kind alone would not tell it apart from an
 * ordinary rejection. Both halves are checked against the ledger's own shape.
 */
const UNCONFIRMED = unconfirmedOutcome("probe");
const statusOf = (outcome: PublishOutcome) =>
  "status" in outcome ? outcome.status : undefined;

function assertUnconfirmed(outcome: PublishOutcome) {
  assert.notEqual(outcome.kind, "published", "an unknown outcome is never a success");
  assert.equal(outcome.kind, UNCONFIRMED.kind);
  assert.equal(
    statusOf(outcome),
    statusOf(UNCONFIRMED),
    "an unconfirmed attempt must carry the status that keeps it out of automatic retries",
  );
}

type Script = {
  probe?: ProbeState[];
  probeUpload?: ProbeState[];
  advance?: boolean[];
  present?: boolean[];
  headingSays?: boolean[];
  currentPath?: string[];
  openComposer?: boolean[];
  enterText?: { ok: boolean; detail?: string };
  attachMedia?: { ok: boolean; detail?: string };
  mediaReady?: boolean[];
  clickSubmit?: boolean[];
  confirm?: ConfirmState[];
};

/**
 * A page that answers from a script.
 *
 * The last entry of each queue repeats, so "always waiting" is one value and
 * the deadline decides when the flow gives up.
 */
function fakePage(script: Script) {
  const calls: string[] = [];
  const next = <T>(queue: T[] | undefined, fallback: T): T => {
    if (!queue || queue.length === 0) return fallback;
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  };

  const page: ComposerPage = {
    async probe() {
      calls.push("probe");
      return next(script.probe, "waiting");
    },
    async probeUpload() {
      calls.push("probeUpload");
      return next(script.probeUpload, "composer");
    },
    async advance(selector: string, text?: string) {
      calls.push(`advance:${selector}${text ? `:${text}` : ""}`);
      return next(script.advance, true);
    },
    async present(selector: string) {
      calls.push(`present:${selector}`);
      return next(script.present, true);
    },
    async currentPath() {
      calls.push('currentPath');
      return next(script.currentPath, '/');
    },
    async headingSays(selector: string, text: string) {
      calls.push(`headingSays:${selector}:${text}`);
      return next(script.headingSays, true);
    },
    async openComposer() {
      calls.push("openComposer");
      return next(script.openComposer, true);
    },
    async enterText(text: string) {
      calls.push(`enterText:${text}`);
      return script.enterText ?? { ok: true };
    },
    async attachMedia(paths: string[]) {
      calls.push(`attachMedia:${paths.join(",")}`);
      return script.attachMedia ?? { ok: true };
    },
    async mediaReady() {
      calls.push("mediaReady");
      return next(script.mediaReady, true);
    },
    async clickSubmit() {
      calls.push("clickSubmit");
      return next(script.clickSubmit, false);
    },
    async pressSubmitHotkey() {
      calls.push("pressSubmitHotkey");
    },
    async confirm() {
      calls.push("confirm");
      return next(script.confirm, { state: "waiting" });
    },
  };

  return { page, calls };
}

/** A clock that only moves when the flow sleeps, so tests are instant. */
function clock(budgetMs: number) {
  let current = 0;
  return {
    deadline: budgetMs,
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

function run(
  script: Script,
  over: Partial<{
    allowHotkey: boolean;
    hasOpener: boolean;
    media: string[];
    canAttach: boolean;
    reportsMediaReady: boolean;
    mediaRequired: boolean;
    mediaFirst: boolean;
    afterAttach: NonNullable<ComposeFlowOptions["afterAttach"]>;
    budgetMs: number;
  }> = {},
) {
  const { page, calls } = fakePage(script);
  const phases: Array<{ phase: string; ms: number }> = [];
  const time = clock(over.budgetMs ?? 5_000);
  return runComposeFlow(page, {
    label: "TestNet",
    body: "the approved words",
    media: over.media ?? [],
    canAttach: over.canAttach ?? true,
    reportsMediaReady: over.reportsMediaReady ?? true,
    mediaRequired: over.mediaRequired ?? false,
    mediaFirst: over.mediaFirst ?? false,
    ...(over.afterAttach ? { afterAttach: over.afterAttach } : {}),
    deadline: time.deadline,
    allowHotkey: over.allowHotkey ?? false,
    hasOpener: over.hasOpener ?? false,
    sleep: time.sleep,
    now: time.now,
    onPhase: (phase, ms) => phases.push({ phase, ms }),
  }).then((outcome) => ({ outcome, calls, phases, elapsed: time.now() }));
}

describe("the shared composer flow", () => {
  test("a login screen is reported as a signed-out session, not a failure", async () => {
    const { outcome, calls } = await run({ probe: ["login"] });

    assert.equal(outcome.kind, "unauthenticated");
    assert.ok(
      !calls.some((call) => call.startsWith("enterText")),
      "nothing may be typed into a login page",
    );
  });

  test("a composer that never appears submits nothing", async () => {
    const { outcome, calls } = await run({ probe: ["waiting"] });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /did not load/);
    assert.ok(!calls.includes("clickSubmit"), "nothing may be submitted without a composer");
  });

  test("a hidden composer is asked to open, and the click is not assumed to work", async () => {
    // This used to assert the opener was clicked exactly once, which encoded a
    // real bug as intended behaviour: one click that silently failed doomed
    // the whole attempt. Instagram's opener matched an `<svg>`, whose `click`
    // is `undefined`, so on that network the single click ALWAYS threw and the
    // composer could never open. A click is not progress until the thing it
    // should have produced appears.
    const { calls } = await run(
      { probe: ["waiting", "waiting", "composer"] },
      { hasOpener: true },
    );

    assert.ok(
      calls.filter((call) => call === "openComposer").length >= 1,
      "a hidden composer must actually be asked to open",
    );
  });

  test("an opener that keeps failing is retried, but not forever", async () => {
    const { calls } = await run(
      // Never opens: every poll still reports waiting.
      { probe: ["waiting"], openComposer: [true, true, true, true, true, true] },
      // The real compose budget. At the harness default of 5s the confirmation
      // reserve leaves barely a second before the pre-confirm cap, which is
      // correctly too little time to retry anything.
      { hasOpener: true, budgetMs: 18_000 },
    );

    const clicks = calls.filter((call) => call === "openComposer").length;
    assert.ok(clicks > 1, "one failed click must not doom the attempt");
    assert.ok(
      clicks <= 3,
      `capped so a dialog-per-click network cannot stack them, got ${clicks}`,
    );
  });

  test("a composer already on screen is never asked to open", async () => {
    const { calls } = await run({ probe: ["composer"] }, { hasOpener: true });

    assert.ok(
      !calls.includes("openComposer"),
      "clicking an opener when the composer is already up can close it again",
    );
  });

  test("text that does not land in the composer is never submitted", async () => {
    const { outcome, calls } = await run({
      probe: ["composer"],
      enterText: { ok: false, detail: "The composer holds 4 characters but the post is 18." },
    });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /Could not enter the post text/);
    assert.ok(!calls.includes("clickSubmit"), "a half-typed post must not be sent");
  });

  test("a submit button that never enables is a refusal, not a silent skip", async () => {
    const { outcome, calls } = await run({ probe: ["composer"], clickSubmit: [false] });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /never enabled its post button/);
    assert.ok(!calls.includes("confirm"), "there is nothing to confirm");
  });

  test("the keyboard shortcut is the fallback where a network has one", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [false], confirm: [{ state: "sent" }] },
      { allowHotkey: true },
    );

    assert.ok(calls.includes("pressSubmitHotkey"));
    assert.equal(outcome.kind, "published");
  });

  test("a post is published only on the network's own confirmation", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [
        { state: "waiting" },
        { state: "sent", postUrl: "https://example.social/@me/1234", postId: "1234", detail: "Posted" },
      ],
    });

    assert.equal(outcome.kind, "published");
    assert.equal(outcome.postUrl, "https://example.social/@me/1234");
    assert.equal(outcome.postId, "1234");
  });

  test("a rejection from the network is reported as one", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "error", detail: "Something went wrong." }],
    });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /rejected the post/);
  });

  test("silence until the deadline is unconfirmed, never success", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "waiting" }],
    });

    assertUnconfirmed(outcome);
    assert.match(String(outcome.detail), /not be retried automatically/);
  });

  test("a login demanded right after submitting leaves the outcome unknown", async () => {
    // The post may already have gone out. Calling this a failure would invite a
    // retry, and a retry could double-post.
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "login" }],
    });

    assertUnconfirmed(outcome);
    assert.match(String(outcome.detail), /unknown/);
  });

  test("an attachment goes on before the post is submitted, never after", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    const submitted = calls.indexOf("clickSubmit");
    assert.ok(attached >= 0, "the file must actually be attached");
    assert.ok(
      attached < submitted,
      "submitting before the file is attached posts the words without the picture",
    );
  });

  test("a post waits for the network to finish taking the file", async () => {
    const { outcome, calls } = await run(
      {
        probe: ["composer"],
        mediaReady: [false, false, true],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const lastReady = calls.lastIndexOf("mediaReady");
    assert.ok(
      lastReady < calls.indexOf("clickSubmit"),
      "an upload still in flight must not be submitted",
    );
  });

  test("an upload that never lands is a refusal, not a text-only post", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], mediaReady: [false] },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.ok(
      !calls.includes("clickSubmit"),
      "nothing may be submitted once the attachment is known to be missing",
    );
  });

  test("a file that could not be attached stops the post", async () => {
    const { outcome, calls } = await run(
      {
        probe: ["composer"],
        attachMedia: { ok: false, detail: "No file input matched." },
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /No file input matched/);
    assert.ok(!calls.includes("clickSubmit"), "a failed attachment must not post the text alone");
  });

  test("a network with no upload control refuses a post that carries one", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { media: ["/data/media/abc/photo.jpg"], canAttach: false },
    );

    assert.equal(outcome.kind, "rejected");
    assert.ok(!calls.includes("clickSubmit"), "the text alone is not the approved post");
  });

  test("a text-only post never touches the upload path", async () => {
    const { outcome, calls } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "sent" }],
    });

    assert.equal(outcome.kind, "published");
    assert.ok(
      !calls.some((call) => call.startsWith("attachMedia") || call === "mediaReady"),
      "adding attachments must not change how a plain post behaves",
    );
  });

  test("a network that needs a picture refuses a post with none", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { mediaRequired: true, media: [] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /without an image or video/);
    assert.equal(calls.length, 0, "nothing should even be opened");
  });

  test("an upload-first network waits for the upload control, not a caption box", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { mediaFirst: true, mediaRequired: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    assert.ok(calls.includes("probeUpload"), "the upload control is what gates the start");
    const firstProbeUpload = calls.indexOf("probeUpload");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    assert.ok(firstProbeUpload < attached);
  });

  test("an upload-first network types the caption only after the picture is in", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { mediaFirst: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    const typed = calls.findIndex((call) => call.startsWith("enterText"));
    assert.ok(typed > attached, "there is nowhere to type until the file is in");
  });

  test("the screens between upload and caption are walked in order", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [
          { click: "#crop-next", waitFor: "#filter-screen", label: "crop" },
          { click: "#filter-next", waitFor: "#caption-screen", label: "filter" },
        ],
      },
    );

    assert.equal(outcome.kind, "published");
    const order = [
      calls.indexOf("advance:#crop-next"),
      calls.indexOf("present:#filter-screen"),
      calls.indexOf("advance:#filter-next"),
      calls.indexOf("present:#caption-screen"),
      calls.findIndex((call) => call.startsWith("enterText")),
    ];
    assert.ok(
      order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!)),
      `steps ran out of order: ${JSON.stringify(order)}`,
    );
  });

  test("a step whose control never appears names the step that failed", async () => {
    const { outcome, calls } = await run(
      { probeUpload: ["composer"], probe: ["composer"], advance: [false] },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [{ click: "#crop-next", waitFor: "#filter-screen", label: "crop" }],
      },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /crop/, "the operator should know which screen stalled");
    assert.ok(!calls.includes("clickSubmit"));
  });

  test("a step that clicks but never advances is not treated as progress", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        advance: [true],
        present: [false],
      },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [{ click: "#crop-next", waitFor: "#filter-screen", label: "crop" }],
      },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /did not move past its crop step/);
    assert.ok(!calls.includes("clickSubmit"));
  });

  test("an upload-first network with no caption field posts nothing", async () => {
    const { outcome, calls } = await run(
      { probeUpload: ["composer"], probe: ["waiting"] },
      { mediaFirst: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /never showed a caption field/);
    assert.ok(!calls.includes("clickSubmit"));
  });

  test("confirmation always gets a real window, however slow the composer was", async () => {
    // The failure this reserve exists for, reproduced. On a cold start X's
    // composer took most of the budget to appear; the post was typed and
    // submitted with almost nothing left, and the toast arrived after the flow
    // had given up. The post was live and the app said it had failed.
    //
    // The composer here appears only after the pre-confirm cap, so the flow
    // must refuse rather than submit-and-not-watch.
    const { outcome, calls } = await run(
      { probe: ["waiting"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { budgetMs: 18_000 },
    );

    assert.equal(outcome.kind, "rejected");
    assert.ok(
      !calls.includes("clickSubmit"),
      "nothing may be submitted once there is no time left to confirm it",
    );
  });

  test("the pre-confirm phases cannot consume the whole budget", async () => {
    const { phases, elapsed } = await run(
      { probe: ["waiting"] },
      { budgetMs: 18_000 },
    );

    const composer = phases.find((p) => p.phase === "composer");
    assert.ok(composer, "the composer phase should report itself");
    assert.ok(
      composer.ms < 18_000,
      `waiting for a composer must stop before the budget ends, spent ${composer.ms}ms`,
    );
    assert.ok(
      elapsed <= 18_000,
      `the flow must not overrun its budget, took ${elapsed}ms`,
    );
  });

  test("a slow composer still leaves time to see a late toast", async () => {
    // The composer appears late but inside the cap, and the network confirms
    // several polls after submitting — which is what X actually does.
    const { outcome, phases } = await run(
      {
        probe: ["waiting", "waiting", "waiting", "composer"],
        clickSubmit: [true],
        confirm: [{ state: "waiting" }, { state: "waiting" }, { state: "sent" }],
      },
      { budgetMs: 18_000 },
    );

    assert.equal(outcome.kind, "published");
    const confirm = phases.find((p) => p.phase === "confirm");
    assert.ok(confirm, "the confirm phase should report itself");
  });

  test("every phase reports how long it took", async () => {
    // The whole flow used to be silent, so an unconfirmed post gave no clue
    // whether the budget went on the composer, the button, or the network.
    const { phases } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "sent" }],
    });

    assert.deepEqual(
      phases.map((p) => p.phase),
      ["composer", "submit", "confirm"],
    );
    for (const p of phases) {
      assert.equal(typeof p.ms, "number");
    }
  });
});

describe("advance steps on a screen full of identical controls", () => {
  const CLICK = 'div[role="dialog"] div[role="button"]';

  test("a step names the control it wants, rather than taking the first one", async () => {
    // Instagram's crop and caption screens match this selector five and six
    // times, with **Back** first in document order. "Click the first enabled
    // control" walked the operator backwards and then reported success.
    const { outcome, calls } = await run(
      { probe: ["composer"], probeUpload: ["composer"] },
      {
        mediaFirst: true,
        media: ["/tmp/a.png"],
        afterAttach: [
          {
            click: CLICK,
            clickText: "Next",
            waitFor: "#caption",
            label: "crop",
          },
        ],
        budgetMs: 18_000,
      },
    );

    assert.ok(
      calls.includes(`advance:${CLICK}:Next`),
      `the wanted control must be named; got ${JSON.stringify(calls.filter((c) => c.startsWith("advance")))}`,
    );
    // Proof the step was actually cleared rather than stalling on it.
    assert.ok(
      calls.includes("clickSubmit"),
      `the flow must reach the submit; outcome was ${outcome.kind}: ${String(outcome.detail ?? "")}`,
    );
  });

  test("a step waits on the heading when the markup does not change", async () => {
    const { calls } = await run(
      { probe: ["composer"], probeUpload: ["composer"] },
      {
        mediaFirst: true,
        media: ["/tmp/a.png"],
        afterAttach: [
          {
            click: CLICK,
            clickText: "Next",
            waitForHeading: { selector: "#head", text: "Edit" },
            label: "crop",
          },
        ],
        budgetMs: 18_000,
      },
    );

    assert.ok(
      calls.includes("headingSays:#head:Edit"),
      "a screen that differs only in wording is checked by its wording",
    );
  });

  test("a step with nothing to wait for is refused, not assumed to work", async () => {
    // The crop step used to wait for `div[role="dialog"]`, which was already on
    // screen — so it passed without proving the screen had advanced at all. A
    // step that cannot be checked must say so rather than report success.
    const { outcome, calls } = await run(
      { probe: ["composer"], probeUpload: ["composer"] },
      {
        mediaFirst: true,
        media: ["/tmp/a.png"],
        afterAttach: [{ click: CLICK, clickText: "Next", label: "crop" }],
        budgetMs: 18_000,
      },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /cannot tell/);
    assert.match(String(outcome.detail), /crop/, "the step names itself");
    assert.ok(
      !calls.includes("clickSubmit"),
      "nothing may be submitted through a step that was never verified",
    );
  });
});
