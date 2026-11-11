/**
 * 协议转换器：Anthropic Messages API ↔ OpenAI Chat Completions API
 */

/**
 * Anthropic 请求体 → OpenAI 请求体
 */
function anthropicToOpenAIRequest(anthropicReq, modelMapping) {
  // 思考模型需要更多 token，放大 max_tokens 避免思考用完导致内容为空
  const originalMaxTokens = anthropicReq.max_tokens || 4096;
  const openaiReq = {
    model: mapModel(anthropicReq.model, modelMapping),
    messages: [],
    max_tokens: Math.max(originalMaxTokens * 2, 2048),
    stream: anthropicReq.stream || false
  };

  // system 消息转换
  if (anthropicReq.system) {
    openaiReq.messages.push({
      role: 'system',
      content: typeof anthropicReq.system === 'string' ? anthropicReq.system : JSON.stringify(anthropicReq.system)
    });
  }

  // 普通消息转换
  for (const msg of anthropicReq.messages || []) {
    if (typeof msg.content === 'string') {
      openaiReq.messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // 处理 content blocks（文本、图片等）
      const textParts = msg.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      openaiReq.messages.push({ role: msg.role, content: textParts });
    }
  }

  // 其他可选参数
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;

  return openaiReq;
}

/**
 * OpenAI 响应体 → Anthropic 响应体（非流式）
 */
function openAIToAnthropicResponse(openaiRes, originalModel) {
  const choice = openaiRes.choices && openaiRes.choices[0];
  const content = choice && choice.message ? choice.message.content : '';

  return {
    id: openaiRes.id || 'msg_' + Date.now(),
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: content
      }
    ],
    model: originalModel,
    stop_reason: mapFinishReason(choice && choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiRes.usage ? openaiRes.usage.prompt_tokens : 0,
      output_tokens: openaiRes.usage ? openaiRes.usage.completion_tokens : 0
    }
  };
}

/**
 * OpenAI SSE 流式数据 → Anthropic SSE 事件
 * 返回一个转换器实例，逐行处理
 */
function createStreamConverter(originalModel, messageId) {
  let started = false;
  let blockStarted = false;
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;

  function getInitEvents() {
    const events = [];
    events.push(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    })}\n\n`);
    events.push(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })}\n\n`);
    return events.join('');
  }

  function getDeltaEvents(text) {
    if (!text) return '';
    outputTokens += Math.ceil(text.length / 4);
    return `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text }
    })}\n\n`;
  }

  function getEndEvents() {
    const events = [];
    events.push(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0
    })}\n\n`);
    events.push(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
      usage: { output_tokens: outputTokens }
    })}\n\n`);
    events.push(`event: message_stop\ndata: ${JSON.stringify({
      type: 'message_stop'
    })}\n\n`);
    return events.join('');
  }

  return {
    /**
     * 处理 OpenAI SSE 的一行数据（data: {...} 格式）
     * 返回转换后的 Anthropic SSE 事件字符串
     */
    push(line) {
      if (!line || !line.startsWith('data:')) return '';
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        return getEndEvents();
      }

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) return '';

        let result = '';
        if (!started) {
          result += getInitEvents();
          started = true;
          blockStarted = true;
        }

        if (delta.content) {
          result += getDeltaEvents(delta.content);
        }

        if (chunk.choices[0].finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        return result;
      } catch (e) {
        return '';
      }
    },

    /**
     * 结束时调用，返回剩余的结束事件
     */
    end() {
      if (!started) {
        // 空响应也需要发送完整的事件序列
        return getInitEvents() + getEndEvents();
      }
      return getEndEvents();
    }
  };
}

/**
 * 模型名映射
 */
function mapModel(anthropicModel, modelMapping) {
  if (modelMapping && modelMapping[anthropicModel]) {
    return modelMapping[anthropicModel];
  }
  // 自动匹配：优先找 deepseek，其次 gemini
  return anthropicModel; // 实际由 detectAndMap 自动配置
}

/**
 * OpenAI finish_reason → Anthropic stop_reason
 */
function mapFinishReason(reason) {
  const map = {
    'stop': 'end_turn',
    'length': 'max_tokens',
    'content_filter': 'end_turn',
    'tool_calls': 'tool_use'
  };
  return map[reason] || 'end_turn';
}

module.exports = {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  createStreamConverter,
  mapModel,
  mapFinishReason
};
