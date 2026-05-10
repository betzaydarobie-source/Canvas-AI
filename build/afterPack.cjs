// electron-builder afterPack hook
// 给 macOS .app 做 ad-hoc 签名（codesign -s -）
// 好处：
//   1. 签名过的 app 被 Gatekeeper 拦时，提示从"已损坏"变成"身份不明的开发者，是否打开"
//      —— 用户右键 → 打开 → 确认，就能用（未签名的根本没这个选项）
//   2. Apple Silicon 上，未签名的 arm64 app 会被直接 SIGKILL，ad-hoc 签名保证能跑
//   3. 不花钱（无需 Apple Developer $99/年）
//
// 用户安装后如果仍看到"已损坏"，说明 quarantine 属性导致，需执行：
//   sudo xattr -rd com.apple.quarantine /Applications/无限画布.app
// 这条命令附在随附的说明里即可。

const { execSync } = require('child_process');
const path = require('path');

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[ad-hoc sign] target: ${appPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'inherit' }
    );
    // 验证
    execSync(`codesign --verify --verbose "${appPath}"`, { stdio: 'inherit' });
    console.log('[ad-hoc sign] ok');
  } catch (e) {
    console.error('[ad-hoc sign] failed:', e.message);
    throw e;
  }
};
