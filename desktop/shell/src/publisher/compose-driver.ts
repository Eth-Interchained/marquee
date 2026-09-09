/**
 * A shared composer driver.
 *
 * Every text network works the same way from the outside: wait for a composer,
 * put the approved text in it, submit once, and then decide whether the post
 * actually went out. Only the selectors differ. Writing that flow once means
 * the part that matters — deciding what counts as "sent" — is written once and
 * tested once, instead of eleven times with eleven different bugs.
 *
 * The rule the flow exists to enforce: **an outcome is only `published` when
 * the network said so.** Anything else is a rejection or, when the post may
 * have gone out but nothing confirmed it, an unconfirmed result that is never
 * retried automatically. A driver that guessed would eventually double-post or
 * claim an audience that never saw anything.
 *
 * Selectors belong to other people's products and will drift. When one does,
 * the flow reports which step failed rather than falling through to a cheerful
 * result — repair the config, not the reasoning.
 */

import type { WebContents } from "electron";
import type { PublishOutcome } from "../session-bridge-server";
import { unconfirmedOutcome } from "../idempotency";
import { runInPage } from "./page";
import { setFileInput } from "./upload";

export type ProbeState = "composer" | "login" | "waiting";

export type ConfirmState =
  | { state: "sent"; postUrl?: string; postId?: string; detail?: string }
  | { state: "error"; detail: string }
  | { state: "login" }
  | { state: "waiting" };

export type ComposerConfig = {
  /**
   * Clicked when the composer is not already on screen. Facebook and Threads
   * post from a dialog that only exists after something is clicked.
   *
   * The match does not have to be the clickable element itself. Networks label
   * these controls on an inner icon — Instagram's is
   * `svg[aria-label="New post"]` inside an `<a role="link">` — and an `<svg>`
   * is an `SVGElement`, which has no `.click()` at all. The driver walks up to
   * the nearest thing that can actually be clicked, so a selector may name
   * whichever element carries the label.
   */
  opener?: string;
  editor: string;
  editorKind: "contenteditable" | "textarea";
  submit: string;
  /**
   * The submit control's exact visible text, when the selector alone cannot
   * pick it out.
   *
   * Instagram's caption screen is the case this exists for: its Share control
   * is a `div[role="button"]` with obfuscated classes, no `aria-label` and no
   * test id, sitting alongside five other controls that match identically —
   * and "Back" comes first in document order. Clicking "the first enabled
   * button" there walks the operator backwards out of the composer.
   *
   * Matched case-insensitively against trimmed text. LOCALE-DEPENDENT: on a
   * non-English account nothing matches and the attempt refuses with nothing
   * submitted, which is the safe direction to fail in.
   */
  submitText?: string;
  /**
   * Send Ctrl/Cmd+Enter as real input when no submit button is clickable. Some
   * composers render their button in a way no stable selector reaches, but
   * every one of them honours the keyboard shortcut.
   */
  submitHotkey?: boolean;
  /**
   * The network's `<input type="file">`. Usually hidden behind a styled
   * button, so it is found structurally rather than by visibility.
   *
   * Absent means this composer has no upload control wired up yet, and a
   * draft carrying an attachment is refused rather than posted without it.
   */
  fileInput?: string;
  /**
   * Present once an attachment has finished attaching — a thumbnail, a
   * preview, a remove button. Submitting before this exists posts the text
   * without the picture, which is a different post from the approved one.
   */
  mediaAttached?: string;
  /**
   * This network will not take a text-only post.
   *
   * Enforced here as well as in the UI so a draft that lost its picture on the
   * way cannot arrive at a composer that has no way to refuse it.
   */
  mediaRequired?: boolean;
  /**
   * The caption field does not exist until a file has been chosen.
   *
   * Instagram and Pinterest are upload-first: there is nothing to type into
   * until an image is in. The flow waits for the upload control instead of the
   * editor, attaches, advances, and only then looks for somewhere to type.
   */
  mediaFirst?: boolean;
  /**
   * Clicks that carry a multi-step composer from the upload to the caption —
   * Instagram's crop and filter screens, for instance.
   *
   * Each step names what it is waiting for, so a screen that changes shape
   * fails with the name of the step that could not be completed rather than
   * as a generic timeout.
   */
  afterAttach?: Array<{
    click: string;
    /** The control's exact visible text. See `submitText` — same problem. */
    clickText?: string;
    /** A selector that only exists once this step has landed. */
    waitFor?: string;
    /**
     * Text the dialog heading must show once this step has landed, for screens
     * that share their markup with the one before and differ only in wording.
     * Instagram's crop screen becomes "Edit" with no structural change worth
     * selecting on.
     */
    waitForHeading?: { selector: string; text: string };
    /**
     * A regex the URL path must match once this step has landed.
     *
     * The best signal of the three where a network has it, because it is
     * neither markup nor language: Instagram's route flow walks
     * `/create/select/` to `/create/style/` to `/create/details/`, and those
     * cannot drift with a class rename or a translation.
     */
    waitForPath?: string;
    label: string;
  }>;
  login: { selectors?: string; pathPattern?: string };
  confirmation: {
    toast?: string;
    /** An anchor to the post that was just created. The strongest signal. */
    postLink?: string;
    /** Regex source; capture group 1 is the post id. */
    postUrlPattern?: string;
    /** Regex sources, matched case-insensitively against the toast text. */
    successText?: string;
    errorText?: string;
    /** Regex source. While the URL still matches, the post has not left. */
    stillComposingPath?: string;
  };
};

