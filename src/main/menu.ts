import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  syncNow: () => void
  openRepo: () => void
  openSettings: () => void
  focusComposer: () => void
  search: () => void
  attachImage: () => void
  newPage: () => void
  review: () => void
  summary: () => void
  switcher: () => void
  timeline: () => void
  stopTask: () => void
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
      { label: 'New Page…', accelerator: 'CmdOrCtrl+N', click: actions.newPage },
      { label: 'Open Devlog Repository…', accelerator: 'CmdOrCtrl+O', click: actions.openRepo },
      { type: 'separator' },
      { label: 'Sync Now', accelerator: 'CmdOrCtrl+Shift+S', click: actions.syncNow },
      { label: 'Stop Active Task', accelerator: 'CmdOrCtrl+Shift+.', click: actions.stopTask },
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
      { label: 'Summary', accelerator: 'CmdOrCtrl+Shift+H', click: actions.summary },
      { label: 'Go to Page…', accelerator: 'CmdOrCtrl+P', click: actions.switcher },
      { label: 'Day Timeline', accelerator: 'CmdOrCtrl+Shift+T', click: actions.timeline },
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
