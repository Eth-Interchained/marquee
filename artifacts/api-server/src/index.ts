import app from "./app";
import { resolveInterruptedDispatches } from "./lib/dispatch-log";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";
import { SINGLE_TENANT_ID, tenancyMode } from "./lib/tenant";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The shell always sets HOST=127.0.0.1: a process holding the publishing
// capability has no business being reachable from the LAN. The default stays
// all-interfaces only for the web development surface, where this server holds
// no such capability and may be served from another host.
const host = process.env["HOST"]?.trim() || "0.0.0.0";

app.listen(port, host, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, host }, "Server listening");

  // Anything the last run handed to the session bridge without hearing back is
  // settled as uncertain before the scheduler wakes up, so it is reported to a
  // person rather than sent again on the chance it never went out.
  if (tenancyMode() === "single") {
    const interrupted = resolveInterruptedDispatches(SINGLE_TENANT_ID);
    if (interrupted > 0) {
      logger.warn(
        { interrupted },
        "Posts were in flight when this server last stopped; marked uncertain for review rather than resent",
      );
    }
  }

  // A scheduled time is a promise to post then, so something has to be awake
  // to keep it.
  startScheduler();
});
