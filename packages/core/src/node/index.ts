/**
 * @devlog/core/node — everything that reads or writes a devlog repository on
 * disk. Applications must go through these classes rather than touching the
 * repository's files themselves.
 */
export { DevlogStore, type CompactionReport } from './store'
export { SyncManager, type SyncOptions } from './sync'
export { ActivityLog, ACTIVITY_DIR, LEGACY_MACHINE, datesBetween, machineFolder } from './activityLog'
export {
  readStorageFormat,
  assertSupportedFormat,
  readManifest,
  updateManifest,
  readLockFile,
  writeLockFile,
  type DevlogManifest,
  type LockEntry,
  type LockFile
} from './manifest'
export { ExtensionFileStore, type ExtensionFileInfo, type ExtensionFileLimits } from './extensionFiles'
export { ensureExtensionAttributes } from './repoFiles'
export { RepoIndex, INDEX_SCHEMA, classifyPath, type RefreshReport } from './repoIndex'
