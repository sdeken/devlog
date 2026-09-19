/**
 * Tracks which composer was focused most recently so app-level actions
 * (the Attach Image menu item) know where to insert.
 */
export type ImageSink = (files: File[]) => void

let active: ImageSink | null = null

export function setActiveComposer(sink: ImageSink | null): void {
  active = sink
}

export function clearActiveComposer(sink: ImageSink): void {
  if (active === sink) active = null
}

export function getActiveComposer(): ImageSink | null {
  return active
}
