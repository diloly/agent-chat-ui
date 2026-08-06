<template>
  <div class="chat-wrap">
    <div class="chat-card">
      <!-- 临时测试面板：手动填入 conversation_id / session_id（测试完会删除） -->
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
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <!-- 只有 assistant 显示头像 -->
          <div v-if="m.role === 'assistant'" class="avatar">
            <span class="bot-emoji-sm">🤖</span>
          </div>
          <!-- 用户消息气泡（文字 + 附件） -->
          <div class="bubble" :class="m.role">
            <!-- 用户消息附件列表（按发送顺序展示，每张独立一行） -->
            <div v-if="m.attachments?.length" class="msg-attachments">
              <div v-for="(f, j) in m.attachments" :key="j" class="msg-att-item">
                <img v-if="f.kind === 'image' && f.file_url" :src="f.file_url" class="msg-att-thumb" />
                <span v-else class="msg-att-icon">📎</span>
                <span class="msg-att-name">{{ f.filename }}</span>
              </div>
            </div>
            <div v-if="m.text" v-html="renderText(m.text)"></div>
          </div>
        </div>
        <!-- 流式打字指示器（assistant 正在输出、但尚未收到任何内容时显示） -->
        <div v-if="streaming && !(messages.length && messages[messages.length-1].role === 'assistant' && messages[messages.length-1].text)" class="msg assistant">
          <div class="avatar"><span class="bot-emoji-sm">🤖</span></div>
          <div class="bubble assistant"><span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
        </div>
      </div>

      <!-- 底部输入区 -->
      <div class="composer">
        <!-- 隐藏文件选择器（支持多选 + 视频） -->
        <input ref="fileInputRef" type="file" class="hidden-file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.txt,.mp4,.mov,.avi,.mkv" @change="onFileSelect" />

        <div class="input-box">
          <!-- contenteditable 内联输入：文字与 chip 同一行混排 -->
          <div
            ref="editableRef"
            class="inline-input"
            :class="{ 'is-empty': !hasContent }"
            contenteditable="true"
            :data-placeholder="'输入内容'"
            @keydown="onKey"
            @input="updateSendState"
          ></div>

          <div class="input-actions">
            <button class="btn-plus" :disabled="uploading" @click="fileInputRef?.click()" title="附件">+</button>
            <button class="btn-send" :disabled="streaming || uploading || !canSend" @click="onSend" title="发送">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useChat } from '~/composables/useChat';
import type { PromptItem } from '~/server/utils/coze';

const { messages, streaming, reset, send, conversationId, sessionId } = useChat();
const messagesEl = ref<HTMLElement | null>(null);
const editableRef = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const canSend = ref(false);
const hasContent = ref(false);

// 临时测试：手动填入 conversation_id / session_id（测完会删除）
const showTest = ref(false);
const testConv = ref('');
const testSess = ref('');
function applyTestIds() {
  if (testConv.value.trim()) conversationId.value = testConv.value.trim();
  if (testSess.value.trim()) sessionId.value = testSess.value.trim();
}

// ===== 文件上传（支持多文件 + 视频） =====
async function onFileSelect(e: Event) {
  const fileInput = e.target as HTMLInputElement;
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  // 重置以便同一批文件可再次选择
  fileInput.value = '';

  uploading.value = true;
  try {
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/cos/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ statusMessage: '上传失败' }));
        throw new Error(`${file.name}: ${err.statusMessage || `HTTP ${res.status}`}`);
      }
      const data = await res.json();
      insertChip({
        file_url: data.url,
        filename: data.filename || file.name,
        type: file.type || 'application/octet-stream',
      });
    }
  } catch (err: any) {
    alert(`上传失败: ${err?.message || '未知错误'}`);
  } finally {
    uploading.value = false;
    updateSendState();
  }
}

// 在光标处插入内联 chip（外层 .inline-chip 占位 + 内层 .inline-chip-inner 药丸）
function insertChip(att: { file_url: string; filename: string; type: string }) {
  const el = editableRef.value;
  if (!el) return;

  const chip = document.createElement('span');
  chip.className = 'inline-chip';
  chip.contentEditable = 'false';
  chip.dataset.url = att.file_url;
  chip.dataset.filename = att.filename;
  chip.dataset.type = att.type;

  const inner = document.createElement('span');
  inner.className = 'inline-chip-inner';
  if (att.type.startsWith('image')) {
    const img = document.createElement('img');
    img.src = att.file_url;
    img.className = 'inline-chip-thumb';
    inner.appendChild(img);
  } else if (att.type.startsWith('video')) {
    const icon = document.createElement('span');
    icon.className = 'inline-chip-icon';
    icon.textContent = '🎬';
    inner.appendChild(icon);
  } else {
    const icon = document.createElement('span');
    icon.className = 'inline-chip-icon';
    icon.textContent = '📎';
    inner.appendChild(icon);
  }
  const name = document.createElement('span');
  name.className = 'inline-chip-name';
  name.textContent = att.filename;
  inner.appendChild(name);

  const close = document.createElement('button');
  close.className = 'inline-chip-close';
  close.textContent = '×';
  close.contentEditable = 'false';
  close.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    chip.remove();
    updateSendState();
  });
  inner.appendChild(close);
  chip.appendChild(inner);

  // 插入到光标位置；否则追加到末尾
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(chip);
    const space = document.createTextNode('\u00A0');
    chip.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    el.appendChild(chip);
    el.appendChild(document.createTextNode('\u00A0'));
  }
  el.focus();
  updateSendState();
}

