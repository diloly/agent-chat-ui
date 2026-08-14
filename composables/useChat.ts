// 全局聊天状态（Nuxt useState 做 SSR 安全的单例）
// 仅做「实时对话 + 流式渲染」，不做任何会话记录/历史持久化。

import type { PromptItem } from '~/server/utils/coze';

// 官方 Coze Web SDK / iframe 的做法：conversation_id 与 session_id 都是
// 由客户端（SDK/iframe）自己生成的，每次请求带上去；服务端接受并使用。
// 这里我们也客户端生成：
//   - session_id：代表「用户这次浏览器会话」，跨多次对话保持稳定（刷新页面才会变）
//   - conversation_id：代表「一次对话线程」，每次「新对话」重新生成
// 工具调用（对应官方 iframe 里可展开的那张卡）
// 官方协议里工具消息的 type 取值（见 @coze/api 的 MessageType）：
//   function_call  / tool_request  —— 调用请求（含工具名 + 入参）
//   tool_response  / tool_output   —— 调用结果
export interface ToolCall {
  id?: string;
  name: string;
  arguments?: string | null;   // 工具入参（原始 JSON 字符串）
  result?: string | null;      // 工具返回结果
  status: 'request' | 'response';
  _open?: boolean;             // UI 展开状态（默认收起，对标官方"可展开"）
}

export interface Msg {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  attachments?: PromptItem[];   // 用户消息可带附件（图片/文件），按 DOM 顺序
  toolCalls?: ToolCall[];       // 助手消息包含的工具调用（与回答共享同一个头像）
}

/**
 * 从 Coze /stream_run 的 SSE 事件中提取增量文本。
 *
 * 真实事件格式（已实测确认）：
 *   event: message
 *   data: {"type":"message_start",  "content":{"message_start":{...}}}
 *   data: {"type":"answer",        "content":{"answer":"你"}}
 *   data: {"type":"answer",        "content":{"answer":"好"}}
 *   ...
 *   data: {"type":"message_end",   "content":{"message_end":{...}}}
 *
 * 只有 type==="answer" 且 content.answer 为非空字符串时才返回增量文本。
 */
export function extractDelta(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  // Coze /stream_run 标准格式：type=answer → content.answer 是逐字/逐词增量
  if (parsed.type === 'answer' && parsed?.content?.answer) {
    const a = parsed.content.answer;
    return typeof a === 'string' ? a : null;
  }
  // 兼容其他可能的格式（留作兜底）
  if (parsed.content?.text) return parsed.content.text;
  if (parsed.content?.content) return parsed.content.content;
  if (parsed.delta) return typeof parsed.delta === 'string' ? parsed.delta : parsed.delta?.content;
  if (parsed.text) return parsed.text;
  return null;
}

/**
 * 从 Coze SSE 事件中提取「工具调用」信息（function_call / tool_request / tool_response / tool_output）。
 * 返回 null 表示这不是工具事件。
 *
 * 实测 /stream_run 的事件结构：
 *   { type: 'tool_request',  content: { tool_request:  { tool_call_id, tool_name, parameters } } }
 *   { type: 'tool_response', content: { tool_response: { tool_call_id, tool_name, output } } }
 *
 * 也保留对 function_call / tool_output 形态的兼容。
 */
export function extractToolCall(parsed: any): ToolCall | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const type = parsed.type;
  const isRequest = type === 'tool_request' || type === 'function_call' || type === 'tool_call';
  const isResponse = type === 'tool_response' || type === 'tool_output';
  if (!isRequest && !isResponse) return null;

  let content: any = parsed.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      /* 保留原字符串 */
    }
  }

  // 优先使用 Coze stream_run 的包装字段 tool_request / tool_response
  const req = content?.tool_request;
  const resp = content?.tool_response;
  const payload = req || resp || content;

  const id: string | undefined =
    payload?.tool_call_id || payload?.id || content?.id || parsed.id;
  const name: string =
    payload?.tool_name || payload?.name || payload?.function?.name || '';

  if (isRequest) {
    let args: string | null = null;
    if (payload?.parameters != null) {
      args = typeof payload.parameters === 'string'
        ? payload.parameters
        : JSON.stringify(payload.parameters);
    } else if (payload?.arguments != null) {
      args = typeof payload.arguments === 'string'
        ? payload.arguments
        : JSON.stringify(payload.arguments);
    }
    return { id, name: name || '(未知工具)', arguments: args, status: 'request', _open: false };
  }

  // 响应类：优先 output / result，兜底把整个 payload 或 content JSON 化
  let result: string | null = null;
  if (payload?.output != null) {
    result = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output);
  } else if (payload?.result != null) {
    result = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result);
  } else if (typeof content === 'string') {
    result = content;
  } else if (content != null) {
    result = JSON.stringify(content);
  }
  return { id, name, result, status: 'response', _open: false };
}

