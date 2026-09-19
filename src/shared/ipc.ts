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
  // entries
  daysList: 'days:list',
  dayGet: 'day:get',
  entryAdd: 'entry:add',
  entryUpdate: 'entry:update',
  entryDelete: 'entry:delete',
  entrySearch: 'entry:search',
  assetSave: 'asset:save',
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
  evAttachImages: 'ev:attachImages'
} as const

export type MenuCommand = 'openSettings' | 'focusComposer' | 'search' | 'syncNow'
