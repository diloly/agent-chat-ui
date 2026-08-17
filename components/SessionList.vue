<template>
  <aside class="session-list">
    <div class="sl-header">
      <span class="sl-title">会话</span>
      <button class="sl-new" @click="onNew" title="新对话">＋</button>
    </div>
    <div class="sl-scroll">
      <div
        v-for="s in sessions"
        :key="s.conversation_id"
        class="sl-item"
        :class="{ active: s.conversation_id === conversationId }"
        :title="s.conversation_id"
        @click="onOpen(s)"
      >
        <div class="sl-main">
          <div class="sl-id">{{ sessionTitle(s) }}</div>
          <div class="sl-time">{{ timeAgo(s.updatedAt) }}</div>
        </div>
        <button class="sl-del" @click.stop="onDelete(s.conversation_id)" title="删除会话">×</button>
      </div>
      <div v-if="!sessions.length" class="sl-empty">暂无历史会话</div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useChat } from '~/composables/useChat';

const { sessions, conversationId, loadSessions, openSession, reset, deleteSession } = useChat();

// 会话标题：优先取第一条「用户」消息文字，其次第一条助手文字，都没有则显示「新对话」
function sessionTitle(s: { messages?: { role: string; text?: string }[] }) {
  const msgs = s.messages || [];
  const firstUser = msgs.find((m) => m.role === 'user' && m.text && m.text.trim());
  if (firstUser?.text) return firstUser.text.trim().slice(0, 30);
  const firstAny = msgs.find((m) => m.text && m.text.trim());
  if (firstAny?.text) return firstAny.text.trim().slice(0, 30);
  return '新对话';
}
function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
function onOpen(s: { conversation_id: string; session_id: string }) {
  openSession(s.conversation_id, s.session_id);
}
function onNew() {
  reset();
}
function onDelete(cid: string) {
  deleteSession(cid);
}

onMounted(() => {
  loadSessions();
});
</script>

<style scoped>
.session-list {
  width: 240px;
  flex-shrink: 0;
  height: 100%;
  background: #161616;
  border-right: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
}
.sl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px;
  border-bottom: 1px solid #2a2a2a;
}
.sl-title { font-size: 14px; font-weight: 600; color: #e0e0e0; }
.sl-new {
  width: 28px; height: 28px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #222;
  color: #ddd;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.sl-new:hover { background: #2c2c2c; }
.sl-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sl-item {
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 9px 6px 9px 10px;
  cursor: pointer;
  color: #bbb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.sl-item:hover { background: #1f1f1f; }
.sl-item.active { background: #232323; border-color: #3a3a3a; color: #fff; }
.sl-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sl-del {
  flex-shrink: 0;
  width: 22px; height: 22px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #777;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.sl-del:hover { background: #3a2326; color: #ff8080; }
.sl-id {
  font-size: 13px;
  font-weight: 500;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-time { font-size: 11px; color: #777; }
.sl-empty { padding: 20px 12px; font-size: 12px; color: #666; text-align: center; }
</style>