// 生成 Coze 风格的会话 ID（任意唯一串服务端都接受；这里用 UUID 保证唯一）
function genId(): string {
  return crypto.randomUUID();
}

export function useChat() {
  const messages = useState<Msg[]>('messages', () => []);
  const streaming = useState<boolean>('streaming', () => false);
  // 会话连续性（仅内存，随页面刷新清空；不做记录）
  const conversationId = useState<string | null>('conversationId', () => null);
  const sessionId = useState<string | null>('sessionId', () => null);

  function reset() {
    messages.value = [];
    // 新对话 = 新的 conversation_id；session_id 保持不变（同一用户会话）
    conversationId.value = genId();
  }

  async function send(items: PromptItem[]) {
    if (streaming.value || !items.length) return;
    // 首次发送时确保两个 ID 都已生成（客户端生成，符合官方 iframe 行为）
    if (!sessionId.value) sessionId.value = genId();
    if (!conversationId.value) conversationId.value = genId();

    const text = items.filter((i) => i.kind === 'text').map((i) => (i as any).text).join('\n');
    messages.value = [...messages.value, { role: 'user', text, attachments: items.filter((i) => i.kind !== 'text') }];
    streaming.value = true;

    // 工具调用前后，assistant 的文本应该被切成不同的消息：
    //   message_start / answer("请稍等...") / tool_request / tool_response / answer("已完成...")
    // 关键：Coze /stream_run 里不同 msg_id 对应不同的 assistant 发言气泡，
    // 因此需要同时按 msg_id 区分，而不是单纯追加到最后一条消息。
    let currentAssistantIdx: number | null = null;
    let currentMsgId: string | null = null;
    let currentAcc = '';     // 当前 msg_id 对应的文本累加器
    let currentReplyId: string | null = null; // 当前渲染中的回复 id（取 message_start.reply_id）；变化即"新回复"

    const startNewAssistant = (initialText = '', msgId: string | null = null) => {
      const idx = messages.value.length;
      messages.value = [...messages.value, { role: 'assistant', text: initialText }];
      currentAssistantIdx = idx;
      currentMsgId = msgId;
      currentAcc = initialText;
      return idx;
    };

          // 气泡分组键：必须用 answer 的「片段级 msg_id」(如 c874f3f9…)！
          // 同一片段 id = 同一个气泡；换片段 id = 新气泡（同一 reply_id 下的多段输出就是要分多个气泡）。
          // 兜底用 reply_id（极端情况下 answer 事件缺失 msg_id 时，仍能按回复聚合，避免跨回复错拼）。
          // 注意：message_start 的顶层 msg_id 是 reply 级 id（f84fc934…），与 answer 片段 id 不等，
          // 绝不拿它当分组键；reply_id 仅用于 message_start 时识别"新回复"以新建占位气泡。
          const groupKeyOf = (p: any): string | null => p?.msg_id ?? p?.reply_id ?? p?.query_msg_id ?? null;

    const updateAssistant = (delta: string, groupId: string | null = null) => {
      const cur = currentAssistantIdx != null ? messages.value[currentAssistantIdx] : null;
      const curEmpty = !!cur && cur.role === 'assistant' && !cur.text && !(cur.toolCalls && cur.toolCalls.length);
      // 分组键变化且当前气泡已非空 → 是另一个回复，必须新建气泡；否则追加到当前气泡。
      const groupChanged = groupId != null && groupId !== currentMsgId;
      if ((groupChanged && !curEmpty) || currentAssistantIdx == null || cur?.role !== 'assistant') {
        startNewAssistant(delta, groupId);
        return;
      }
      currentAcc += delta;
      currentMsgId = groupId ?? currentMsgId; // 关键：追加分支也要同步分组键，否则后续会误判变化而拆气泡
      const msgs = [...messages.value];
      msgs[currentAssistantIdx] = { ...msgs[currentAssistantIdx], text: currentAcc };
      messages.value = msgs;
    };

    // 工具调用挂在当前 assistant 消息内部（与回答共享同一个头像），
    // 而不是创建独立的 role='tool' 消息（避免头像被挤到下方）。
    const ensureAssistant = (msgId: string | null = null) => {
      if (currentAssistantIdx != null && messages.value[currentAssistantIdx]?.role === 'assistant') {
        return currentAssistantIdx;
      }
      return startNewAssistant('', msgId);
    };

    const addToolCall = (tool: ToolCall) => {
      const idx = ensureAssistant(currentMsgId);
      const msgs = [...messages.value];
      const existing = msgs[idx].toolCalls || [];
      msgs[idx] = { ...msgs[idx], toolCalls: [...existing, tool] };
      messages.value = msgs;
    };

    const updateToolCall = (tool: ToolCall) => {
      // 优先按 tool_call_id 精确匹配当前 assistant 里的工具
      const msgs = [...messages.value];
      let idx = -1;
      let tidx = -1;

      if (currentAssistantIdx != null && tool.id) {
        const calls = msgs[currentAssistantIdx]?.toolCalls;
        if (calls) {
          tidx = calls.findIndex((t) => t.id === tool.id && t.status === 'request');
          if (tidx >= 0) idx = currentAssistantIdx;
        }
      }

      // 兜底：响应经常不带 id 或 id 对不上，找最近一条仍有"调用中"工具的 assistant
      if (idx < 0) {
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const calls = messages.value[i].toolCalls;
          if (messages.value[i].role === 'assistant' && calls?.length) {
            tidx = calls.findIndex((t) => t.status === 'request');
            if (tidx >= 0) {
              idx = i;
              break;
            }
          }
        }
      }

      if (idx >= 0 && tidx >= 0) {
        const existing = msgs[idx].toolCalls![tidx];
        // 响应事件通常不带 tool_name，要从请求卡上继承
        const merged: ToolCall = { ...existing, ...tool, name: tool.name || existing.name };
        msgs[idx].toolCalls![tidx] = merged;
        messages.value = msgs;
      } else {
        // 找不到请求卡时兜底：直接挂到当前 assistant
        addToolCall(tool);
      }
    };

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          conversation_id: conversationId.value,
          session_id: sessionId.value,
        }),
      });
      if (!res.ok || !res.body) {
        const e = await res.text();
        updateAssistant(`请求失败 (${res.status}): ${e.slice(0, 200)}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 每个事件块用 \n\n 分隔
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || ''; // 保留最后一个可能不完整的块

        for (const block of blocks) {
          if (!block.trim()) continue;
          // 提取 data: 行的值
          const dataLine = block
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const txt = dataLine.slice(5).trim();
          if (!txt || txt === '[DONE]') continue;

          let parsed: any = null;
          try {
            parsed = JSON.parse(txt);
          } catch {
            // 忽略非 JSON 行（如注释、心跳等）
            continue;
          }
          if (!parsed) continue;

          // message_start 表示一次新回复的开始（同一条回复只有一个 reply_id）。
          // 只要 reply_id 变了就新建占位气泡（头像 + ... 指示器）；没变则沿用（正常不会重复触发）。
          // 不用 message_start 自己的 msg_id，reply_id 足以作为"新回复"开关。
          if (parsed.type === 'message_start') {
            if (parsed.reply_id !== currentReplyId) {
              startNewAssistant('', null);
              currentReplyId = parsed.reply_id ?? null;
            }
          }

          // 提取增量文本并追加渲染；按「片段级 msg_id」分组：同片段拼同一气泡，换片段建新气泡。
          const delta = extractDelta(parsed);
          if (delta) {
            updateAssistant(delta, groupKeyOf(parsed));
          }

          // 工具调用事件（function_call / tool_request / tool_response / tool_output）
          // 工具调用挂在当前 assistant 消息内部，与后续回答共享同一个头像。
          const tool = extractToolCall(parsed);
          if (tool) {
            if (tool.status === 'request') {
              addToolCall(tool);
            } else {
              updateToolCall(tool);
            }
          }
        }
      }
    } catch (e: any) {
      updateAssistant(`错误: ${e?.message || e}`);
    } finally {
      streaming.value = false;
      // 清理：若最后一条 assistant 是「空占位」（既无文本也无工具调用，例如请求被拒但没产出），
      // 移除它以免留下一个空白头像气泡。
      const msgs = [...messages.value];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant' && !last.text && !(last.toolCalls && last.toolCalls.length)) {
        msgs.pop();
        messages.value = msgs;
      }
    }
  }

  return { messages, streaming, conversationId, sessionId, reset, send };
}
