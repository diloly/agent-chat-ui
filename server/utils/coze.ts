// Coze 流式对话 payload 构造（在 Nuxt server 内运行，token 不出服务端）
// 仅服务于 /stream_run，不涉及会话记录/历史接口。

export interface Attachment {
  type: string;       // 'image' | 'file' | 'video' 等
  file_url: string;   // 上传后的公开 URL
  filename?: string;
}

export function buildStreamPayload({
  text,
  conversationId,
  sessionId,
  projectId,
  attachments = [],
}: {
  text: string;
  conversationId?: string | null;
  sessionId?: string | null;
  projectId: string;
  attachments?: Attachment[];
}) {
  // prompt 数组：文本 + 文件附件
  const prompt: any[] = [];

  // 文件条目在前（Coze 惯例：文件先于文字）
  for (const a of attachments) {
    if (a.type === 'image') {
      prompt.push({ type: 'image', content: { file_url: a.file_url } });
    } else {
      prompt.push({ type: 'file', content: { file_url: a.file_url } });
    }
  }

  // 文本条目
  prompt.push({ type: 'text', content: { text } });

  const payload: any = {
    content: { query: { prompt } },
    type: 'query',
    project_id: projectId,
    local_msg_id: crypto.randomUUID(),
    role: 'user',
    _sendStatus_: 'sending',
  };
  if (sessionId) payload.session_id = sessionId;
  if (conversationId) payload.conversation_id = conversationId;
  return payload;
}
