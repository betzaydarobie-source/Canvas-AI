// Electron 主进程 — 启动内嵌 HTTP 代理，然后开窗加载它
import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverInstance = null;

// 固定端口，这样 localStorage 的 origin 跨进程保持一致
// 万一被占用才回退到动态端口（此时 localStorage 会丢，但至少能启动）
const PREFERRED_PORT = 37923;

async function bootServer() {
  try {
    let result;
    try {
      result = await startServer(PREFERRED_PORT, '127.0.0.1');
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.warn(`端口 ${PREFERRED_PORT} 被占用，回退到动态端口（设置会在本次会话后丢失）`);
        result = await startServer(0, '127.0.0.1');
      } else {
        throw err;
      }
    }
    serverInstance = result.server;
    return result.port;
  } catch (err) {
    dialog.showErrorBox('启动失败', `内嵌服务无法启动:\n${err.message}`);
    app.quit();
    throw err;
  }
}

async function createWindow() {
  const port = await bootServer();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '无限画布',
    backgroundColor: '#f5eedc',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接用系统浏览器打开（而不是在应用内新开窗口）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 拦截导航到外部地址
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    // Windows / Linux 隐藏菜单栏
    Menu.setApplicationMenu(null);
    return;
  }

  // macOS 需要一个最小菜单才能让 Cmd+C / Cmd+V 之类的键生效
  const template = [
    {
      label: '无限画布',
      submenu: [
        { role: 'about', label: '关于无限画布' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏无限画布' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出无限画布' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
  }
});
