import type { WebContents } from "electron";

/**
 * Runs a function inside a page and returns its result.
 *
 * The function is serialized, so it must not reference anything outside its own
 * arguments — pass selectors and text in explicitly.
 */
export async function runInPage<R>(
  contents: WebContents,
  fn: (...args: never[]) => R,
  ...args: unknown[]
): Promise<R> {
  const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(",");
  const source = `(${fn.toString()})(${serializedArgs})`;
  return (await contents.executeJavaScript(source, true)) as R;
}
