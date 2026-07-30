<template>
  <div class="chat-wrap">
    <div class="chat-card">
      <!-- 临时测试面板：手动填入 conversation_id / session_id，验证刷新后能否连回会话（测试完会删除） -->
      <button class="dbg-toggle" @click="showTest = !showTest" title="测试用：填入会话 ID">🧪</button>
      <div v-if="showTest" class="dbg-panel">
        <div class="dbg-title">测试用 ID（临时，测完会删）</div>
        <div class="dbg-row"><span>当前 conversation_id</span><code>{{ conversationId || '(空)' }}</code></div>
        <div class="dbg-row"><span>当前 session_id</span><code>{{ sessionId || '(空)' }}</code></div>
        <hr />
        <label>填入 conversation_id</label>
        <input v-model="testConv" placeholder="粘贴 conversation_id" />
        <label>填入 session_id</label>
        <input v-model="testSess" placeholder="粘贴 session_id" />
        <div class="dbg-btns">
          <button class="dbg-apply" @click="applyTestIds">应用填入</button>
          <button class="dbg-close" @click="showTest = false">关闭</button>
        </div>
      </div>
      <!-- 欢迎区（无消息时显示） -->
      <div v-if="!messages.length" class="welcome">
        <div class="bot-avatar-lg">
          <span class="bot-emoji-lg">🤖</span>
        </div>
        <div class="bot-name">口播视频智能体</div>
        <div class="bot-desc">AI口播文案生成智能体，支持封面、脚本生成及视频制作，API 整合外部服务，自动任务识别与子任务划分。</div>
      </div>

      <!-- 消息列表 -->
      <div ref="messagesEl" class="messages">
        <!-- 用户消息：无头像，右对齐 -->
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <!-- 只有 assistant 显示头像 -->
          <div v-if="m.role === 'assistant'" class="avatar">
            <span class="bot-emoji-sm">🤖</span>
          </div>
          <div class="bubble" :class="m.role" v-html="renderText(m.text)"></div>
        </div>
        <!-- 流式打字指示器（assistant 正在输出、但尚未收到任何内容时显示） -->
        <div v-if="streaming && !(messages.length && messages[messages.length-1].role === 'assistant' && messages[messages.length-1].text)" class="msg assistant">
          <div class="avatar"><span class="bot-emoji-sm">🤖</span></div>
          <div class="bubble assistant"><span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
        </div>
      </div>

      <!-- 底部输入区 -->
      <div class="composer">
        <!-- 隐藏文件选择器 -->
        <input ref="fileInputRef" type="file" class="hidden-file" accept="image/*,.pdf,.doc,.docx,.txt" @change="onFileSelect" />

        <!-- 已选文件 chips（上传完成后显示） -->
        <div v-if="attachments.length" class="file-chips">
          <div v-for="(f, i) in attachments" :key="i" class="chip" :class="{ 'chip-image': f.type.startsWith('image') }">
            <img v-if="f.type.startsWith('image') && f.file_url" :src="f.file_url" class="chip-thumb" />
            <span v-else class="chip-icon">📎</span>
            <span class="chip-name">{{ f.filename }}</span>
            <button class="chip-remove" @click.stop="removeAttachment(i)" title="移除">×</button>
          </div>
        </div>

        <!-- 上传中提示 -->
        <div v-if="uploading" class="uploading-hint">正在上传...</div>

        <div class="input-box">
          <textarea
            ref="inputEl"
            v-model="input"
            placeholder="输入内容"
            @keydown="onKey"
            rows="1"
          ></textarea>
          <div class="input-actions">
            <button class="btn-plus" :disabled="uploading" @click="fileInputRef?.click()" title="附件">+</button>
            <button class="btn-send" :disabled="streaming || uploading || (!input.trim() && !attachments.length)" @click="onSend" title="发送">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useChat } from '~/composables/useChat';

const { messages, streaming, reset, send, conversationId, sessionId } = useChat();
const input = ref('');
const messagesEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 文件附件（已上传到 COS 的）
const attachments = ref<{ file_url: string; filename: string; type: string }[]>([]);
const uploading = ref(false);

// 临时测试：手动填入 conversation_id / session_id（测完会删除）
const showTest = ref(false);
const testConv = ref('');
const testSess = ref('');
function applyTestIds() {
  if (testConv.value.trim()) conversationId.value = testConv.value.trim();
  if (testSess.value.trim()) sessionId.value = testSess.value.trim();
}

