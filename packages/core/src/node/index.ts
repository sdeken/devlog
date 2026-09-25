/**
 * @devlog/core/node — everything that reads or writes a devlog repository on
 * disk. Applications must go through these classes rather than touching the
 * repository's files themselves.
 */
export { DevlogStore } from './store'
export { SyncManager, type SyncOptions } from './sync'
export { ActivityLog, ACTIVITY_DIR, LEGACY_MACHINE, datesBetween, machineFolder } from './activityLog'
export {
  migrateRepository,
  upgradeRepository,
  type UpgradeResult,
  needsMigration,
  readStorageFormat,
  recoverInterruptedMigration,
  migratedCanvasId,
  STAGE_DIR,
  OLD_DIR,
  type MigrationReport
} from './migrate'
export { RepoIndex, INDEX_SCHEMA, classifyPath, type RefreshReport } from './repoIndex'
