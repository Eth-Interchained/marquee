/**
 * Installs `window.uaShell` in the page's own world.
 *
 * This function is serialized and executed in the main world through
 * `contextBridge.executeInMainWorld`, so it must not reference anything outside
 * its own body.
 *
 * Why the main world at all: `attachSurface(container, options)` takes an
 * HTMLElement, and DOM nodes cannot cross the context bridge. The element is
 * measured here, in the page's world, and only plain numbers are handed to the
 * privileged side. The low-level host object is captured and then deleted from
 * `window`, so page scripts see `uaShell` and nothing else.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function installUaShellMainWorld(): boolean {
  const scope = window as any;
  const host = scope.__uaShellHost;
  if (!host) return false;
  delete scope.__uaShellHost;

  const measure = (element: any) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const uaShell = {
    version: host.version,

    async attachSurface(container: any, options: any) {
      if (!(container instanceof HTMLElement)) {
        throw new TypeError("attachSurface needs an HTMLElement to mount into.");
      }

      // The shell decides the partition and reports it back; the page cannot
      // choose which workspace's cookie jar it is looking at.
      const { id, partition } = await host.attach(options, measure(container));

      // The surface is a native view positioned over the container, so it has
      // to follow the container as the layout moves.
      const push = () => {
        void host.setBounds(id, measure(container));
      };
      const observer = new ResizeObserver(push);
      observer.observe(container);
      window.addEventListener("resize", push, true);
      window.addEventListener("scroll", push, true);

      let closed = false;
      return {
        id,
        partition,
        navigate: (url: string) => host.navigate(id, url),
        reload: () => host.reload(id),
        close: async () => {
          if (closed) return;
          closed = true;
          observer.disconnect();
          window.removeEventListener("resize", push, true);
          window.removeEventListener("scroll", push, true);
          await host.close(id);
        },
      };
    },

    openInWorkspaceTab: (workspaceId: string, url: string) =>
      host.openInWorkspaceTab(workspaceId, url),

    getSessionStatus: (workspaceId: string) => host.sessionStatus(workspaceId),

    /**
     * Studio capture. Electron has no built-in screen picker: the page lists
     * sources here, shows its own picker, tells the shell which one it chose,
     * and only THEN calls getDisplayMedia(), which the shell's display-media
     * handler resolves with that source. A getDisplayMedia() with no prior
     * selection is refused by the handler, on purpose.
     */
    studio: {
      listCaptureSources: () => host.captureSources(),
      selectCaptureSource: (selection: any) => host.captureSelect(selection),
    },
  };

  Object.freeze(uaShell);
  Object.defineProperty(window, "uaShell", {
    value: uaShell,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return true;
}
