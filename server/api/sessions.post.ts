import { upsertSession } from '~/server/utils/sessions';

// 保存/更新一个会话：conversation_id + session_id，并附带完整 messages（本地刷新回显用）。
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  if (!body?.conversation_id || !body?.session_id) {
    throw createError({ statusCode: 400, message: 'conversation_id and session_id required' });
  }
  return await upsertSession({
    conversation_id: String(body.conversation_id),
    session_id: String(body.session_id),
    messages: Array.isArray(body.messages) ? body.messages : undefined,
  });
});
