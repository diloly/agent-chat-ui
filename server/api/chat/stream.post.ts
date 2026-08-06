import { buildStreamPayload } from '~/server/utils/coze';

// 流式对话代理：把浏览器请求转给 Coze /stream_run，原样回传 SSE
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  if (!body?.items?.length) {
    throw createError({ statusCode: 400, message: 'items required' });
  }

  const config = useRuntimeConfig(event);
  const url = `${config.cozeBase.replace(/\/$/, '')}/stream_run`;
  const payload = buildStreamPayload({
    items: body.items,
    conversationId: body.conversation_id,
    sessionId: body.session_id,
    projectId: config.cozeProjectId,
  });

  // [debug] 转发给 Coze /stream_run 的实际负载（含是否带上了会话 ID）
  console.log('[stream.post] → POST', url, {
    has_conversation_id: !!payload.conversation_id,
    has_session_id: !!payload.session_id,
    conversation_id: payload.conversation_id ?? null,
    session_id: payload.session_id ?? null,
  });

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.cozeToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const err = await upstream.text();
    throw createError({ statusCode: upstream.status || 502, message: err });
  }

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // sendStream 会把上游 ReadableStream 直接流式转发给浏览器
  return sendStream(event, upstream.body);
});
