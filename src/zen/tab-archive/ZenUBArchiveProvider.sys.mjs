/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarProviderOpenTabs:
    "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs",
  gZenTabArchive: "resource:///modules/zen/tabarchive/ZenTabArchive.sys.mjs",
});

const MAX_RESULTS = 3;

/**
 * Shows archived tabs that match what was typed, below open tabs, so a tab
 * that archived itself can be found again from the URL bar.
 */
export class ZenUrlbarProviderArchive extends UrlbarProvider {
  get name() {
    return "ZenUrlbarProviderArchive";
  }

  /**
   * @returns {Values<typeof UrlbarShared.PROVIDER_TYPE>}
   */
  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext) {
    return (
      !queryContext.isPrivate &&
      !!queryContext.tokens.length &&
      queryContext.sources.includes(UrlbarShared.RESULT_SOURCE.HISTORY) &&
      lazy.UrlbarPrefs.get("suggest.history")
    );
  }

  async startQuery(queryContext, addCallback) {
    const tokens = queryContext.tokens.map(t => t.lowerCaseValue);
    const openTabUrls = lazy.UrlbarProviderOpenTabs.getOpenTabUrls();
    const entries = await lazy.gZenTabArchive.getEntries();
    let added = 0;
    for (const entry of entries) {
      const haystack = `${entry.title} ${entry.url}`.toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) {
        continue;
      }
      // An archived page that is open again is already offered as a tab.
      if (openTabUrls.has(entry.url)) {
        continue;
      }
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.URL,
          source: UrlbarShared.RESULT_SOURCE.HISTORY,
          payload: {
            url: entry.url,
            title: entry.title,
            icon: entry.icon || UrlbarShared.getIconForUrl(entry.url),
          },
          highlights: {
            url: UrlbarShared.HIGHLIGHT.TYPED,
            title: UrlbarShared.HIGHLIGHT.TYPED,
          },
        })
      );
      if (++added >= Math.min(MAX_RESULTS, queryContext.maxResults)) {
        return;
      }
    }
  }
}
