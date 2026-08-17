import { deleteSession } from '~/server/utils/sessions';
import { getQuery } from 'h3';

// 删除一个会话记录（按 conversation_id）。仅服务端私有，token 不需要。
export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const cid = query.conversation_id;
  if (!cid || typeof cid !== 'string') {
    throw createError({ statusCode: 400, message: 'conversation_id required' });
  }
  await deleteSession(cid);
  return { ok: true };
});
