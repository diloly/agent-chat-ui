import { listSessions } from '~/server/utils/sessions';

// 返回会话列表（按 updatedAt 倒序）。仅含 conversation_id + session_id，不返回消息体。
export default defineEventHandler(async () => {
  return await listSessions();
});
