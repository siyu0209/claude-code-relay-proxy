/**
 * Claude Code Relay Proxy - VS Code 扩展入口
 * 只在 VS Code 中生效，不修改 ~/.claude/settings.json 全局配置
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { RelayProxy } = require('./proxy');

let proxy = null;
let statusBarItem = null;
let originalEnvConfig = null;

/**
 * 扩展激活
 */
function activate(context) {
  console.log('[ClaudeCodeRelay] 扩展已激活');

  // 创建状态栏
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeCodeRelay.status';
  context.subscriptions.push(statusBarItem);

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeRelay.toggle', toggleProxy),
    vscode.commands.registerCommand('claudeCodeRelay.config', openConfig),
    vscode.commands.registerCommand('claudeCodeRelay.detect', redetect),
    vscode.commands.registerCommand('claudeCodeRelay.status', showStatus)
  );

  // 启动代理
  startProxy();

  // 监听配置变化
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeRelay')) {
        autoRestart();
      }
    })
  );
}

/**
 * 扩展停用
 */
function deactivate() {
  stopProxy();
  restoreEnvConfig();
}

/**
 * 启动代理
 */
async function startProxy() {
  const config = vscode.workspace.getConfiguration('claudeCodeRelay');
  const enabled = config.get('enabled', true);

  if (!enabled) {
    updateStatusBar('$(circle-slash) Relay 已关闭');
    return;
  }

  try {
    updateStatusBar('$(sync~spin) Relay 启动中...');

    // 获取中转站配置
    let baseUrl = config.get('targetBaseUrl', '');
    let apiKey = config.get('targetApiKey', '');
    const modelMapping = config.get('modelMapping', {});
    const port = config.get('port', 0);

    // 如果用户没配，自动从 ~/.claude/settings.json 读取
    if (!baseUrl || !apiKey) {
      const claudeSettings = readClaudeSettings();
      if (!baseUrl) baseUrl = claudeSettings.baseUrl;
      if (!apiKey) apiKey = claudeSettings.apiKey;
    }

    if (!baseUrl || !apiKey) {
      vscode.window.showWarningMessage('Claude Code Relay: 未检测到中转站配置，请在设置中填写');
      updateStatusBar('$(warning) Relay 未配置');
      return;
    }

    // 启动代理
    proxy = new RelayProxy();
    const result = await proxy.start(port, baseUrl, apiKey, modelMapping);

    // 配置 Claude Code 扩展使用本地代理
    await applyEnvConfig(result.port);

    updateStatusBar(`$(rocket) Relay :${result.port} [${result.protocol}]`);

    vscode.window.showInformationMessage(
      `Claude Code Relay 已启动 (端口 ${result.port}, 协议: ${result.protocol})`
    );

  } catch (err) {
    console.error('[ClaudeCodeRelay] 启动失败:', err);
    updateStatusBar('$(error) Relay 启动失败');
    vscode.window.showErrorMessage(`Claude Code Relay 启动失败: ${err.message}`);
  }
}

/**
 * 停止代理
 */
function stopProxy() {
  if (proxy) {
    proxy.stop();
    proxy = null;
  }
  restoreEnvConfig();
}

/**
 * 开关代理
 */
async function toggleProxy() {
  const config = vscode.workspace.getConfiguration('claudeCodeRelay');
  const current = config.get('enabled', true);
  await config.update('enabled', !current, vscode.ConfigurationTarget.Global);

  if (current) {
    stopProxy();
    updateStatusBar('$(circle-slash) Relay 已关闭');
    vscode.window.showInformationMessage('Claude Code Relay 已关闭');
  } else {
    startProxy();
  }
}

/**
 * 打开配置
 */
function openConfig() {
  vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCodeRelay');
}

/**
 * 重新检测
 */
async function redetect() {
  vscode.window.showInformationMessage('正在重新检测中转站协议...');
  await stopProxy();
  await startProxy();
}

/**
 * 显示状态
 */
function showStatus() {
  if (!proxy) {
    vscode.window.showInformationMessage('Claude Code Relay: 代理未运行');
    return;
  }

  const info = [
    `状态: 运行中`,
    `本地端口: ${proxy.port}`,
    `目标中转站: ${proxy.targetBaseUrl}`,
    `检测协议: ${proxy.protocol}`,
    `可用模型: ${proxy.availableModels.join(', ')}`,
    `模型映射: ${JSON.stringify(proxy.modelMapping)}`
  ].join('\n');

  vscode.window.showInformationMessage(info, { modal: false }, '确定');
}

/**
 * 自动重启
 */
async function autoRestart() {
  stopProxy();
  setTimeout(() => startProxy(), 500);
}

/**
 * 修改 VS Code 中的 claudeCode.environmentVariables
 * 只影响 VS Code 中的 Claude Code 扩展，不修改全局 ~/.claude/settings.json
 */
async function applyEnvConfig(localPort) {
  const ccConfig = vscode.workspace.getConfiguration('claudeCode');
  const currentEnv = ccConfig.get('environmentVariables', {});

  // 保存原始配置，方便恢复
  if (!originalEnvConfig) {
    originalEnvConfig = { ...currentEnv };
  }

  // 注入本地代理地址
  const newEnv = {
    ...currentEnv,
    'ANTHROPIC_BASE_URL': `http://127.0.0.1:${localPort}`,
    'ANTHROPIC_AUTH_TOKEN': 'relay-proxy-internal' // 占位，实际由代理转发时使用真实 key
  };

  await ccConfig.update('environmentVariables', newEnv, vscode.ConfigurationTarget.Global);
  console.log(`[ClaudeCodeRelay] 已注入环境变量: ANTHROPIC_BASE_URL=http://127.0.0.1:${localPort}`);
}

/**
 * 恢复原始的环境变量配置
 */
async function restoreEnvConfig() {
  if (originalEnvConfig) {
    const ccConfig = vscode.workspace.getConfiguration('claudeCode');
    await ccConfig.update('environmentVariables', originalEnvConfig, vscode.ConfigurationTarget.Global);
    originalEnvConfig = null;
    console.log('[ClaudeCodeRelay] 已恢复原始环境变量配置');
  }
}

/**
 * 从 ~/.claude/settings.json 读取中转站配置
 */
function readClaudeSettings() {
  try {
    const settingsPath = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(content);
      return {
        baseUrl: settings.env?.ANTHROPIC_BASE_URL || '',
        apiKey: settings.env?.ANTHROPIC_AUTH_TOKEN || settings.env?.ANTHROPIC_API_KEY || ''
      };
    }
  } catch (e) {
    console.error('[ClaudeCodeRelay] 读取 ~/.claude/settings.json 失败:', e.message);
  }
  return { baseUrl: '', apiKey: '' };
}

/**
 * 更新状态栏
 */
function updateStatusBar(text) {
  if (statusBarItem) {
    statusBarItem.text = text;
    statusBarItem.show();
  }
}

module.exports = {
  activate,
  deactivate
};