// 解析输入框为有序 items（文字与 chip 按 DOM 顺序交错）
function parseInput(): PromptItem[] {
  const el = editableRef.value;
  if (!el) return [];
  const items: PromptItem[] = [];
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      if (t) items.push({ kind: 'text', text: t });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      if (elem.classList.contains('inline-chip')) {
        const type = elem.dataset.type || '';
        items.push({
          kind: type.startsWith('image') ? 'image' : 'file',
          file_url: elem.dataset.url || '',
          filename: elem.dataset.filename,
        });
      } else {
        const t = elem.textContent?.trim();
        if (t) items.push({ kind: 'text', text: t });
      }
    }
  });
  return items;
}

function updateSendState() {
  const el = editableRef.value;
  if (!el) {
    canSend.value = false;
    hasContent.value = false;
    return;
  }
  const txt = el.textContent?.trim() || '';
  const chipCount = el.querySelectorAll('.inline-chip').length;
  canSend.value = !!txt || chipCount > 0;
  hasContent.value = canSend.value;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

function onSend() {
  const items = parseInput();
  if (!items.length) return;
  const el = editableRef.value;
  if (el) el.innerHTML = '';
  updateSendState();
  send(items);
}

onMounted(() => updateSendState());

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function renderText(text: string) {
  if (!text) return '';
  let h = escapeHtml(text);
  h = h.replace(/```([\s\S]*?)```/g, (_m, c) => `<pre><code>${c.replace(/^\n/, '')}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\n/g, '<br>');
  return h;
}

// 自动滚动到底部
watch(
  messages,
  async () => {
    await nextTick();
    if (messagesEl.value) {
      messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' });
    }
  },
  { deep: true }
);
</script>

<style>
/* ===== 外层容器 ===== */
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
  position: relative;
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
  width: 64px; height: 64px; border-radius: 50%;
  background: linear-gradient(135deg, #c9a06c, #ddb589);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.bot-emoji-lg { font-size: 32px; }
.bot-name { font-size: 16px; font-weight: 600; color: #e8e8e8; margin-top: 4px; }
.bot-desc { font-size: 13px; color: #888; line-height: 1.65; text-align: center; max-width: 500px; }

/* ===== 消息列表 ===== */
.messages {
  flex: 1; overflow-y: auto;
  padding: 16px 24px 16px;
  display: flex; flex-direction: column; gap: 12px; min-height: 80px;
}

.msg { display: flex; gap: 8px; max-width: 100%; }
.msg.user { justify-content: flex-end; }
.msg.assistant { justify-content: flex-start; }

.avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: #252525; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 2px;
}
.bot-emoji-sm { font-size: 15px; }

/* ===== 气泡 ===== */
.bubble {
  border-radius: 14px; padding: 10px 14px; line-height: 1.7;
  font-size: 14px; white-space: pre-wrap; word-break: break-word;
  max-width: calc(100% - 42px);
}
.bubble.user { background: #2a2a2a; color: #ddd; }

/* 用户消息内附件 */
.msg-attachments { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.msg-att-item { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #bbb; line-height: 1.5; }
.msg-att-thumb { width: 20px; height: 20px; border-radius: 3px; object-fit: cover; flex-shrink: 0; }
.msg-att-icon { font-size: 13px; line-height: 1; flex-shrink: 0; }
.msg-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }

.bubble.assistant { background: #222; color: #ccc; max-width: calc(100% - 42px); }

/* ===== 打字动画 ===== */
.typing { display: inline-flex; align-items: center; gap: 4px; padding: 4px 0 !important; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: #555; animation: bounce 1.4s infinite ease-in-out both; }
.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }
@keyframes bounce { 0%,80%,100% { transform: scale(0.6); opacity: 0.35; } 40% { transform: scale(1); opacity: 1; } }

/* ===== 代码块 ===== */
.bubble pre { background: #0d1117; color: #c9d1d9; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; margin: 6px 0; }
.bubble code { background: #333; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace,'Cascadia Code','Fira Code',monospace; font-size: 13px; color: #e8b88a; }
.bubble.user code { background: rgba(255,255,255,0.08); color: #ccc; }

/* ===== 输入区 ===== */
.composer { padding: 14px 18px 18px; flex-shrink: 0; }
.hidden-file { display: none; }

.input-box {
  display: flex; flex-direction: column;
  background: #1e1e1e; border: 1px solid #333; border-radius: 14px;
  padding: 10px 12px 8px;
  transition: border-color 0.2s;
}
.input-box:focus-within { border-color: #444; }

/* contenteditable 输入框 */
.inline-input {
  width: 100%; min-height: 22px; max-height: 160px; overflow-y: auto;
  border: none; background: transparent; color: #ccc;
  font-size: 14px; font-family: inherit; outline: none;
  padding: 0 2px; line-height: 22px;           /* 固定行高 22px */
  word-break: break-word; white-space: pre-wrap;
  position: relative;               /* 让 ::before 的 absolute 定位相对于输入框本身 */
}
.inline-input.is-empty::before {
  content: attr(data-placeholder);
  color: #555; pointer-events: none;
  position: absolute; left: 2px; top: 0;
}

/*
 * 内联 chip — 深色药丸背景，缩略图+文件名一行排列，与文字严格对齐（行高 22px）。
 * 外层 .inline-chip 仅作 inline-block 占位（锁 22px 不撑行），
 * 内层 .inline-chip-inner 才是可见的药丸。
 */
.inline-chip {
  display: inline-block;
  vertical-align: middle;         /* 与文字垂直居中对齐 */
  height: 22px;                    /* = .inline-input 的 line-height */
  line-height: 22px;
  overflow: hidden;
  user-select: none;
}
.inline-chip-inner {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #2a2a2a;            /* 深色背景 */
  border-radius: 6px;
  padding: 0 7px;
  font-size: 13px;
  color: #ddd;                    /* 浅色文字 */
  max-width: 220px;
  height: 22px;
  box-sizing: border-box;
  border: none;
}
.inline-chip:hover .inline-chip-inner { background: #333; }
.inline-chip-thumb {
  width: 16px; height: 16px; border-radius: 3px;
  object-fit: cover; flex-shrink: 0;
}
.inline-chip-icon { font-size: 13px; flex-shrink: 0; }
.inline-chip-name {
  font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 140px;
}
.inline-chip-close {
  width: 16px; height: 16px; border-radius: 50%;
  border: none; background: transparent; color: #999;
  font-size: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; padding: 0;
  opacity: 0; transition: opacity 0.15s;
}
.inline-chip:hover .inline-chip-close { opacity: 1; }
.inline-chip-close:hover { background: rgba(255,255,255,0.1); color: #ddd; }

.input-actions {
  display: flex; align-items: center; justify-content: space-between;
  padding-top: 6px; margin-top: 4px;
}

.btn-plus {
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid #444; background: transparent; color: #888;
  font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s; flex-shrink: 0;
}
.btn-plus:hover { background: #2a2a2a; color: #bbb; border-color: #555; }

.btn-send {
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid #444; background: transparent; color: #555;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s; flex-shrink: 0;
}
.btn-send:not(:disabled) { color: #aaa; border-color: #666; }
.btn-send:not(:disabled):hover { background: #2a2a2a; color: #ccc; border-color: #777; }
.btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

/* ===== 滚动条 ===== */
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
.messages::-webkit-scrollbar-thumb:hover { background: #444; }

/* ===== 临时测试面板 ===== */
.dbg-toggle {
  position: absolute; top: 8px; right: 8px; z-index: 20;
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid #444; background: #2a2a2a; color: #ccc;
  font-size: 15px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.dbg-toggle:hover { background: #333; }
.dbg-panel {
  position: absolute; top: 44px; right: 8px; z-index: 20;
  width: 280px; background: #0f0f0f; border: 1px dashed #555;
  border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #bbb;
  box-shadow: 0 6px 18px rgba(0,0,0,0.6);
}
.dbg-title { font-size: 12px; font-weight: 600; color: #e0a96c; margin-bottom: 8px; }
.dbg-row { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.dbg-row span { color: #888; }
.dbg-row code { background: #1c1c1c; padding: 3px 6px; border-radius: 4px; word-break: break-all; font-family: ui-monospace,monospace; color: #c9d1d9; }
.dbg-panel hr { border: none; border-top: 1px solid #333; margin: 8px 0; }
.dbg-panel label { display: block; color: #888; margin: 6px 0 3px; }
.dbg-panel input {
  width: 100%; box-sizing: border-box; background: #1c1c1c;
  border: 1px solid #444; border-radius: 6px; color: #ccc;
  padding: 5px 7px; font-size: 12px; font-family: ui-monospace,monospace; outline: none;
}
.dbg-panel input:focus { border-color: #e0a96c; }
.dbg-btns { display: flex; gap: 8px; margin-top: 10px; }
.dbg-apply, .dbg-close { flex: 1; padding: 6px 0; border-radius: 6px; border: 1px solid #555; background: #2a2a2a; color: #ddd; font-size: 12px; cursor: pointer; }
.dbg-apply { background: #3a2e1a; border-color: #e0a96c; color: #f0c890; }
.dbg-apply:hover { background: #4a3a22; }
.dbg-close:hover { background: #333; }
</style>
