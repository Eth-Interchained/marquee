/**
 * Browser chrome.
 *
 * Renders the live identity (workspace name, UA profile, timezone) and the
 * workspace tabs, and forwards commands to the main process. It holds no state
 * of its own — main pushes the whole picture on every change.
 */

import type { ChromeCommand, ChromeState } from "../ipc";

type ChromeApi = {
  onState(listener: (state: ChromeState) => void): void;
  send(command: ChromeCommand): void;
};

const api = (window as unknown as { uaChrome: ChromeApi }).uaChrome;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Toolbar is missing #${id}`);
  return node as T;
};

const workspaceLabel = el("workspace");
const profileLabel = el("profile");
const timezoneLabel = el("timezone");
const addressLabel = el("address");
const tabsContainer = el("tabs");
const backButton = el<HTMLButtonElement>("back");
const forwardButton = el<HTMLButtonElement>("forward");
const reloadButton = el<HTMLButtonElement>("reload");
const sidebarButton = el<HTMLButtonElement>("sidebar");

backButton.addEventListener("click", () => api.send({ kind: "tab:back" }));
forwardButton.addEventListener("click", () => api.send({ kind: "tab:forward" }));
reloadButton.addEventListener("click", () => api.send({ kind: "tab:reload" }));
sidebarButton.addEventListener("click", () => api.send({ kind: "workspace:show" }));

function renderTabs(state: ChromeState): void {
  tabsContainer.replaceChildren();

  for (const tab of state.tabs) {
    const button = document.createElement("div");
    button.className = tab.active && state.tabActive ? "tab active" : "tab";
    button.title = `${tab.workspaceName} · ${tab.url}`;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = tab.title;
    label.addEventListener("click", () => api.send({ kind: "tab:select", tabId: tab.id }));

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      api.send({ kind: "tab:close", tabId: tab.id });
    });

    button.append(label, close);
    tabsContainer.append(button);
  }
}

api.onState((state) => {
  workspaceLabel.textContent = state.workspaceName;
  profileLabel.textContent = state.profileName
    ? `${state.profileName} · ${state.profileLabel}`
    : state.profileLabel;
  timezoneLabel.textContent = state.timezone ? `· ${state.timezone}` : "";
  addressLabel.textContent = state.tabActive ? (state.address ?? "") : "";

  backButton.disabled = !state.canGoBack;
  forwardButton.disabled = !state.canGoForward;
  reloadButton.disabled = !state.tabActive;
  sidebarButton.disabled = !state.tabActive;

  renderTabs(state);
});