/**
 * The four things the driver does to a page. Split out so the flow can be
 * tested against a fake page: the orchestration is what decides honesty, and
 * it should not need Electron or a network account to prove it behaves.
 */
export type ComposerPage = {
  probe(): Promise<ProbeState>;
  /** Like `probe`, but satisfied by the upload control rather than the editor. */
  probeUpload(): Promise<ProbeState>;
  /**
   * Clicks the opener. `false` when nothing clickable was found *or* the click
   * threw — either way no progress was made, so the caller must try again
   * rather than assume the composer is on its way.
   */
  openComposer(): Promise<boolean>;
  /** Clicks one advance step; `false` when its control is not there yet. */
  advance(selector: string, text?: string): Promise<boolean>;
  /** True once `selector` is on the page. */
  present(selector: string): Promise<boolean>;
  /** True once `selector`'s text contains `text`, case-insensitively. */
  headingSays(selector: string, text: string): Promise<boolean>;
  /** The page's current URL path. */
  currentPath(): Promise<string>;
  enterText(text: string): Promise<{ ok: boolean; detail?: string }>;
  attachMedia(paths: string[]): Promise<{ ok: boolean; detail?: string }>;
  mediaReady(): Promise<boolean>;
  clickSubmit(): Promise<boolean>;
  pressSubmitHotkey(): Promise<void>;
  confirm(): Promise<ConfirmState>;
};

