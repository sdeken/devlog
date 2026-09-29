/**
 * Extension commands in the app's menus, keybindings and note box (API 1.6).
 * Each command runs in its extension with a context: where it was run from,
 * and the canvas (and block) it was run on.
 */
import { createContext, useContext } from 'react'
import type { ExtensionCommand } from '@devlog/core'
import type { ExtensionInfo } from '@shared/extensions'

export interface ExtCommand extends ExtensionCommand {
  extKey: string
  extName: string
}

/** Commands of running extensions that have registered them. */
export function runningCommands(extensions: ExtensionInfo[]): ExtCommand[] {
  return extensions.flatMap((e) => (e.state === 'running' ? e.commands.filter((c) => c.ready).map((c) => ({ ...c, extKey: e.key, extName: e.displayName })) : []))
}

/** Whether a command applies on a canvas of this type (commands for a node type only there). */
export function appliesTo(cmd: { nodeType?: string }, canvasType: string | undefined): boolean {
  return !cmd.nodeType || cmd.nodeType === canvasType
}

/** A block's extension actions: its menu's commands, for the block's canvas. */
export interface BlockAction {
  key: string
  label: string
  run: (date: string, blockId: string) => void
}

export const BlockActionsContext = createContext<(canvasId: string) => BlockAction[]>(() => [])

export function useBlockActions(): (canvasId: string) => BlockAction[] {
  return useContext(BlockActionsContext)
}
