import net from "node:net";

/** Asks the OS for a free loopback port and hands it straight back. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Could not determine a free loopback port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHttpOk(
  url: string,
  timeoutMs: number,
  intervalMs = 200,
  headers?: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, headers ? { headers } : undefined);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}
