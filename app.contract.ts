import { defineApp } from "@interchained/portal-contract";

/**
 * marquee — Portal contract (schema v1)
 *
 * North Star:
 *   NEDB stores the record. Portal renders the studio. marquee puts creators live.
 *
 * Design principle (ecosystem-wide):
 *   Engine capability equals product feature.
 *   Every follow, tip, chat line, raid and scene switch is a hash-chained
 *   document. TRACE is the receipt. AS OF is VOD time-travel. verify is proof
 *   the stream's history is untampered.
 */
export default defineApp({
  name: "marquee",
  version: "0.1.0",
  description:
    "The whole broadcast studio in a browser tab. Screen, camera corner, social widgets and go-live — with every event recorded as a verifiable, time-travelable document in NEDB. Nothing rented.",
  primaryAudience: ["Gamers who stream", "Creators who go live", "Communities that want receipts for what happened on air"],
  goals: [
    "Open a URL and be live — no install, no third-party account",
    "Screen + camera corner + widgets composited in the browser, one render path for preview and output",
    "Every on-air event is a hash-chained NEDB document with provenance (caused_by)",
    "Scrub a VOD and see the overlay exactly as it was (AS OF)",
  ],
  brand: {
    voice: "backstage-crew: direct, calm under pressure, no hype",
    colors: ["#07080c", "#22d3ee", "#34d399", "#f59e0b", "#e8eaf0"],
    fonts: ["Inter", "JetBrains Mono"],
    forbiddenPhrases: ["seamless", "revolutionary", "game-changer", "world-class", "magic"],
  },
  conversion: {
    primaryGoal: "Go live",
    secondaryGoal: "Add a camera and a screen",
    successEvents: ["screen_shared", "camera_added", "mic_added", "went_live", "stream_ended"],
  },
  seo: {
    enabled: true,
    primaryKeyword: "browser streaming studio",
    titleTemplate: "%s | marquee",
    defaultDescription: "Stream from a browser tab. Screen, camera, widgets, go-live — with receipts for everything that happened on air.",
  },
});
