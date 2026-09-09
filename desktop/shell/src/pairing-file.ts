/**
 * Writing the bridge pairing file.
 *
 * The file holds the capability that publishes through the operator's live,
 * signed-in sessions, so it is written the way a private key would be: created
 * exclusively (never onto an existing path, never through a symlink), owner-only
 * from the moment it exists, and verified afterwards. `writeFileSync` with a
 * `mode` is not enough — the mode applies only when the file is created, so an
 * attacker-planted file or symlink would keep its own permissions and target.
 */

import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";

export type PairingPayload = {
  url: string;
  token: string;
  pid: number;
};

export class PairingFileError extends Error {}

/**
 * Writes the pairing file at `file`, failing rather than reusing anything that
 * is already there.
 *
 * @throws PairingFileError when the path exists, is a symlink, or cannot be
 *   made owner-only — every one of which would leak the capability.
 */
export function writePairingFileAt(file: string, payload: PairingPayload): void {
  let fd: number;
  try {
    // O_EXCL fails on an existing path and refuses to follow a final symlink,
    // so a planted file or link is an error rather than a silent leak.
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new PairingFileError(
        `${file} already exists. The pairing file carries a live publishing capability, so it is never written onto an existing path — delete it first, or point MARQUEE_SHELL_PAIRING_FILE somewhere new.`,
      );
    }
    throw new PairingFileError(
      `Could not create ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    // Belt and braces: a permissive umask cannot widen the mode, and we check
    // what actually landed on disk rather than trusting the create flags.
    fchmodSync(fd, 0o600);
    const stats = fstatSync(fd);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      throw new PairingFileError(
        `${file} ended up with mode ${mode.toString(8)} instead of 600; refusing to write a publishing capability into it.`,
      );
    }
    if (!stats.isFile()) {
      throw new PairingFileError(`${file} is not a regular file.`);
    }

    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}
