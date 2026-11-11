/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);

// The bookmark menu item asks Fluent for a string that a test profile does
// not load; device_sync/head.js allows the same rejection.
PromiseTestUtils.allowMatchingRejectionsGlobally(/menu-bookmark-tab/);

add_task(async function test_tidy_groups_same_site_tabs() {
  const a = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/a"
  );
  const b = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://www.example.com/b"
  );
  const lone = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.org/"
  );

  const moved = gZenWorkspaces.tidyTabs(gZenWorkspaces.activeWorkspace);

  is(moved, 2, "the two example.com tabs were moved");
  ok(a.group?.isZenFolder, "first tab is in a folder");
  is(a.group, b.group, "both tabs share the folder");
  is(a.group.label, "example.com", "the folder is named after the site");
  ok(!lone.group, "a site with one tab is left alone");

  const folder = a.group;
  BrowserTestUtils.removeTab(lone);
  await removeFolder(folder);
});

add_task(async function test_tidy_reuses_folder() {
  const a = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/1"
  );
  const b = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/2"
  );
  gZenWorkspaces.tidyTabs(gZenWorkspaces.activeWorkspace);
  const folder = a.group;

  const c = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/3"
  );
  gZenWorkspaces.tidyTabs(gZenWorkspaces.activeWorkspace);

  is(c.group, folder, "a single new tab joins the existing folder");
  is(b.group, folder, "old tabs stay in it");
  await removeFolder(folder);
});

async function removeFolder(folder) {
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
}
