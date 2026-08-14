// Coze 流式对话 payload 构造（在 Nuxt server 内运行，token 不出服务端）
// 仅服务于 /stream_run，不涉及会话记录/历史接口。

export type PromptItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; file_url: string; filename?: string }
  | { kind: 'file'; file_url: string; filename?: string };

export function buildStreamPayload({
  items,
  conversationId,
  sessionId,
  projectId,
}: {
  items: PromptItem[];
  conversationId?: string | null;
  sessionId?: string | null;
  projectId: string;
}) {
  // 按前端 DOM 顺序交错构造 prompt（文字 / 图片 / 文件）
  // 注意：官方 Coze Web SDK / iframe 对图片和文件统一使用 type:"upload_file"，
  // 内容是 { upload_file: { file_name, url, file_path:"" } }，没有单独的 image 类型。
  const prompt: any[] = [];
  for (const it of items) {
    if (it.kind === 'text') {
      prompt.push({ type: 'text', content: { text: it.text } });
    } else {
      const fileUrl = it.file_url;
      const fileName = it.filename || fileUrl.split('/').pop() || 'file';
      prompt.push({
        type: 'upload_file',
        content: {
          upload_file: {
            file_name: fileName,
            url: fileUrl,
            file_path: '',
          },
        },
      });
    }
  }

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
