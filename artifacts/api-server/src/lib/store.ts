import path from "node:path";
import { mkdirSync } from "node:fs";
import { NedbCore } from "nedb-engine";

/**
 * The one open handle on the local store.
 *
 * Several collections live in the same durable directory (the browser state
 * document, the publish dispatch log). Opening the directory twice would give
 * two engines writing the same DAG, so every module shares this handle.
 */

export const dataDirectory =
  process.env.NEDB_DATA_DIR ??
  path.join(process.cwd(), ".data", "marquee");

mkdirSync(dataDirectory, { recursive: true });

export const db = NedbCore.open(dataDirectory);

export function getStoreHealth() {
  return {
    verified: db.verify(),
    sequence: Number(db.seq()),
    head: db.head(),
    dataDirectory,
  };
}
