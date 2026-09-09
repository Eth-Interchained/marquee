/**
 * User-Agent parsing and Client Hints derivation.
 *
 * A UA override is only useful when everything that describes the browser
 * agrees with it. A Chrome 131 User-Agent string paired with the shell's own
 * `Sec-CH-UA` brands, or with a `navigator.userAgentData` that still reports
 * the real Chromium build, is *more* identifying than no override at all.
 *
 * So: every hint the shell emits is derived from the UA string itself, and a
 * UA string that is not Chromium gets no `Sec-CH-UA*` headers whatsoever —
 * Safari and Firefox do not send them, and inventing them would be a tell.
 *
 * This module is pure so it can be tested without Electron.
 */

export type BrandVersion = { brand: string; version: string };

/** Shape accepted by CDP `Emulation.setUserAgentOverride.userAgentMetadata`. */
export type UserAgentMetadata = {
  brands: BrandVersion[];
  fullVersionList: BrandVersion[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
};

export type UserAgentEngine = "chromium" | "gecko" | "webkit" | "unknown";

export type UserAgentSummary = {
  engine: UserAgentEngine;
  /** Brand as a site would name it: "Google Chrome", "Microsoft Edge", ... */
  brand: string;
  /** Short label for humans: "Chrome", "Safari", ... */
  browser: string;
  fullVersion: string;
  majorVersion: string;
  /** Chrome's `Sec-CH-UA-Platform` vocabulary: macOS, Windows, Linux, ... */
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
};

/**
 * Chrome pads its brand list with a deliberately meaningless entry so that
 * sites cannot hard-code the list. Ours is stable per shell build rather than
 * randomised per launch: a value that changes between requests would itself be
 * a fingerprint.
 */
const GREASE_BRAND = "Not_A Brand";
const GREASE_VERSION = "24";

function match(ua: string, pattern: RegExp): string | null {
  const found = ua.match(pattern);
  return found?.[1] ?? null;
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

function normalizeVersion(raw: string, parts: number): string {
  const segments = raw.split(/[._]/).filter((part) => part !== "");
  while (segments.length < parts) segments.push("0");
  return segments.slice(0, parts).join(".");
}

function readPlatform(ua: string): {
  platform: string;
  platformVersion: string;
  mobile: boolean;
  model: string;
} {
  const android = match(ua, /Android (\d+(?:\.\d+)*)/);
  if (android) {
    // "; SM-G991B)" or "; Pixel 8 Build/..." — the model is the last field of
    // the platform token, when the UA carries one at all.
    const model =
      match(ua, /;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\)/) ?? "";
    return {
      platform: "Android",
      platformVersion: normalizeVersion(android, 3),
      mobile: true,
      model: model.trim(),
    };
  }

  const ios = match(ua, /(?:iPhone|iPad|iPod)[^)]*OS (\d+(?:[._]\d+)*)/);
  if (ios) {
    return {
      platform: /iPad/.test(ua) ? "iPadOS" : "iOS",
      platformVersion: normalizeVersion(ios, 3),
      mobile: true,
      model: "",
    };
  }

  const mac = match(ua, /Mac OS X (\d+(?:[._]\d+)*)/);
  if (mac || /Macintosh/.test(ua)) {
    return {
      platform: "macOS",
      // Chrome freezes the UA at 10_15_7 while the hint reports the real
      // version. We only know what the UA says, so we report exactly that
      // rather than inventing a plausible-looking number.
      platformVersion: mac ? normalizeVersion(mac, 3) : "10.15.7",
      mobile: false,
      model: "",
    };
  }

  const windows = match(ua, /Windows NT (\d+(?:\.\d+)*)/);
  if (windows) {
    return {
      platform: "Windows",
      // Windows 10 and 11 share "NT 10.0" in the UA, so the UA cannot tell
      // them apart; the hint follows the UA rather than guessing.
      platformVersion: normalizeVersion(windows, 3),
      mobile: false,
      model: "",
    };
  }

  if (/CrOS/.test(ua)) {
    return {
      platform: "Chrome OS",
      platformVersion: normalizeVersion(match(ua, /CrOS \S+ (\d+(?:\.\d+)*)/) ?? "0", 3),
      mobile: false,
      model: "",
    };
  }

  if (/Linux|X11/.test(ua)) {
    return { platform: "Linux", platformVersion: "0.0.0", mobile: false, model: "" };
  }

  return { platform: "Unknown", platformVersion: "0.0.0", mobile: false, model: "" };
}

function readArchitecture(ua: string, platform: string): { architecture: string; bitness: string } {
  if (/arm64|aarch64|armv8/i.test(ua)) return { architecture: "arm", bitness: "64" };
  if (platform === "Android" || platform === "iOS" || platform === "iPadOS") {
    return { architecture: "arm", bitness: "64" };
  }
  if (/WOW64|Win64|x86_64|x64|Intel/i.test(ua)) return { architecture: "x86", bitness: "64" };
  if (/i686|i386|x86/i.test(ua)) return { architecture: "x86", bitness: "32" };
  return { architecture: "", bitness: "" };
}

