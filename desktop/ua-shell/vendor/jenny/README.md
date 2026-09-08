# vendor/jenny — copied VERBATIM, do not edit

Source: `https://github.com/aiassistsecure/_Gex` branch `jenny` (checkpoint `af7fa0f`), directory `core/`.

Mark's rule (2026-09-08): "extract the code verbatim from jenny — I went through all the stages of
errors and this jenny repo is stable." So these files are byte-for-byte copies. Security and shell
integration are ADDED AROUND them in `../../src/python-runtime.ts`, never edited into them.

Pinned sha256 (verify with `sha256sum orchestrator/*.js electron/*.js`):

```
a495424b68f715bcd3bc3a3d2aaff929f9c730b4ecdf56b2f7f297b616fa6ac6  orchestrator/health-monitor.js
6c01926057f2df22d2dd57c5f0fae5e96f4d9a099c0772bf2b67dc20352e08dc  orchestrator/index.js
ae1a85060b6faa3a2334a4a8b07df09278f8e8b7d84fa42aa8615eef1d6ef272  orchestrator/log-aggregator.js
faa8cd2010113f471214556e8b9ae1d3f835551e04041f259cb038506b8e4e88  orchestrator/process-manager.js
ca459b5bcdea081501967372084c514fbb6e0b94d820869b86971674dbfc9663  electron/main.js
0960be7a771dd1188cbcc57cd0d6498e15440a3f93c44a7afd5e87c5fdb2c041  electron/menu.js
a5c7b2d5769a5b377cdda8ed2edef3b1985055d59bf88cd67044d81a4f5b51a3  electron/preload.js
```

Only `orchestrator/` is imported by the shell. `electron/` is kept as the reference wiring
(IPC channel names, preload whitelist pattern). `orchestrator/index.d.ts` is OURS — a type
declaration next to the untouched JavaScript so TypeScript can import it.
