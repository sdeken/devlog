import { app, clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

export interface MenuActions {
  syncNow: () => void
  openRepo: () => void
  openSettings: () => void
  focusComposer: () => void
  search: () => void
  attachImage: () => void
  newCanvas: () => void
  review: () => void
  switcher: () => void
  timeline: () => void
  back: () => void
  forward: () => void
  quit: () => void
}

export function buildMenu(win: () => BrowserWindow | null, actions: MenuActions): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: actions.openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Canvas…', accelerator: 'CmdOrCtrl+N', click: actions.newCanvas },
      { label: 'Open Devlog Repository…', accelerator: 'CmdOrCtrl+O', click: actions.openRepo },
      { type: 'separator' },
      { label: 'Sync Now', accelerator: 'CmdOrCtrl+Shift+S', click: actions.syncNow },
      { type: 'separator' },
      ...(isMac
        ? [{ role: 'close' } as MenuItemConstructorOptions]
        : [
            { label: 'Settings…', accelerator: 'Ctrl+,', click: actions.openSettings },
            { type: 'separator' } as MenuItemConstructorOptions,
            { label: 'Quit Devlog', accelerator: 'Ctrl+Q', click: actions.quit }
          ])
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: actions.search },
      { label: 'Focus Composer', accelerator: 'CmdOrCtrl+L', click: actions.focusComposer },
      { label: 'Attach Image…', accelerator: 'CmdOrCtrl+Shift+I', click: actions.attachImage }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { label: 'Weekly Review', accelerator: 'CmdOrCtrl+Shift+R', click: actions.review },
      { label: 'Go to Canvas…', accelerator: 'CmdOrCtrl+P', click: actions.switcher },
      { label: 'Day Timeline', accelerator: 'CmdOrCtrl+Shift+T', click: actions.timeline },
      { type: 'separator' },
      // The keys are handled in the page (App.tsx) so they work inside the editor; the menu only shows them.
      { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', registerAccelerator: false, click: actions.back },
      { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', registerAccelerator: false, click: actions.forward },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  })

  template.push({
    role: 'help',
    submenu: [
      {
        label: 'Devlog on GitHub',
        click: () => void shell.openExternal('https://github.com/sdeken/devlog')
      },
      {
        label: 'Show Window',
        click: () => win()?.show()
      }
    ]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * The right-click menu for the page: copy an image (as a picture, to paste
 * into other apps), copy a link, and the usual cut, copy and paste. Empty
 * where none of them applies; the page's own menus (canvases in the sidebar,
 * breadcrumbs) cancel the event, so this never shows over them.
 */
export function contextMenuTemplate(params: ContextMenuParams, contents: WebContents): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (params.mediaType === 'image' && params.hasImageContents) {
    items.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) })
  }
  if (/^(https?|mailto):/i.test(params.linkURL)) {
    items.push({ label: params.linkURL.startsWith('mailto:') ? 'Copy Email Address' : 'Copy Link', click: () => void clipboard.writeText(params.linkURL.replace(/^mailto:/i, '')) })
  }
  const edit: MenuItemConstructorOptions[] = params.isEditable
    ? [
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      ]
    : params.selectionText.trim()
      ? [{ role: 'copy' }]
      : []
  if (items.length && edit.length) items.push({ type: 'separator' })
  return [...items, ...edit]
}

/** Show the right-click menu on a window's page. */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, win.webContents)
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
  })
}