export function summarizeUserAgent(ua: string): UserAgentSummary {
  const platformInfo = readPlatform(ua);
  const architecture = readArchitecture(ua, platformInfo.platform);

  const base = {
    ...platformInfo,
    ...architecture,
    mobile: platformInfo.mobile || /\bMobile\b/.test(ua),
  };

  const edge = match(ua, /Edg(?:e|A|iOS)?\/(\d+(?:\.\d+)*)/);
  const opera = match(ua, /OPR\/(\d+(?:\.\d+)*)/);
  const chrome = match(ua, /(?:Chrome|CriOS|HeadlessChrome)\/(\d+(?:\.\d+)*)/);
  const firefox = match(ua, /(?:Firefox|FxiOS)\/(\d+(?:\.\d+)*)/);
  const safari = match(ua, /Version\/(\d+(?:\.\d+)*) (?:Mobile\/\S+ )?Safari/);

  if (edge || opera || chrome) {
    const brandVersion = edge ?? opera ?? chrome ?? "0";
    const chromiumVersion = chrome ?? brandVersion;
    return {
      ...base,
      engine: "chromium",
      brand: edge ? "Microsoft Edge" : opera ? "Opera" : "Google Chrome",
      browser: edge ? "Edge" : opera ? "Opera" : "Chrome",
      fullVersion: normalizeVersion(chromiumVersion, 4),
      majorVersion: majorOf(brandVersion),
    };
  }

  if (firefox) {
    return {
      ...base,
      engine: "gecko",
      brand: "Firefox",
      browser: "Firefox",
      fullVersion: normalizeVersion(firefox, 4),
      majorVersion: majorOf(firefox),
    };
  }

  if (safari) {
    return {
      ...base,
      engine: "webkit",
      brand: "Safari",
      browser: "Safari",
      fullVersion: normalizeVersion(safari, 4),
      majorVersion: majorOf(safari),
    };
  }

  return {
    ...base,
    engine: "unknown",
    brand: "",
    browser: "Unknown browser",
    fullVersion: "0.0.0.0",
    majorVersion: "0",
  };
}

/**
 * Client Hints metadata for a UA string, or `null` when the UA describes a
 * browser that does not implement Client Hints. `null` means: send no
 * `Sec-CH-UA*` headers and leave `navigator.userAgentData` undefined.
 */
export function clientHintsFor(ua: string): UserAgentMetadata | null {
  const summary = summarizeUserAgent(ua);
  if (summary.engine !== "chromium") return null;

  const brands: BrandVersion[] = [
    { brand: GREASE_BRAND, version: GREASE_VERSION },
    { brand: "Chromium", version: summary.majorVersion },
  ];
  const fullVersionList: BrandVersion[] = [
    { brand: GREASE_BRAND, version: `${GREASE_VERSION}.0.0.0` },
    { brand: "Chromium", version: summary.fullVersion },
  ];

  if (summary.brand && summary.brand !== "Chromium") {
    brands.push({ brand: summary.brand, version: summary.majorVersion });
    fullVersionList.push({ brand: summary.brand, version: summary.fullVersion });
  }

  return {
    brands,
    fullVersionList,
    fullVersion: summary.fullVersion,
    platform: summary.platform,
    platformVersion: summary.platformVersion,
    architecture: summary.architecture,
    bitness: summary.bitness,
    model: summary.model,
    mobile: summary.mobile,
  };
}

function serializeBrands(brands: BrandVersion[]): string {
  return brands.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(", ");
}

/**
 * The three hints Chrome sends on every request without being asked. The
 * high-entropy ones (architecture, model, full version list, platform
 * version) are only delivered when a site requests them, and the CDP
 * `userAgentMetadata` above answers those.
 */
export function lowEntropyHintHeaders(
  metadata: UserAgentMetadata | null,
): Record<string, string> {
  if (!metadata) return {};
  return {
    "Sec-CH-UA": serializeBrands(metadata.brands),
    "Sec-CH-UA-Mobile": metadata.mobile ? "?1" : "?0",
    "Sec-CH-UA-Platform": `"${metadata.platform}"`,
  };
}

/** Short toolbar label, e.g. "Chrome 131 · macOS". */
export function describeUserAgent(ua: string): string {
  const summary = summarizeUserAgent(ua);
  if (summary.engine === "unknown") return "Unrecognised UA";
  const platform = summary.platform === "Unknown" ? "" : ` · ${summary.platform}`;
  return `${summary.browser} ${summary.majorVersion}${platform}`;
}