// ===== 文件上传 =====
async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // 重置以便同一文件可再次选择
  input.value = '';

  uploading.value = true;
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/cos/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ statusMessage: '上传失败' }));
      throw new Error(err.statusMessage || `HTTP ${res.status}`);
    }
    const data = await res.json();
    attachments.value.push({
      file_url: data.url,
      filename: data.filename || file.name,
      type: file.type || 'application/octet-stream',
    });
  } catch (err: any) {
    alert(`上传失败: ${err?.message || '未知错误'}`);
  } finally {
    uploading.value = false;
  }
}

function removeAttachment(i: number) {
  attachments.value.splice(i, 1);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

function onSend() {
  const t = input.value.trim();
  if (!t && !attachments.value.length) return;
  const files = [...attachments.value];
  input.value = '';
  attachments.value = [];
  send(t, files);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

/**
 * 轻量 Markdown 渲染（对标 iframe 的输出效果）
 * 支持顺序很重要：先处理代码块（```），再行内代码，再加粗，最后换行
 */
function renderText(text: string) {
  if (!text) return '';
  let h = escapeHtml(text);
  // 代码块 ```...```
  h = h.replace(/```([\s\S]*?)```/g, (_m, c) => `<pre><code>${c.replace(/^\n/, '')}</code></pre>`);
  // 行内代码 `...`
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 加粗 **...**
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 换行 → <br>（保留段落感）
  h = h.replace(/\n/g, '<br>');
  return h;
}

// 自动滚动到底部
watch(
  messages,
  async () => {
    await nextTick();
    if (messagesEl.value) {
      messagesEl.value.scrollTo({
        top: messagesEl.value.scrollHeight,
        behavior: 'smooth',
      });
    }
  },
  { deep: true }
);

// textarea 自动增高
watch(input, () => {
  if (inputEl.value) {
    inputEl.value.style.height = 'auto';
    inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 120) + 'px';
  }
});
</script>

<style>
/* ===== 外层容器：深色背景 + 居中卡片 ===== */
.chat-wrap {
  display: flex;
  justify-content: center;
  align-items: stretch;
  min-height: 100vh;
  padding: 28px 20px;
  background: #121212;
  box-sizing: border-box;
}

/* ===== 卡片 ===== */
.chat-card {
  width: 100%;
  max-width: 840px;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  border-radius: 16px;
  overflow: hidden;
  position: relative; /* 作为临时测试面板的定位上下文 */
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
}

/* ===== 欢迎区 ===== */
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60px 40px 48px;
  gap: 12px;
  flex: 1;
}
.bot-avatar-lg {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #c9a06c, #ddb589);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.bot-emoji-lg { font-size: 32px; }
.bot-name {
  font-size: 16px;
  font-weight: 600;
  color: #e8e8e8;
  margin-top: 4px;
}
.bot-desc {
  font-size: 13px;
  color: #888;
  line-height: 1.65;
  text-align: center;
  max-width: 500px;
}

/* ===== 消息列表 ===== */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 80px;
}

/* 消息行 */
.msg {
  display: flex;
  gap: 8px;
  max-width: 100%;
}
.msg.user {
  justify-content: flex-end; /* 用户消息靠右 */
}
.msg.assistant {
  justify-content: flex-start; /* 助手消息靠左 */
}

/* 头像（仅 assistant 有） */
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: #252525;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.bot-emoji-sm { font-size: 15px; }

/* ===== 气泡 ===== */
.bubble {
  border-radius: 14px;
  padding: 10px 14px;
  line-height: 1.7;
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: calc(100% - 42px);
}

/* 用户气泡：深灰底，四角圆角一致 */
.bubble.user {
  background: #2a2a2a;
  color: #ddd;
}

/* 助手气泡：深灰底 */
.bubble.assistant {
  background: #222;
  color: #ccc;
  max-width: calc(100% - 42px);
}

/* ===== 打字动画 ===== */
.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0 !important;
}
.dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: #555;
  animation: bounce 1.4s infinite ease-in-out both;
}
.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.35; }
  40% { transform: scale(1); opacity: 1; }
}