export type ComposeFlowOptions = {
  label: string;
  body: string;
  /** Absolute paths, already checked against the approval by the caller. */
  media?: string[];
  /** True when this composer declares a file input. */
  canAttach?: boolean;
  /** True when this composer can tell an attachment finished uploading. */
  reportsMediaReady?: boolean;
  /** This network refuses a post with no picture. */
  mediaRequired?: boolean;
  /** The caption field only appears after a file is chosen. */
  mediaFirst?: boolean;
  /**
   * Screens between the upload and the caption.
   *
   * Mirrors `ComposerConfig["afterAttach"]`; see the notes there for why a
   * step may need to name its control's text and why one with nothing to wait
   * for is refused rather than assumed to have worked.
   */
  afterAttach?: ComposerConfig["afterAttach"];
  /**
   * Called as each phase ends, with how long it took.
   *
   * The flow is otherwise silent, which meant an unconfirmed post gave no clue
   * whether the budget went on waiting for a composer, hunting for a button,
   * or genuinely waiting for a network that never answered. Those need
   * different fixes and used to be indistinguishable from the outside.
   */
  onPhase?: (phase: string, ms: number, detail?: Record<string, unknown>) => void;
  /** Absolute epoch ms. The API server abandons the bridge call at 20s. */
  deadline: number;
  allowHotkey: boolean;
  hasOpener: boolean;
  /**
   * The UA profile's name, named in the refusal when the composer cannot be
   * opened. That failure is far more often the profile than a drifted
   * selector: a workspace on a phone profile is served a different composer
   * entirely, and the desktop graph has nothing to match.
   */
  profileName?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const POLL_MS = 250;

/** How much of the remaining budget the click-the-button phase may spend. */
const SUBMIT_PHASE_SHARE = 0.4;

/**
 * The share of the budget that everything before confirmation may spend.
 *
 * Confirmation is the only phase that decides whether a post is reported as
 * having happened, so it is the one phase that must never be squeezed to
 * nothing. Getting there with no time left does not mean the post failed — it
 * means the post went out and nobody watched, which is the worst outcome this
 * flow can produce: the network has it, the ledger says `failed`, and a person
 * has to go and look.
 *
 * That is not hypothetical. On a cold start X's composer took most of a
 * seventeen-second budget to appear, the post was typed and submitted with
 * about a second to spare, and the toast arrived after the flow had already
 * given up. The post was live; the app said it had failed.
 */
const PRE_CONFIRM_SHARE = 0.6;

/** Confirmation always gets at least this long, whatever came before. */
const MIN_CONFIRM_MS = 4_000;

/**
 * How many times the opener may be clicked, and how long to leave between
 * attempts.
 *
 * More than one, because a single click can silently fail — the element found
 * may not be the one carrying the handler, or the page may not have hydrated
 * yet. Capped, because a network that opens a dialog per click would otherwise
 * end up with a stack of them.
 */
const MAX_OPENER_CLICKS = 3;
const OPENER_RETRY_MS = 1_200;

export async function runComposeFlow(
  page: ComposerPage,
  options: ComposeFlowOptions,
): Promise<PublishOutcome> {
  const { label, body, deadline, allowHotkey, hasOpener } = options;
  const media = options.media ?? [];
  const mediaFirst = options.mediaFirst === true;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  const phase = (name: string, since: number, detail?: Record<string, unknown>) =>
    options.onPhase?.(name, now() - since, detail);

  /**
   * The point by which everything except confirmation must be done.
   *
   * Capped rather than left to consume the whole budget, so confirmation
   * always has a real window — see `PRE_CONFIRM_SHARE`.
   */
  const totalBudget = deadline - startedAt;
  const confirmReserve = Math.max(MIN_CONFIRM_MS, totalBudget * (1 - PRE_CONFIRM_SHARE));
  const preConfirmDeadline = Math.max(startedAt, deadline - confirmReserve);

  // 0. A network that cannot take a text-only post says so before anything is
  //    opened. The UI refuses this too, but a draft can reach here having lost
  //    its picture, and the composer would otherwise sit waiting for a caption
  //    field that is never going to appear.
  if (options.mediaRequired && media.length === 0) {
    return {
      kind: "rejected",
      detail: `${label} does not take a post without an image or video. Attach one, approve it again, and it can go out from here.`,
    };
  }

  // 1. Wait for the composer, opening it if this network hides it behind a
  //    button. A login screen instead is a different answer, not a failure:
  //    the draft stays approved and the operator signs in.
  //
  //    On an upload-first network there is no caption field yet, so what is
  //    waited for is the upload control.
  //
  //    The opener is clicked more than once. It used to be tried a single
  //    time, with `opened = true` treated as done — so one click that landed
  //    on the wrong element, or arrived before the nav had hydrated, spent the
  //    rest of the budget polling for a composer nobody had asked for. This is
  //    the same rule the attach steps already follow: a click is not progress
  //    until the thing it should have produced actually appears.
  let openerClicks = 0;
  // Negative infinity, not 0: the flow's clock is injected and starts wherever
  // the caller says, so `0` made the first attempt wait out the retry gap
  // against a clock that began at 0 — and never clicked at all.
  let lastClickAt = Number.NEGATIVE_INFINITY;
  let state: ProbeState = "waiting";
  const composerSince = now();
  while (now() < preConfirmDeadline) {
    state = mediaFirst ? await page.probeUpload() : await page.probe();
    if (state !== "waiting") break;

    // Spaced out and capped: a composer that is merely slow must not be asked
    // to open repeatedly, or a network that opens one dialog per click ends up
    // with several stacked on top of each other.
    if (
      hasOpener &&
      openerClicks < MAX_OPENER_CLICKS &&
      now() - lastClickAt >= OPENER_RETRY_MS
    ) {
      const clicked = await page.openComposer();
      lastClickAt = now();
      if (clicked) openerClicks += 1;
    }

    await sleep(POLL_MS);
  }
  phase("composer", composerSince, { state, openerClicks });

  if (state === "login") {
    return {
      kind: "unauthenticated",
      detail: `${label} asked this workspace to sign in. Open the workspace tab and log in, then retry.`,
    };
  }

  if (state !== "composer") {
    // Which of these is true matters. "The upload screen did not load" reads
    // as a slow network, and that is what it said when Instagram's opener was
    // throwing on every attempt — so the fault looked like Instagram's when it
    // was three lines of ours. A refusal that misattributes the cause sends
    // the next person hunting in the wrong place.
    if (hasOpener && openerClicks === 0) {
      const profile = options.profileName
        ? ` This workspace is running the "${options.profileName}" profile; ${label} serves a different composer to a phone than to a desktop, so try a desktop profile before hunting for a selector.`
        : ` ${label} serves a different composer to a phone than to a desktop, so check this workspace's UA profile before hunting for a selector.`;
      return {
        kind: "rejected",
        detail: `Could not find anything on ${label} to open its composer with, so nothing was submitted.${profile}`,
      };
    }
    return {
      kind: "rejected",
      detail: mediaFirst
        ? `${label}'s upload screen did not appear after opening the composer; nothing was submitted.`
        : `${label}'s composer did not load in time; nothing was submitted.`,
    };
  }

  // 2. Enter the text, and read it back. A composer that holds something other
  //    than the approved text must not be submitted — the approval was for
  //    those exact words.
  //
  //    Upload-first networks do this after the picture is in, because until
  //    then there is nowhere to type; the two orders are otherwise identical.
  if (!mediaFirst) {
    const typed = await page.enterText(body);
    if (!typed.ok) {
      return {
        kind: "rejected",
        detail: `Could not enter the post text on ${label}. ${typed.detail ?? ""}`.trim(),
      };
    }
  }

  // 2b. Attach the files, and wait for the network to finish taking them.
  //
  //     An upload that is still in flight when the button is pressed posts the
  //     words without the picture. That is not a smaller version of the
  //     approved post; it is a different one, and on a network that requires
  //     media it may not be a post at all.
  if (media.length > 0) {
    if (!options.canAttach) {
      return {
        kind: "rejected",
        detail: `This build cannot attach files on ${label} yet, and the post carries ${
          media.length === 1 ? "an attachment" : "attachments"
        }. Nothing was posted; post it from the workspace tab instead.`,
      };
    }

    const attached = await page.attachMedia(media);
    if (!attached.ok) {
      return {
        kind: "rejected",
        detail: `Could not attach the file on ${label}. ${attached.detail ?? ""}`.trim(),
      };
    }

    if (options.reportsMediaReady) {
      let ready = false;
      while (now() < preConfirmDeadline && !ready) {
        ready = await page.mediaReady();
        if (!ready) await sleep(POLL_MS);
      }
      if (!ready) {
        return {
          kind: "rejected",
          detail: `${label} never finished taking the attachment, so nothing was submitted.`,
        };
      }
    }
  }

  // 2c. Walk the screens between the upload and the caption.
  //
  //     Instagram puts crop and filter steps in the way; each is a button that
  //     only exists once the previous screen has settled. A step that cannot be
  //     completed names itself, because "the composer timed out" would send
  //     someone hunting through the whole flow for a control that moved.
  for (const step of options.afterAttach ?? []) {
    const stepSince = now();

    let advanced = false;
    while (now() < preConfirmDeadline && !advanced) {
      advanced = await page.advance(step.click, step.clickText);
      if (!advanced) await sleep(POLL_MS);
    }
    if (!advanced) {
      return {
        kind: "rejected",
        detail: `${label} never offered its ${step.label} control, so nothing was submitted.`,
      };
    }

    // What proves the step landed. A step with neither is a step that cannot
    // be checked, and it is better to say so than to report a success nobody
    // verified — Instagram's crop step used to wait for `div[role="dialog"]`,
    // which was already on screen, so it passed without proving anything.
    if (!step.waitFor && !step.waitForHeading && !step.waitForPath) {
      return {
        kind: "rejected",
        detail: `This build cannot tell whether ${label} moved past its ${step.label} step, so nothing was submitted.`,
      };
    }

    let arrived = false;
    while (now() < preConfirmDeadline && !arrived) {
      if (step.waitForPath) {
        arrived = new RegExp(step.waitForPath).test(await page.currentPath());
      } else if (step.waitFor) {
        arrived = await page.present(step.waitFor);
      } else {
        arrived = await page.headingSays(
          step.waitForHeading!.selector,
          step.waitForHeading!.text,
        );
      }
      if (!arrived) await sleep(POLL_MS);
    }
    if (!arrived) {
      return {
        kind: "rejected",
        detail: `${label} did not move past its ${step.label} step, so nothing was submitted.`,
      };
    }

    phase(`afterAttach:${step.label}`, stepSince);
  }

  // 2d. Now the caption field exists, so the approved words can go in.
  if (mediaFirst) {
    let editorReady = false;
    while (now() < preConfirmDeadline && !editorReady) {
      editorReady = (await page.probe()) === "composer";
      if (!editorReady) await sleep(POLL_MS);
    }
    if (!editorReady) {
      return {
        kind: "rejected",
        detail: `${label} never showed a caption field, so nothing was submitted.`,
      };
    }

    const typed = await page.enterText(body);
    if (!typed.ok) {
      return {
        kind: "rejected",
        detail: `Could not enter the post text on ${label}. ${typed.detail ?? ""}`.trim(),
      };
    }
  }

  // 3. Submit once.
  //
  //    Where a keyboard shortcut is available, the hunt for a clickable button
  //    gets only part of the budget: spending all of it means the fallback
  //    fires with no time left to find out what it did, which turns every
  //    button drift into an unconfirmed post.
  const submitSince = now();
  const submitDeadline = allowHotkey
    ? Math.min(
        preConfirmDeadline,
        now() + Math.max(1_000, (preConfirmDeadline - now()) * SUBMIT_PHASE_SHARE),
      )
    : preConfirmDeadline;

  let submitted = false;
  while (now() < submitDeadline && !submitted) {
    submitted = await page.clickSubmit();
    if (!submitted) await sleep(200);
  }
  phase("submit", submitSince, { clicked: submitted });

  if (!submitted) {
    if (!allowHotkey) {
      return {
        kind: "rejected",
        detail: `${label} never enabled its post button; the draft was not submitted.`,
      };
    }
    // A real key event, not a synthetic one, so the page cannot tell it from
    // the operator pressing the keys themselves.
    await page.pressSubmitHotkey();
  }

  // 4. Confirm. Silence is not success.
  //
  //    This is the phase the reserve exists for: it always gets a real window,
  //    because arriving here with nothing left means a post that went out gets
  //    reported as failed.
  const confirmSince = now();
  while (now() < deadline) {
    const confirmation = await page.confirm();

    if (confirmation.state === "error") {
      return { kind: "rejected", detail: `${label} rejected the post: ${confirmation.detail}` };
    }

    if (confirmation.state === "login") {
      return unconfirmedOutcome(
        `${label} asked for a sign-in immediately after the post was submitted, so whether it went out is unknown. ` +
          `Check the account: this attempt will not be retried automatically, because a retry could double-post.`,
      );
    }

    if (confirmation.state === "sent") {
      phase("confirm", confirmSince, { outcome: "sent" });
      return {
        kind: "published",
        postUrl: confirmation.postUrl,
        postId: confirmation.postId,
        detail: confirmation.detail ?? `${label} accepted the post.`,
      };
    }

    await sleep(POLL_MS);
  }

  phase("confirm", confirmSince, { outcome: "unconfirmed" });
  return unconfirmedOutcome(
    `The post was submitted to ${label} but no confirmation arrived before the deadline. ` +
      `Check the account: this attempt will not be retried automatically, because a retry could double-post.`,
  );
}

/**
 * Binds a config to a real page.
 *
 * Every function below is serialized into the page, so it may only touch its
 * own arguments — the config travels with it.
 */
export function composerPage(contents: WebContents, config: ComposerConfig): ComposerPage {
  return {
    async probe() {
      return runInPage<ProbeState>(
        contents,
        (cfg: ComposerConfig) => {
          if (document.querySelector(cfg.editor)) return "composer";
          if (cfg.login.selectors && document.querySelector(cfg.login.selectors)) return "login";
          if (cfg.login.pathPattern && new RegExp(cfg.login.pathPattern).test(window.location.pathname)) {
            return "login";
          }
          return "waiting";
        },
        config,
      );
    },

    async probeUpload() {
      return runInPage<ProbeState>(
        contents,
        (cfg: ComposerConfig) => {
          if (cfg.fileInput && document.querySelector(cfg.fileInput)) return "composer";
          if (cfg.login.selectors && document.querySelector(cfg.login.selectors)) return "login";
          if (cfg.login.pathPattern && new RegExp(cfg.login.pathPattern).test(window.location.pathname)) {
            return "login";
          }
          return "waiting";
        },
        config,
      );
    },

    async advance(selector: string, text?: string) {
      return runInPage<boolean>(
        contents,
        (input: { selector: string; text?: string }) => {
          const controls = Array.from(
            document.querySelectorAll(input.selector),
          ) as HTMLElement[];
          const wanted = input.text?.trim().toLowerCase();

          for (const control of controls) {
            if (control.getAttribute("aria-disabled") === "true") continue;
            if ((control as HTMLButtonElement).disabled) continue;
            if (control.offsetParent === null) continue;

            // Without this, "click the first enabled control" is whatever the
            // network happens to put first — which on Instagram's crop and
            // caption screens is "Back". The step then reports success while
            // moving the operator backwards.
            if (wanted !== undefined) {
              if ((control.textContent ?? "").trim().toLowerCase() !== wanted) {
                continue;
              }
            }

            if (typeof control.click !== "function") continue;
            try {
              control.click();
            } catch {
              continue;
            }
            return true;
          }
          return false;
        },
        { selector, text },
      );
    },

    async currentPath() {
      return runInPage<string>(contents, () => window.location.pathname, {});
    },

    async headingSays(selector: string, text: string) {
      return runInPage<boolean>(
        contents,
        (input: { selector: string; text: string }) => {
          const wanted = input.text.trim().toLowerCase();
          for (const el of Array.from(document.querySelectorAll(input.selector))) {
            if ((el.textContent ?? "").trim().toLowerCase().includes(wanted)) {
              return true;
            }
          }
          return false;
        },
        { selector, text },
      );
    },

    async present(selector: string) {
      return runInPage<boolean>(
        contents,
        (input: { selector: string }) => !!document.querySelector(input.selector),
        { selector },
      );
    },

    async openComposer() {
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) => {
          if (!cfg.opener) return false;

          // Every element the selector reaches, not just the first. Networks
          // label these controls on an inner icon, so the first match is
          // frequently a descendant that cannot be clicked.
          const matches = Array.from(document.querySelectorAll(cfg.opener));
          if (matches.length === 0) return false;

          for (const match of matches) {
            // `SVGElement` is not an `HTMLElement` and has no `.click()`.
            // Instagram's opener match IS an `<svg>`, so calling `.click()` on
            // it threw a TypeError and the composer never opened — verified
            // against a real signed-in account.
            const clickable = match.closest(
              'a,button,[role="button"],[role="link"],[tabindex]',
            ) as HTMLElement | null;
            const target =
              clickable ?? (match instanceof HTMLElement ? match : null);
            if (!target || typeof target.click !== "function") continue;
            if (target.offsetParent === null) continue;

            try {
              target.click();
              return true;
            } catch {
              // A control that refuses the click is not progress. Try the next
              // match rather than reporting an open that did not happen.
              continue;
            }
          }
          return false;
        },
        config,
      );
    },

    async enterText(text: string) {
      return runInPage<{ ok: boolean; detail?: string }>(
        contents,
        (input: { cfg: ComposerConfig; text: string }) => {
          const editor = document.querySelector(input.cfg.editor) as HTMLElement | null;
          if (!editor) {
            return { ok: false, detail: "The composer disappeared before the text was entered." };
          }

          const expected = input.text.trim();
          editor.focus();

          if (input.cfg.editorKind === "textarea") {
            // A React-controlled field ignores a plain value assignment, so go
            // through the native setter and announce it the way typing does.
            const field = editor as HTMLTextAreaElement | HTMLInputElement;
            const prototype =
              field instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(field, input.text);
            else field.value = input.text;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));

            const written = (field.value ?? "").trim();
            if (written !== expected) {
              return {
                ok: false,
                detail: `The composer holds ${written.length} characters but the post is ${expected.length}.`,
              };
            }
            return { ok: true };
          }

          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, input.text);
          const written = (editor.textContent ?? "").replace(/\u200b/g, "").trim();
          if (written !== expected) {
            return {
              ok: false,
              detail: `The composer holds ${written.length} characters but the post is ${expected.length}.`,
            };
          }
          return { ok: true };
        },
        { cfg: config, text },
      );
    },

    async attachMedia(paths: string[]) {
      if (!config.fileInput) {
        return { ok: false, detail: "No upload control is configured for this network." };
      }
      const result = await setFileInput(contents, config.fileInput, paths);
      return result.ok ? { ok: true } : { ok: false, detail: result.detail };
    },

    async mediaReady() {
      if (!config.mediaAttached) return true;
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) =>
          cfg.mediaAttached ? !!document.querySelector(cfg.mediaAttached) : true,
        config,
      );
    },

    async clickSubmit() {
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) => {
          const buttons = Array.from(
            document.querySelectorAll(cfg.submit),
          ) as HTMLElement[];
          const wanted = cfg.submitText?.trim().toLowerCase();

          for (const button of buttons) {
            if (button.getAttribute("aria-disabled") === "true") continue;
            if ((button as HTMLButtonElement).disabled) continue;
            if (button.offsetParent === null) continue;

            // Instagram's caption screen matches six controls on this selector
            // with "Back" first, so submitting "the first enabled one" leaves
            // the composer instead of sending the post.
            if (wanted !== undefined) {
              if ((button.textContent ?? "").trim().toLowerCase() !== wanted) {
                continue;
              }
            }

            if (typeof button.click !== "function") continue;
            try {
              button.click();
            } catch {
              continue;
            }
            return true;
          }
          return false;
        },
        config,
      );
    },

    async pressSubmitHotkey() {
      const modifier = process.platform === "darwin" ? "meta" : "control";
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: [modifier] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: [modifier] });
    },

    async confirm() {
      return runInPage<ConfirmState>(
        contents,
        (cfg: ComposerConfig) => {
          const rules = cfg.confirmation;

          const toast = rules.toast
            ? (document.querySelector(rules.toast) as HTMLElement | null)
            : null;
          const toastText = (toast?.textContent ?? "").trim();

          if (rules.errorText && toastText && new RegExp(rules.errorText, "i").test(toastText)) {
            return { state: "error", detail: toastText };
          }

          const link = rules.postLink
            ? (document.querySelector(rules.postLink) as HTMLAnchorElement | null)
            : null;
          if (link?.href) {
            const id = rules.postUrlPattern
              ? (link.href.match(new RegExp(rules.postUrlPattern))?.[1] ?? undefined)
              : undefined;
            return {
              state: "sent",
              postUrl: link.href,
              postId: id,
              detail: toastText || undefined,
            };
          }

          if (rules.successText && toastText && new RegExp(rules.successText, "i").test(toastText)) {
            return { state: "sent", detail: toastText };
          }

          // A composer that vanished because the page bounced to a login says
          // nothing about whether the post went out — and must not be read as
          // an emptied composer.
          const wentToLogin =
            (!!cfg.login.selectors && !!document.querySelector(cfg.login.selectors)) ||
            (!!cfg.login.pathPattern &&
              new RegExp(cfg.login.pathPattern).test(window.location.pathname));
          if (wentToLogin) return { state: "login" };

          const editor = document.querySelector(cfg.editor) as
            | HTMLTextAreaElement
            | HTMLElement
            | null;
          const contents_ =
            editor === null
              ? ""
              : ((editor as HTMLTextAreaElement).value ?? editor.textContent ?? "");
          const emptied = editor === null || contents_.trim() === "";
          const stillComposing = rules.stillComposingPath
            ? new RegExp(rules.stillComposingPath).test(
                window.location.pathname + window.location.search,
              )
            : false;

          if (emptied && !stillComposing) return { state: "sent" };
          return { state: "waiting" };
        },
        config,
      );
    },
  };
}
