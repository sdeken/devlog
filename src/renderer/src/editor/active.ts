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

/**
 * The dock composer (the note box for the canvas on screen), so typing with
 * nothing focused can start a note there.
 */
export interface DockEditor {
  /** Focus the note box and type `text` at its end. */
  type(text: string): void
}

let dock: DockEditor | null = null

export function setDockEditor(editor: DockEditor): () => void {
  dock = editor
  return () => {
    if (dock === editor) dock = null
  }
}

export function getDockEditor(): DockEditor | null {
  return dock
}
