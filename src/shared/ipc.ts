/** IPC channel names. Kept in one place so main, preload and renderer agree. */
export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // repository lifecycle
  repoInfo: 'repo:info',
  repoChooseDirectory: 'repo:chooseDirectory',
  repoOpen: 'repo:open',
  repoCreate: 'repo:create',
  repoSetRemote: 'repo:setRemote',
  repoRevealInFinder: 'repo:reveal',
  repoClose: 'repo:close',
  // pages
  pagesList: 'pages:list',
  pageCreate: 'page:create',
  pageUpdate: 'page:update',
  pageDelete: 'page:delete',
  pageArchive: 'page:archive',
  categoryArchive: 'category:archive',
  wikiGet: 'wiki:get',
  wikiSet: 'wiki:set',
  wikiAssetSave: 'wiki:assetSave',
  wikisList: 'wikis:list',
  // entries
  daysList: 'days:list',
  dayGet: 'day:get',
  timelineGet: 'timeline:get',
  rangeGet: 'range:get',
  entryAdd: 'entry:add',
  entryUpdate: 'entry:update',
  entryDelete: 'entry:delete',
  entryMove: 'entry:move',
  entrySearch: 'entry:search',
  assetSave: 'asset:save',
  // activity / tracker
  activityRange: 'activity:range',
  trackerStatus: 'tracker:status',
  trackerSetTask: 'tracker:setTask',
  // updates
  updateStatus: 'updates:status',
  updateCheck: 'updates:check',
  editorBusy: 'editor:busy',
  // sync
  syncNow: 'sync:now',
  syncStatus: 'sync:status',
  // shell
  openExternal: 'shell:openExternal',
  // main -> renderer events
  evSyncStatus: 'ev:syncStatus',
  evEntriesChanged: 'ev:entriesChanged',
  evRepoChanged: 'ev:repoChanged',
  evMenu: 'ev:menu',
  evAttachImages: 'ev:attachImages',
  evTrackerStatus: 'ev:trackerStatus',
  evUpdateStatus: 'ev:updateStatus'
} as const

export type MenuCommand = 'openSettings' | 'focusComposer' | 'search' | 'syncNow' | 'newPage' | 'review' | 'summary' | 'switcher' | 'timeline' | 'stopTask'