/* ===== 代码块 ===== */
.bubble pre {
  background: #0d1117;
  color: #c9d1d9;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
  margin: 6px 0;
}
.bubble code {
  background: #333;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  color: #e8b88a;
}
.bubble.user code {
  background: rgba(255,255,255,0.08);
  color: #ccc;
}

/* ===== 输入区 ===== */
.composer {
  padding: 14px 18px 18px;
  flex-shrink: 0;
}

.hidden-file { display: none; }

/* 文件 chips */
.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  padding: 4px 8px 4px 4px;
  font-size: 13px;
  color: #ccc;
  max-width: 220px;
  cursor: default;
  transition: border-color 0.15s;
}
.chip:hover { border-color: #555; }

.chip-thumb {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}
.chip-icon {
  font-size: 14px;
  flex-shrink: 0;
  line-height: 1;
}

.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.chip-remove {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #777;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.15s;
  padding: 0;
}
.chip:hover .chip-remove { opacity: 1; }
.chip-remove:hover { background: #444; color: #eee; }

.uploading-hint {
  font-size: 12px;
  color: #888;
  margin-bottom: 6px;
  padding-left: 2px;
}

.input-box {
  display: flex;
  flex-direction: column; /* textarea 在上，按钮行在下 */
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 14px;
  padding: 10px 12px 8px;
  transition: border-color 0.2s;
}
.input-box:focus-within {
  border-color: #444;
}

.input-box textarea {
  width: 100%;
  resize: none;
  border: none;
  background: transparent;
  color: #ccc;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  padding: 0 2px;
  min-height: 22px;
  max-height: 120px;
  line-height: 1.5;
}
.input-box textarea::placeholder { color: #555; }

.input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 6px;
  margin-top: 4px;
}

.btn-plus {
  width: 30px; height: 30px;
  border-radius: 8px;
  border: 1px solid #444;
  background: transparent;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-plus:hover { background: #2a2a2a; color: #bbb; border-color: #555; }

.btn-send {
  width: 30px; height: 30px;
  border-radius: 8px;
  border: 1px solid #444;
  background: transparent;
  color: #555;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}
/* 可发送时亮起 */
.btn-send:not(:disabled) {
  color: #aaa;
  border-color: #666;
}
.btn-send:not(:disabled):hover {
  background: #2a2a2a;
  color: #ccc;
  border-color: #777;
}
.btn-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ===== 滚动条 ===== */
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
.messages::-webkit-scrollbar-thumb:hover { background: #444; }

/* ===== 临时测试面板（测完会删） ===== */
.dbg-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid #444;
  background: #2a2a2a;
  color: #ccc;
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dbg-toggle:hover { background: #333; }
.dbg-panel {
  position: absolute;
  top: 44px;
  right: 8px;
  z-index: 20;
  width: 280px;
  background: #0f0f0f;
  border: 1px dashed #555;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  color: #bbb;
  box-shadow: 0 6px 18px rgba(0,0,0,0.6);
}
.dbg-title {
  font-size: 12px;
  font-weight: 600;
  color: #e0a96c;
  margin-bottom: 8px;
}
.dbg-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}
.dbg-row span { color: #888; }
.dbg-row code {
  background: #1c1c1c;
  padding: 3px 6px;
  border-radius: 4px;
  word-break: break-all;
  font-family: ui-monospace, monospace;
  color: #c9d1d9;
}
.dbg-panel hr { border: none; border-top: 1px solid #333; margin: 8px 0; }
.dbg-panel label { display: block; color: #888; margin: 6px 0 3px; }
.dbg-panel input {
  width: 100%;
  box-sizing: border-box;
  background: #1c1c1c;
  border: 1px solid #444;
  border-radius: 6px;
  color: #ccc;
  padding: 5px 7px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  outline: none;
}
.dbg-panel input:focus { border-color: #e0a96c; }
.dbg-btns { display: flex; gap: 8px; margin-top: 10px; }
.dbg-apply, .dbg-close {
  flex: 1;
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid #555;
  background: #2a2a2a;
  color: #ddd;
  font-size: 12px;
  cursor: pointer;
}
.dbg-apply { background: #3a2e1a; border-color: #e0a96c; color: #f0c890; }
.dbg-apply:hover { background: #4a3a22; }
.dbg-close:hover { background: #333; }
</style>
