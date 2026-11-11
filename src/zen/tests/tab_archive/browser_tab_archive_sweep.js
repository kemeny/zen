/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { gZenTabArchive } = ChromeUtils.importESModule(
  "resource:///modules/zen/tabarchive/ZenTabArchive.sys.mjs"
);

const HOUR_MS = 60 * 60 * 1000;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.tabs.auto-archive.enabled", true],
      ["zen.tabs.auto-archive.after-hours", 12],
      ["zen.tabs.auto-archive.unload-after-minutes", 0],
      ["zen.tabs.archive.record-closed-tabs", true],
    ],
  });
  await gZenTabArchive.clear();
});

add_task(async function test_idle_tab_is_archived() {
  const idle = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/idle"
  );
  const keep = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/keep"
  );
  gBrowser.selectedTab = keep;

  const result = await gZenTabArchive.sweep(
    window,
    idle.lastAccessed + 13 * HOUR_MS
  );

  Assert.greaterOrEqual(result.archived, 1, "the idle tab was archived");
  ok(!idle.isConnected || idle.closing, "the idle tab is closed");
  ok(keep.isConnected && !keep.closing, "the selected tab stays open");

  const entries = await gZenTabArchive.getEntries();
  const entry = entries.find(e => e.url == "https://example.com/idle");
  ok(entry, "the idle tab is in the archive");
  is(entry.reason, "idle", "it was archived for being idle");

  BrowserTestUtils.removeTab(keep);
  await gZenTabArchive.clear();
});

add_task(async function test_recent_tab_is_kept() {
  const recent = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/recent"
  );
  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/other"
  );

  const result = await gZenTabArchive.sweep(
    window,
    recent.lastAccessed + 1 * HOUR_MS
  );

  is(result.archived, 0, "nothing is archived before the time is up");
  ok(recent.isConnected, "the recent tab stays open");

  BrowserTestUtils.removeTab(recent);
  BrowserTestUtils.removeTab(other);
  await gZenTabArchive.clear();
});

add_task(async function test_pinned_and_essential_tabs_are_never_archived() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/pinned"
  );
  gBrowser.pinTab(pinned);
  const essential = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/essential"
  );
  gZenPinnedTabManager.addToEssentials(essential);
  const selected = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/selected"
  );

  await gZenTabArchive.sweep(window, Date.now() + 48 * HOUR_MS);

  ok(pinned.isConnected, "the pinned tab stays open");
  ok(essential.isConnected, "the Essential stays open");

  BrowserTestUtils.removeTab(selected);
  BrowserTestUtils.removeTab(essential);
  BrowserTestUtils.removeTab(pinned);
  await gZenTabArchive.clear();
});

add_task(async function test_disabled_does_nothing() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.tabs.auto-archive.enabled", false]],
  });
  const idle = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/disabled"
  );
  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/disabled-other"
  );

  const result = await gZenTabArchive.sweep(
    window,
    idle.lastAccessed + 48 * HOUR_MS
  );
  is(result.archived, 0, "nothing is archived while the pref is off");
  ok(idle.isConnected, "the tab stays open");

  BrowserTestUtils.removeTab(idle);
  BrowserTestUtils.removeTab(other);
  await SpecialPowers.popPrefEnv();
  await gZenTabArchive.clear();
});

add_task(async function test_closed_tab_is_recorded() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/closed"
  );
  BrowserTestUtils.removeTab(tab);

  const entries = await gZenTabArchive.getEntries();
  const entry = entries.find(e => e.url == "https://example.com/closed");
  ok(entry, "a tab closed by hand is kept in the archive");
  is(entry.reason, "closed", "it is marked as closed by hand");
  await gZenTabArchive.clear();
});
