/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PREF_ENABLED = "zen.tabs.auto-archive.enabled";
const PREF_AFTER_HOURS = "zen.tabs.auto-archive.after-hours";
const PREF_UNLOAD_MINUTES = "zen.tabs.auto-archive.unload-after-minutes";
const PREF_INTERVAL_MINUTES = "zen.tabs.auto-archive.check-interval-minutes";
const PREF_RECORD_CLOSED = "zen.tabs.archive.record-closed-tabs";
const PREF_MAX_ENTRIES = "zen.tabs.archive.max-entries";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The tab archive (Arc-style).
 *
 * Unpinned tabs that nobody looked at for a while are closed and kept in a
 * small archive in the profile, so they can be found again from the URL bar
 * (see ZenUBArchiveProvider). Tabs closed by hand can be kept there too.
 *
 * Pinned tabs, Essentials, tabs in folders or split views, the selected tab,
 * tabs playing audio and pages with a beforeunload handler (unsaved forms,
 * editors) are never archived automatically.
 */
class nsZenTabArchive {
  #file = null;
  #loaded = null;
  #saveFilename = "zen-tab-archive.jsonlz4";
  // Tabs being closed by #archiveTabs, so the TabClose listener does not log
  // them twice.
  #closingByArchive = new WeakSet();

  constructor() {
    this.#loaded = this.#readFromDisk();
  }

