/** IPC channel names. Kept in one place so main, preload and renderer agree. */
export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // repository lifecycle
  repoInfo: 'repo:info',
  repoChooseDirectory: 'repo:chooseDirectory',
  repoInspectWorkingCopy: 'repo:inspectWorkingCopy',
  repoImportHistory: 'repo:importHistory',
  repoOpen: 'repo:open',
  repoCreate: 'repo:create',
  repoSetRemote: 'repo:setRemote',
  repoRevealInFinder: 'repo:reveal',
  repoClose: 'repo:close',
  // canvases
  canvasesList: 'canvases:list',
  canvasGet: 'canvas:get',
  canvasCreate: 'canvas:create',
  canvasUpdate: 'canvas:update',
  canvasDelete: 'canvas:delete',
  canvasArchive: 'canvas:archive',
  surfaceSet: 'surface:set',
  surfaceAssetSave: 'surface:assetSave',
  // blocks
  daysList: 'days:list',
  dayGet: 'day:get',
  timelineGet: 'timeline:get',
  rangeGet: 'range:get',
  entryAdd: 'entry:add',
  entryUpdate: 'entry:update',
  entryDelete: 'entry:delete',
  entryMove: 'entry:move',
  entryPromote: 'entry:promote',
  entryHide: 'entry:hide',
  entryReorder: 'entry:reorder',
  entrySearch: 'entry:search',
  assetSave: 'asset:save',
  // activity / tracker
  activityRange: 'activity:range',
  activityExclude: 'activity:exclude',
  activityRestore: 'activity:restore',
  trackerStatus: 'tracker:status',
  trackerSetTask: 'tracker:setTask',
  // updates
  updateStatus: 'updates:status',
  updateCheck: 'updates:check',
  updateInstall: 'updates:install',
  editorBusy: 'editor:busy',
  // sync
  syncNow: 'sync:now',
  syncStatus: 'sync:status',
  // shell / window
  openExternal: 'shell:openExternal',
  menuPopup: 'window:menuPopup',
  windowControl: 'window:control',
  // main -> renderer events
  evSyncStatus: 'ev:syncStatus',
  evEntriesChanged: 'ev:entriesChanged',
  evRepoChanged: 'ev:repoChanged',
  evMenu: 'ev:menu',
  evAttachImages: 'ev:attachImages',
  evTrackerStatus: 'ev:trackerStatus',
  evUpdateStatus: 'ev:updateStatus'
} as const

export type MenuCommand = 'openSettings' | 'focusComposer' | 'search' | 'syncNow' | 'newCanvas' | 'review' | 'summary' | 'switcher' | 'timeline' | 'stopTask'
