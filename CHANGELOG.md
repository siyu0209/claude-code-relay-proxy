# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-06

首个公开版本。

### 新增

- **本地协议转换代理**：在 `127.0.0.1` 上起 HTTP 服务，把 Anthropic Messages API 请求转换为 OpenAI Chat Completions API 请求，并把响应转回来。
- **流式 SSE 转换**：逐分片处理 OpenAI `data:` 事件，输出标准 Anthropic 事件序列（`message_start` → `content_block_start` → `content_block_delta`* → `content_block_stop` → `message_delta` → `message_stop`），含空响应兜底。
- **上游协议自动探测**：`GET /models` 取模型列表 + `POST /messages` 探测端点，按状态码判定 anthropic / openai，探测失败默认 openai。
- **自动模型映射**：把常见 Claude 模型名映射到上游可用模型（优先 `deepseek`，其次 `gemini`，再退回列表首个）。
- **伪造模型列表**：对 OpenAI 上游提供合成的 `/v1/models`（`claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`）。
- **只在 VS Code 生效**：通过 `claudeCode.environmentVariables` 注入 `ANTHROPIC_BASE_URL`，不改 `~/.claude/settings.json`；停用时自动还原。
- **状态栏与命令**：`🚀 Relay :端口 [协议]` 状态指示，以及开关 / 配置 / 重新检测 / 查看状态四个命令。
- **配置项**：`enabled`、`targetBaseUrl`、`targetApiKey`、`port`、`modelMapping`。
- **请求日志**：请求与请求体前 1000 字符追加写入 `src/relay-debug.log`，便于排错。

### 已知限制

- 仅转换文本，`image` / `tool_use` / `tool_result` 内容块会被丢弃。
- `max_tokens` 按 ×2 放大（下限 2048），不可配。
- 流式输出 token 数按「4 字符 ≈ 1 token」估算，`input_tokens` 恒为 0。
- 上游请求超时硬编码 300 秒，无重试。
- 模型映射只覆盖固定名单，名单外模型名原样透传。

[0.1.0]: https://github.com/siyu0209/claude-code-relay-proxy/releases/tag/v0.1.0
