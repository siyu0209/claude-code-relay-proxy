/**
 * 本地 HTTP 代理服务
 * 接收 Anthropic 格式请求，自动检测目标中转站协议，按需转换后转发
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  createStreamConverter
} = require('./transformer');

class RelayProxy {
  constructor() {
    this.server = null;
    this.port = 0;
    this.targetBaseUrl = '';
    this.targetApiKey = '';
    this.protocol = 'anthropic'; // 'anthropic' | 'openai'
    this.modelMapping = {};
    this.availableModels = [];
    this.detected = false;
  }

  /**
   * 启动代理服务
   */
  async start(port, targetBaseUrl, targetApiKey, modelMapping = {}) {
    this.targetBaseUrl = targetBaseUrl.replace(/\/+$/, '');
    this.targetApiKey = targetApiKey;
    this.modelMapping = modelMapping;

    // 先检测协议
    await this.detectProtocol();

    // 启动 HTTP 服务
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        console.log(`[RelayProxy] 代理已启动: http://127.0.0.1:${this.port}`);
        console.log(`[RelayProxy] 目标中转站: ${this.targetBaseUrl}`);
        console.log(`[RelayProxy] 检测到协议: ${this.protocol}`);
        console.log(`[RelayProxy] 可用模型: ${this.availableModels.join(', ')}`);
        resolve({ port: this.port, protocol: this.protocol, models: this.availableModels });
      });
    });
  }

  /**
   * 停止代理服务
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * 自动检测中转站协议格式
   */
  async detectProtocol() {
    try {
      // 先尝试获取模型列表
      const models = await this.fetchModels();
      this.availableModels = models;

      if (models.length === 0) {
        throw new Error('无法获取模型列表');
      }

      // 测试 Anthropic 格式 /v1/messages
      const anthropicWorks = await this.testAnthropicEndpoint();
      if (anthropicWorks) {
        this.protocol = 'anthropic';
      } else {
        this.protocol = 'openai';
      }

      // 自动生成模型映射（如果用户没配置）
      if (Object.keys(this.modelMapping).length === 0) {
        this.autoMapModels();
      }

      this.detected = true;
    } catch (err) {
      console.error('[RelayProxy] 协议检测失败:', err.message);
      // 默认按 OpenAI 处理
      this.protocol = 'openai';
      this.detected = true;
    }
  }

  /**
   * 获取可用模型列表
   */
  async fetchModels() {
    return new Promise((resolve) => {
      const url = `${this.targetBaseUrl}/models`;
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.request(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.targetApiKey}`,
          'x-api-key': this.targetApiKey,
          'anthropic-version': '2023-06-01'
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.data && Array.isArray(data.data)) {
              resolve(data.data.map(m => m.id));
            } else if (Array.isArray(data)) {
              resolve(data.map(m => m.id || m.name));
            } else {
              resolve([]);
            }
          } catch (e) {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  /**
   * 测试 Anthropic /v1/messages 端点是否可用
   */
  async testAnthropicEndpoint() {
    return new Promise((resolve) => {
      const url = `${this.targetBaseUrl}/messages`;
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;

      const testBody = JSON.stringify({
        model: this.availableModels[0] || 'claude-3-5-sonnet-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      });

      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.targetApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(testBody)
        }
      }, (res) => {
        // 200 = 支持 Anthropic 格式
        // 404 = 不支持
        // 401/403 = 认证问题但端点存在
        resolve(res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(10000, () => { req.destroy(); resolve(false); });
      req.write(testBody);
      req.end();
    });
  }

  /**
   * 自动生成模型映射
   */
  autoMapModels() {
    if (this.availableModels.length === 0) return;

    // 找一个最合适的默认模型
    let defaultModel = this.availableModels[0];
    // 优先 deepseek
    const deepseek = this.availableModels.find(m => m.toLowerCase().includes('deepseek'));
    if (deepseek) defaultModel = deepseek;
    // 其次 gemini
    if (!deepseek) {
      const gemini = this.availableModels.find(m => m.toLowerCase().includes('gemini'));
      if (gemini) defaultModel = gemini;
    }

    // 映射常见的 Claude 模型名
    const claudeModels = [
      'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
      'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229',
      'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'
    ];

    for (const m of claudeModels) {
      this.modelMapping[m] = defaultModel;
    }

    console.log(`[RelayProxy] 自动模型映射: ${JSON.stringify(this.modelMapping, null, 2)}`);
  }

  /**
   * 处理 HTTP 请求
   */
  handleRequest(req, res) {
    // 记录所有进来的请求
    this.logToFile('INCOMING', `${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 健康检查端点
    if (req.url === '/health' || req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        protocol: this.protocol,
        target: this.targetBaseUrl,
        models: this.availableModels,
        modelMapping: this.modelMapping
      }));
      return;
    }

    // 读取请求体
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      this.forwardRequest(req, res, body);
    });
  }

  /**
   * 转发请求到目标中转站
   */
  forwardRequest(req, res, body) {
    const isMessagesEndpoint = req.url.includes('/messages');
    const isModelsEndpoint = req.url.includes('/models');

    // 如果目标就是 Anthropic 格式，直接透传
    if (this.protocol === 'anthropic') {
      this.passthrough(req, res, body);
      return;
    }

    // OpenAI 格式目标：/v1/models 返回伪造的 Claude 模型列表
    if (isModelsEndpoint) {
      this.serveFakeModels(res);
      return;
    }

    // OpenAI 格式目标 + Anthropic 格式请求 → 需要转换
    if (isMessagesEndpoint) {
      this.relayWithConversion(req, res, body);
      return;
    }

    // 其他情况直接透传
    this.passthrough(req, res, body);
  }

  /**
   * 返回伪造的 Anthropic 格式模型列表（包含 Claude 模型）
   */
  serveFakeModels(res) {
    const claudeModels = [
      { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2025-01-01T00:00:00Z' },
      { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2025-01-01T00:00:00Z' },
      { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2025-01-01T00:00:00Z' }
    ];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: claudeModels,
      has_more: false,
      first_id: claudeModels[0].id,
      last_id: claudeModels[claudeModels.length - 1].id
    }));
  }

  /**
   * 直接透传（不需要协议转换）
   */
  passthrough(req, res, body) {
    const targetUrl = `${this.targetBaseUrl}${req.url}`;
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = { ...req.headers };
    delete headers['host'];
    headers['host'] = parsed.host;
    headers['x-api-key'] = this.targetApiKey;
    headers['authorization'] = `Bearer ${this.targetApiKey}`;

    const proxyReq = client.request(targetUrl, {
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[RelayProxy] 转发错误:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }

  /**
   * 记录日志到文件
   */
  logToFile(tag, data) {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, 'relay-debug.log');
    const time = new Date().toISOString();
    const line = `[${time}] [${tag}] ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch (e) {}
  }

  /**
   * 协议转换后转发（Anthropic → OpenAI → Anthropic）
   */
  relayWithConversion(req, res, body) {
    try {
      const anthropicReq = JSON.parse(body);
      const originalModel = anthropicReq.model;
      const isStream = anthropicReq.stream === true;

      this.logToFile('REQUEST', `原始 Anthropic 请求: ${body.slice(0, 1000)}`);

      // 转换请求体
      const openaiReq = anthropicToOpenAIRequest(anthropicReq, this.modelMapping);
      const openaiBody = JSON.stringify(openaiReq);

      this.logToFile('REQUEST', `转换后 OpenAI 请求: ${openaiBody.slice(0, 1000)}`);

      const targetUrl = `${this.targetBaseUrl}/chat/completions`;
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.targetApiKey}`,
        'Content-Length': Buffer.byteLength(openaiBody)
      };

      const proxyReq = client.request(targetUrl, {
        method: 'POST',
        headers: headers
      }, (proxyRes) => {
        // 错误处理
        if (proxyRes.statusCode !== 200) {
          let errBody = '';
          proxyRes.on('data', (chunk) => errBody += chunk);
          proxyRes.on('end', () => {
            console.error(`[RelayProxy] 上游错误 ${proxyRes.statusCode}:`, errBody);
            this.logToFile('UPSTREAM_ERROR', `状态码: ${proxyRes.statusCode}, 响应: ${errBody.slice(0, 1000)}`);
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'upstream_error',
                message: `Upstream error ${proxyRes.statusCode}: ${errBody.slice(0, 500)}`
              }
            }));
          });
          return;
        }

        this.logToFile('UPSTREAM_OK', `上游响应状态码: ${proxyRes.statusCode}, 流式: ${isStream}`);

        // 流式响应：逐块转换
        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const converter = createStreamConverter(originalModel, 'msg_' + Date.now());
          let buffer = '';

          proxyRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 最后一行可能不完整

            for (const line of lines) {
              const converted = converter.push(line.trim());
              if (converted) res.write(converted);
            }
          });

          proxyRes.on('end', () => {
            // 处理 buffer 中剩余的
            if (buffer.trim()) {
              const converted = converter.push(buffer.trim());
              if (converted) res.write(converted);
            }
            // 发送结束事件
            res.write(converter.end());
            res.end();
          });
        } else {
          // 非流式：完整读取后转换
          let respBody = '';
          proxyRes.on('data', (chunk) => respBody += chunk);
          proxyRes.on('end', () => {
            try {
              const openaiRes = JSON.parse(respBody);
              const anthropicRes = openAIToAnthropicResponse(openaiRes, originalModel);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(anthropicRes));
            } catch (e) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                type: 'error',
                error: { type: 'parse_error', message: 'Failed to parse upstream response: ' + e.message }
              }));
            }
          });
        }
      });

      proxyReq.on('error', (err) => {
        console.error('[RelayProxy] 请求错误:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: err.message }
        }));
      });

      proxyReq.setTimeout(300000, () => {
        proxyReq.destroy();
        res.writeHead(504);
        res.end(JSON.stringify({ error: 'Request timeout' }));
      });

      proxyReq.write(openaiBody);
      proxyReq.end();

    } catch (err) {
      console.error('[RelayProxy] 转换失败:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'conversion_error', message: err.message }
      }));
    }
  }
}

module.exports = { RelayProxy };
