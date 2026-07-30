// 全局聊天状态（Nuxt useState 做 SSR 安全的单例）
// 仅做「实时对话 + 流式渲染」，不做任何会话记录/历史持久化。

// 官方 Coze Web SDK / iframe 的做法：conversation_id 与 session_id 都是
// 由客户端（SDK/iframe）自己生成的，每次请求带上去；服务端接受并使用。
// 这里我们也客户端生成：
//   - session_id：代表「用户这次浏览器会话」，跨多次对话保持稳定（刷新页面才会变）
//   - conversation_id：代表「一次对话线程」，每次「新对话」重新生成
export interface Msg {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatAttachment {
  file_url: string;
  filename: string;
  type: string;   // 'image' | 'file' | 'video'
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

  async function send(text: string, attachments: ChatAttachment[] = []) {
    if (streaming.value || (!text.trim() && !attachments.length)) return;
    // 首次发送时确保两个 ID 都已生成（客户端生成，符合官方 iframe 行为）
    if (!sessionId.value) sessionId.value = genId();
    if (!conversationId.value) conversationId.value = genId();

    messages.value = [...messages.value, { role: 'user', text }];
    streaming.value = true;

    // 不再预插空 assistant 消息；等首个 delta 到达时再创建，避免"空气泡+打字指示器"双占位
    let acc = '';
    let assistantCreated = false;

    const updateAssistant = (t: string) => {
      const msgs = [...messages.value];
      if (!assistantCreated) {
        // 首个 delta 到达时才插入 assistant 消息
        msgs.push({ role: 'assistant', text: t });
        assistantCreated = true;
      } else {
        msgs[msgs.length - 1] = { role: 'assistant', text: t };
      }
      messages.value = msgs;
    };

    // [debug] 发送前：当前带出的会话 ID（现在都应非 null）
    console.log('[useChat] ▶ send() 发起', {
      text: text.slice(0, 24),
      request_conversation_id: conversationId.value,
      request_session_id: sessionId.value,
    });

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          conversation_id: conversationId.value,
          session_id: sessionId.value,
          attachments,
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

          // 提取增量文本并追加渲染
          const delta = extractDelta(parsed);
          if (delta) {
            acc += delta;
            updateAssistant(acc);
          }
        }
      }
    } catch (e: any) {
      updateAssistant(`错误: ${e?.message || e}`);
    } finally {
      streaming.value = false;
      // [debug] 本次发送结束后，最终生效的会话 ID
      console.log('[useChat] ■ send() 结束', {
        final_conversation_id: conversationId.value,
        final_session_id: sessionId.value,
      });
    }
  }

  return { messages, streaming, conversationId, sessionId, reset, send };
}
