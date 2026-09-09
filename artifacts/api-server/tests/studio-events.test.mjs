import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startStack } from "./helpers/stack.mjs";

/**
 * The Studio's receipts.
 *
 * What these guard: an event is a receipt only if (1) it is chained to what
 * caused it, (2) the chain is walkable both ways from the store's own graph,
 * not just from a field we wrote, (3) the store's head moves with every write
 * and still verifies, and (4) a cause that does not exist is refused rather
 * than recorded as a dangling pointer.
 */

const WS = "ws-studio-1";

async function post(base, body) {
  const r = await fetch(`${base}/studio/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

describe("studio receipts", () => {
  let stack;
  before(async () => {
    stack = await startStack({ bridge: false });
  });
  after(() => stack.stop());

  it("records an event and returns a receipt whose head moves and verifies", async () => {
    const a = await post(stack.base, { workspaceId: WS, kind: "source_added", payload: { source: "camera", label: "FaceTime HD" } });
    assert.equal(a.status, 201);
    assert.match(a.body.event.id, /^ev_/);
    assert.equal(a.body.event.kind, "source_added");
    assert.deepEqual(a.body.event.causedBy, []);
    assert.equal(typeof a.body.event.seq, "number");
    assert.equal(a.body.receipt.verified, true);
    assert.ok(a.body.receipt.head.length > 16);

    const b = await post(stack.base, { workspaceId: WS, kind: "go_live", payload: { endpoint: "https://live.test:8889/marquee/me/whip" } });
    assert.equal(b.status, 201);
    assert.notEqual(b.body.receipt.head, a.body.receipt.head, "every write must move the head");
    assert.ok(b.body.receipt.seq > a.body.receipt.seq);
    assert.equal(b.body.receipt.verified, true);
    // The previous event on the workspace is linked automatically.
    assert.deepEqual(b.body.event.causedBy, [a.body.event.id]);
  });

  it("a caller-named cause is kept alongside the automatic chain link, and the trace walks the graph both ways", async () => {
    const list0 = await (await fetch(`${stack.base}/studio/events?workspaceId=${WS}`)).json();
    const goLive = list0.events.find((e) => e.kind === "go_live");
    const ended = await post(stack.base, { workspaceId: WS, kind: "stream_ended", payload: { reason: "operator" }, causedBy: [goLive.id] });
    assert.equal(ended.status, 201);
    // go_live is both the named cause and the chain predecessor — once.
    assert.deepEqual(ended.body.event.causedBy, [goLive.id]);

    const trace = await (await fetch(`${stack.base}/studio/events/${ended.body.event.id}/trace`)).json();
    assert.equal(trace.event.id, ended.body.event.id);
    // Transitive causes, nearest first: go_live, then the source_added before it.
    assert.deepEqual(trace.causes.map((c) => c.kind), ["go_live", "source_added"]);
    assert.deepEqual(trace.effects, []);

    const upstream = await (await fetch(`${stack.base}/studio/events/${goLive.id}/trace`)).json();
    assert.deepEqual(upstream.effects.map((e) => e.id), [ended.body.event.id], "effects come from the store's inbound edges");
  });

  it("lists newest first, bounded, without scanning", async () => {
    const list = await (await fetch(`${stack.base}/studio/events?workspaceId=${WS}&limit=2`)).json();
    assert.equal(list.events.length, 2);
    assert.deepEqual(list.events.map((e) => e.kind), ["stream_ended", "go_live"]);
    assert.equal(list.receipt.verified, true);
    const other = await (await fetch(`${stack.base}/studio/events?workspaceId=ws-other`)).json();
    assert.deepEqual(other.events, [], "workspaces do not see each other's chains");
  });

  it("refuses a cause that does not exist, and an unknown kind", async () => {
    const bad = await post(stack.base, { workspaceId: WS, kind: "go_live", causedBy: ["ev_nope"] });
    assert.equal(bad.status, 404);
    assert.deepEqual(bad.body.missing, ["ev_nope"]);
    const kind = await post(stack.base, { workspaceId: WS, kind: "dance" });
    assert.equal(kind.status, 400);
    const missingWs = await fetch(`${stack.base}/studio/events`);
    assert.equal(missingWs.status, 400);
  });

  it("saving a scene versions it and records a scene_saved event chained to the previous save", async () => {
    const scene1 = { id: "main", name: "Main", width: 1920, height: 1080, background: "#000", layers: [{ id: "screen" }, { id: "camera" }] };
    const s1 = await fetch(`${stack.base}/studio/scenes/${WS}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: scene1 }) });
    assert.equal(s1.status, 200);
    const b1 = await s1.json();
    assert.equal(b1.document.version, 1);
    assert.equal(b1.document.workspaceId, WS);
    assert.equal(b1.event.kind, "scene_saved");
    assert.deepEqual(b1.event.payload, { version: 1, layers: 2 });

    const s2 = await fetch(`${stack.base}/studio/scenes/${WS}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: { ...scene1, layers: [...scene1.layers, { id: "widget" }] } }) });
    const b2 = await s2.json();
    assert.equal(b2.document.version, 2);
    assert.ok(b2.event.causedBy.includes(b1.event.id), "the second save names the first save as a cause");

    const got = await (await fetch(`${stack.base}/studio/scenes/${WS}`)).json();
    assert.equal(got.version, 2);
    assert.equal(got.scene.layers.length, 3);
    assert.equal(got.lastEventId, b2.event.id);

    const none = await fetch(`${stack.base}/studio/scenes/ws-never`);
    assert.equal(none.status, 404);
  });
});
