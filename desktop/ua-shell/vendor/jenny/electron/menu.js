/**
 * Jenny — Native Menu Template
 */

module.exports = function createMenuTemplate(isDev, orchestrator) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: 'Jenny',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => { /* TODO: open project wizard */ },
        },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: () => { /* TODO: open directory */ },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Python',
      submenu: [
        {
          label: 'Restart Runtime',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (orchestrator) orchestrator.restart();
          },
        },
        {
          label: 'View Status',
          click: () => {
            if (orchestrator) {
              const status = orchestrator.getStatus();
              console.log('Python Status:', status);
            }
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Jenny Documentation',
          click: () => {
            require('electron').shell.openExternal('https://github.com/jenny-framework/jenny');
          },
        },
        {
          label: 'AiAssist.net',
          click: () => {
            require('electron').shell.openExternal('https://aiassist.net');
          },
        },
      ],
    },
  ];

  return template;
};