  /**
   * Auto invoked for every window on delayed startup.
   *
   * @param {Window} window - The browser window that just started up
   */
  onDelayedBrowserStartup(window) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) {
      return;
    }

    window.gBrowser.tabContainer.addEventListener("TabClose", event =>
      this.#onTabClose(event, window)
    );

    const intervalMinutes = Math.max(
      1,
      Services.prefs.getIntPref(PREF_INTERVAL_MINUTES, 10)
    );
    const timer = window.setInterval(
      () => this.sweep(window),
      intervalMinutes * MINUTE_MS
    );
    window.addEventListener("unload", () => window.clearInterval(timer), {
      once: true,
    });
  }

  /**
   * Whether a tab can be archived or unloaded without the user asking.
   *
   * @param {Element} tab - The tab
   * @param {Window} window - The tab's window
   * @returns {boolean} True when the tab may be touched automatically
   */
  isEligible(tab, window) {
    return !(
      tab.pinned ||
      tab.closing ||
      tab.selected ||
      tab.multiselected ||
      tab.group ||
      tab.splitView ||
      tab.soundPlaying ||
      tab.hasAttribute("zen-essential") ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-glance-tab") ||
      tab.linkedBrowser?.hasBeforeUnload ||
      !this.#isWebUrl(this.#tabUrl(tab)) ||
      tab === window.gBrowser.selectedTab
    );
  }

  /**
   * Archives and unloads idle tabs in a window. Runs on a timer; also
   * callable from tests with a fake "now".
   *
   * @param {Window} window - The browser window
   * @param {number} [now] - The current time in ms
   * @returns {Promise<{archived: number, unloaded: number}>} What was done
   */
  async sweep(window, now = Date.now()) {
    const result = { archived: 0, unloaded: 0 };
    if (
      !Services.prefs.getBoolPref(PREF_ENABLED, false) ||
      window.closed ||
      !window.gZenWorkspaces
    ) {
      return result;
    }

    const afterHours = Services.prefs.getIntPref(PREF_AFTER_HOURS, 12);
    const unloadMinutes = Services.prefs.getIntPref(PREF_UNLOAD_MINUTES, 0);
    const tabs = window.gZenWorkspaces.allStoredTabs.filter(tab =>
      this.isEligible(tab, window)
    );

    if (afterHours > 0) {
      const toArchive = tabs.filter(
        tab => now - tab.lastAccessed >= afterHours * HOUR_MS
      );
      if (toArchive.length) {
        await this.#archiveTabs(toArchive, window, "idle", now);
        result.archived = toArchive.length;
      }
    }

    if (unloadMinutes > 0) {
      const toUnload = tabs.filter(
        tab =>
          !tab.closing &&
          !tab.hasAttribute("pending") &&
          now - tab.lastAccessed >= unloadMinutes * MINUTE_MS
      );
      if (toUnload.length) {
        await window.gBrowser.explicitUnloadTabs(toUnload);
        result.unloaded = toUnload.length;
      }
    }

    return result;
  }

  /**
   * All archived entries, newest first.
   *
   * @returns {Promise<Array<object>>} The entries
   */
  async getEntries() {
    await this.#loaded;
    return [...this.#file.data.entries];
  }

  /**
   * Removes everything from the archive.
   */
  async clear() {
    await this.#loaded;
    this.#file.data.entries = [];
    this.#file.saveSoon();
  }

  /**
   * Opens an archived entry again, in the space it was archived from when
   * that space still exists, and removes it from the archive.
   *
   * @param {object} entry - An entry from getEntries()
   * @param {Window} window - The browser window to open it in
   * @returns {Promise<Element>} The new tab
   */
  async reopen(entry, window) {
    await this.#loaded;
    const workspaces = window.gZenWorkspaces;
    const space = entry.workspaceId
      ? workspaces?.getWorkspaceFromId(entry.workspaceId)
      : null;
    if (space && workspaces.activeWorkspace !== space.uuid) {
      await workspaces.changeWorkspace(space);
    }
    const tab = window.gBrowser.addTrustedTab(entry.url, {
      userContextId: entry.userContextId || 0,
      skipRoute: true,
    });
    if (space) {
      workspaces.moveTabToWorkspace(tab, space.uuid);
    }
    window.gBrowser.selectedTab = tab;
    this.#file.data.entries = this.#file.data.entries.filter(
      e => e.id !== entry.id
    );
    this.#file.saveSoon();
    return tab;
  }

  async #archiveTabs(tabs, window, reason, now) {
    await this.#loaded;
    for (const tab of tabs) {
      this.#closingByArchive.add(tab);
      this.#addEntry(this.#entryForTab(tab, reason, now));
    }
    window.gBrowser.removeTabs(tabs, {
      closeWindowWithLastTab: false,
      animate: false,
    });
  }

  #onTabClose(event, window) {
    const tab = event.target;
    if (this.#closingByArchive.has(tab)) {
      return;
    }
    if (
      !Services.prefs.getBoolPref(PREF_RECORD_CLOSED, true) ||
      event.detail?.adoptedBy ||
      window.closed ||
      tab.hasAttribute("zen-empty-tab") ||
      !this.#isWebUrl(this.#tabUrl(tab))
    ) {
      return;
    }
    this.#addEntry(this.#entryForTab(tab, "closed", Date.now()));
  }

  #entryForTab(tab, reason, now) {
    const url = this.#tabUrl(tab);
    return {
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      url,
      title: tab.zenStaticLabel || tab.label || url,
      icon: tab.getAttribute("image") || "",
      workspaceId: tab.getAttribute("zen-workspace-id") || "",
      userContextId: tab.userContextId || 0,
      archivedAt: now,
      lastAccessed: tab.lastAccessed || now,
      reason,
    };
  }

  #addEntry(entry) {
    if (!this.#file) {
      return;
    }
    const max = Math.max(1, Services.prefs.getIntPref(PREF_MAX_ENTRIES, 500));
    // One entry per URL and space: the newest one wins.
    const entries = this.#file.data.entries.filter(
      e => !(e.url === entry.url && e.workspaceId === entry.workspaceId)
    );
    entries.unshift(entry);
    this.#file.data.entries = entries.slice(0, max);
    this.#file.saveSoon();
  }

  #tabUrl(tab) {
    // Pending (unloaded) tabs report about:blank; their real URL is in the
    // session store.
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (spec && spec !== "about:blank") {
      return spec;
    }
    try {
      const state = JSON.parse(
        tab.ownerGlobal.SessionStore.getTabState(tab) || "{}"
      );
      const entry = state.entries?.[(state.index || 1) - 1];
      return entry?.url || spec || "";
    } catch {
      return spec || "";
    }
  }

  #isWebUrl(url) {
    return /^https?:\/\//i.test(url || "");
  }

  async #readFromDisk() {
    this.#file = new JSONFile({
      path: PathUtils.join(PathUtils.profileDir, this.#saveFilename),
      compression: "lz4",
      dataPostProcessor(data) {
        if (!data || typeof data !== "object") {
          data = {};
        }
        if (!Array.isArray(data.entries)) {
          data.entries = [];
        }
        return data;
      },
    });
    await this.#file.load();
  }
}

export const gZenTabArchive = new nsZenTabArchive();
