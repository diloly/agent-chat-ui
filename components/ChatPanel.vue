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
          <!-- assistant 消息：头像固定在上方，工具调用与回答在同一列堆叠 -->
          <template v-if="m.role === 'assistant'">
            <div class="avatar">
              <span class="bot-emoji-sm">🤖</span>
            </div>
            <div class="assistant-col">
              <!-- 工具调用卡片：不包在气泡里，但与回答共享同一个头像 -->
              <div
                v-for="(tool, ti) in m.toolCalls"
                :key="tool.id || `${tool.name}-${ti}`"
                class="tool-call standalone"
                :class="{ open: tool._open, request: tool.status === 'request' }"
              >
                <div v-if="tool.status === 'request'" class="tool-progress"><div class="tool-progress-bar"></div></div>
                <div class="tool-head" @click="tool._open = !tool._open">
                  <span class="tool-chevron">▸</span>
                  <span class="tool-name">{{ tool.name }}</span>
                  <span class="tool-badge" :class="tool.status === 'request' ? 'req' : 'done'">
                    {{ tool.status === 'request' ? '调用中' : '已完成' }}
                  </span>
                </div>
                <div v-show="tool._open" class="tool-body">
                  <div v-if="tool.arguments" class="tool-section">
                    <div class="tool-section-label">参数</div>
                    <pre class="tool-pre">{{ formatJson(tool.arguments) }}</pre>
                  </div>
                  <div v-if="tool.result" class="tool-section">
                    <div class="tool-section-label">结果</div>
                    <pre class="tool-pre">{{ formatJson(tool.result) }}</pre>
                  </div>
                </div>
              </div>

              <!-- 流式打字指示器：文本到达前显示。位于头像下方；有工具调用时显示在工具卡下方（头像 工具调用 ...） -->
              <div v-if="streaming && i === messages.length - 1 && !m.text" class="bubble assistant">
                <span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
              </div>

              <!-- 助手文本气泡：图片链接解析为内联缩略图，点击放大；加载失败自动重试，仍失败则降级为可点击链接 -->
              <div v-if="m.text" class="bubble assistant">
                <template v-for="(seg, si) in parseContent(m.text, streaming && i === messages.length - 1)" :key="si">
                  <span v-if="seg.type === 'text'" v-html="seg.html"></span>
                  <template v-else>
                    <a
                      v-if="imgBrokenMap[seg.url]"
                      :href="seg.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="md-link img-broken-link"
                    >[图片加载失败 · 点击查看] {{ shortUrl(seg.url) }}</a>
                    <img
                      v-else
                      :key="seg.url"
                      :src="seg.url"
                      class="msg-img-thumb"
                      :class="{ loaded: loadedMap[seg.url] }"
                      @load="onImgLoad(seg.url)"
                      @error="onImgError(seg.url)"
                      @click="openLightbox(seg.url)"
                      loading="lazy"
                      decoding="async"
                    />
                  </template>
                </template>
              </div>
            </div>
          </template>

          <!-- 用户消息气泡 -->
          <template v-else>
            <div class="bubble user">
              <!-- 用户消息附件列表（按发送顺序展示，每张独立一行） -->
              <div v-if="m.attachments?.length" class="msg-attachments">
                <div v-for="(f, j) in m.attachments" :key="j" class="msg-att-item">
                  <img v-if="f.kind === 'image' && f.file_url" :src="f.file_url" class="msg-att-thumb" />
                  <span v-else class="msg-att-icon">📎</span>
                  <span class="msg-att-name">{{ f.filename }}</span>
                </div>
              </div>

              <div v-if="m.text">{{ m.text }}</div>
            </div>
          </template>
        </div>

        <!-- 单独的流式指示器：仅当还没有任何 assistant 消息时 -->
        <div v-if="streaming && !messages.some(m => m.role === 'assistant')" class="msg assistant">
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
            @paste="onPaste"
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

  <!-- 图片灯箱：点击缩略图放大查看 -->
  <div v-if="lightboxUrl" class="lightbox" @click="closeLightbox">
    <img :src="lightboxUrl" class="lightbox-img" @click.stop />
    <button class="lightbox-close" @click.stop="closeLightbox" title="关闭">×</button>
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

// 粘贴时只保留纯文本，丢弃原应用带过来的颜色/背景/字体等 inline style
function onPaste(e: ClipboardEvent) {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text) return;
  document.execCommand('insertText', false, text);
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

// 轻量 Markdown 渲染（标题 / 表格 / 列表 / 引用 / 分割线 / 代码块 / 加粗 / 行内 code）。
// 不引入第三方依赖：先整体 HTML 转义防 XSS，再按块解析。图片链接仍由 parseContent 单独处理。
function renderMarkdown(src: string): string {
  if (!src) return '';
  const text = escapeHtml(src);
  const lines = text.split('\n');

  const isBlockStart = (line: string, next?: string): boolean => {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return true; // hr
    if (/^(#{1,6})\s+/.test(line)) return true;               // heading
    if (/^\s*>\s?/.test(line)) return true;                   // blockquote
    if (/^\s*[-*]\s+/.test(line)) return true;                // ul
    if (/^\s*\d+\.\s+/.test(line)) return true;              // ol
    if (/^\s*```/.test(line)) return true;                    // fenced code
    if (line.includes('|') && next && /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes('-')) return true; // table
    return false;
  };
  const inline = (s: string): string =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');

  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过结束围栏
      html += `<pre><code>${code.join('\n')}</code></pre>`;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lv = h[1].length; html += `<h${lv}>${inline(h[2])}</h${lv}>`; i++; continue; }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }

    // 表格（GFM 管道表）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const splitRow = (r: string): string[] => {
        let s = r.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map((c) => c.trim());
      };
      const aligns = splitRow(lines[i + 1]).map((sep) => {
        const l = sep.startsWith(':'); const r = sep.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
      const th = headers.map((c, idx) => `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</th>`).join('');
      const tb = rows.map((r) => '<tr>' + r.map((c, idx) => `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</td>`).join('') + '</tr>').join('');
      html += `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      html += '<ul>' + items.map((it) => `<li>${inline(it)}</li>`).join('') + '</ul>';
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      html += '<ol>' + items.map((it) => `<li>${inline(it)}</li>`).join('') + '</ol>';
      continue;
    }

    // 段落（收集到空行或块起始前）
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]); i++;
    }
    if (para.length) html += '<p>' + inline(para.join('<br>')) + '</p>';
    else i++; // 空行
  }
  return html;
}

// 把助手文本拆成「文字段」和「图片段」，图片链接内联为缩略图。
// 兼容三种写法：裸 URL、`[文字](url)`、以及 `![](url)`。
type Seg = { type: 'text'; html: string } | { type: 'image'; url: string };
const IMG_TOKEN =
  /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp)[^\s)]*)\)|(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp)[^\s)]*)/gi;

// 图片完整性判定（核心、唯一标准）：URL 后面是否跟了「分隔符」。
// - 非流式：文本已全部到达，直接渲染图片。
// - 流式且 URL 后还有字符（空格/换行/括号/标点等）：说明该 URL 已结束（sign 等参数已拼完），渲染图片。
// - 流式且 URL 位于文本末尾（后面无字符）：sign 可能仍在逐字到达，先渲染成可点击链接，拼完后再变缩略图。
function parseContent(text: string, streaming = false): Seg[] {
  if (!text) return [];
  const segs: Seg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  IMG_TOKEN.lastIndex = 0;

  while ((m = IMG_TOKEN.exec(text))) {
    if (m.index > last) {
      segs.push({ type: 'text', html: renderMarkdown(text.slice(last, m.index)) });
    }
    const url = m[2] || m[4] || m[5];
    if (url) {
      const after = m.index + m[0].length;
      const complete = !streaming || after < text.length; // 有分隔符 = 完整
      if (complete) {
        segs.push({ type: 'image', url });
      } else {
        const linkText = m[1] || m[3] || url;
        segs.push({
          type: 'text',
          html: `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${escapeHtml(linkText)}</a>`,
        });
      }
    }
    last = IMG_TOKEN.lastIndex;
  }
  if (last < text.length) {
    segs.push({ type: 'text', html: renderMarkdown(text.slice(last)) });
  }
  return segs;
}

// 图片灯箱
const lightboxUrl = ref<string>('');
function openLightbox(u: string) {
  lightboxUrl.value = u;
}
function closeLightbox() {
  lightboxUrl.value = '';
}

// 图片加载状态：加载完成前用 shimmer 骨架占位，避免 progressive JPEG 闪烁
const loadedMap = ref<Record<string, boolean>>({});
function onImgLoad(u: string) {
  loadedMap.value[u] = true;
}

// 图片加载失败（极少见的网络抖动等）：直接降级为可点击链接，不做重试循环。
// 注：流式时的「损坏」问题已通过 parseContent 的「分隔符完整性判定」在根因上解决——
// 只有完整 URL 才会被渲染成 <img>，不完整的中间态 sign 永远只显示链接，不会被提前加载。
const imgBrokenMap = ref<Record<string, boolean>>({});
function onImgError(u: string) {
  imgBrokenMap.value = { ...imgBrokenMap.value, [u]: true };
}

// 取 URL 中可读的一段用于失败提示（去掉冗长签名参数）
function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname.split('/').pop() || url.pathname;
    return path.length > 28 ? path.slice(0, 28) + '…' : path;
  } catch {
    return u.length > 40 ? u.slice(0, 40) + '…' : u;
  }
}

// 工具调用参数/结果：尽量美化 JSON，解析失败则原样显示
function formatJson(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
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
  height: 100vh;                 /* 固定视口高度，给卡片一个可约束的上限，否则内容会撑高整页 */
  padding: 28px 20px;
  background: #121212;
  box-sizing: border-box;
}

/* ===== 卡片 ===== */
.chat-card {
  width: 100%;
  max-width: 840px;
  max-height: 100%;               /* 不超过视口（配合 .chat-wrap 的 100vh 高度） */
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
  flex: 1 1 auto;
  min-height: 0;                 /* 关键：flex 子项必须 min-height:0 才能真正触发 overflow 滚动，否则会撑高父容器 */
  overflow-y: auto;
  padding: 16px 24px 16px;
  display: flex; flex-direction: column; gap: 12px;
}

.msg { display: flex; gap: 8px; max-width: 100%; width: 100%; }
.msg.user { justify-content: flex-end; }
.msg.assistant { justify-content: flex-start; }
.msg.tool { justify-content: flex-start; }

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

/* ===== 助手消息内联图片（图片链接 → 缩略图，点击放大） ===== */
.msg-img-thumb {
  display: inline-block;
  vertical-align: top;
  width: 132px;
  height: 154px;            /* 竖版 1080×1260 ≈ 6:7，缩略图同比例 */
  object-fit: cover;
  border-radius: 8px;
  margin: 4px 8px 4px 0;
  cursor: zoom-in;
  border: 1px solid #333;
  background: linear-gradient(90deg, #1a1a1a 25%, #252525 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  opacity: 0;
  transition: opacity 0.25s ease, transform 0.12s ease, border-color 0.12s ease;
  animation: shimmer 1.4s infinite linear;
}
.msg-img-thumb.loaded {
  opacity: 1;
  background: #111;
  animation: none;
}
.msg-img-thumb:hover { transform: scale(1.03); border-color: #666; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ===== 图片灯箱 ===== */
.lightbox {
  position: fixed; inset: 0;
  z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
  padding: 32px;
  box-sizing: border-box;
}
.lightbox-img {
  max-width: 92vw; max-height: 92vh;
  object-fit: contain;
  border-radius: 10px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
}
.lightbox-close {
  position: absolute; top: 18px; right: 22px;
  width: 38px; height: 38px; border-radius: 50%;
  border: none; background: rgba(255, 255, 255, 0.12); color: #fff;
  font-size: 22px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.lightbox-close:hover { background: rgba(255, 255, 255, 0.24); }

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

/* ===== Markdown 链接（流式时替代缩略图，非流式时普通链接也可点） ===== */
.bubble a.md-link { color: #6fa8ff; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
.bubble a.md-link:hover { color: #8fbfff; }
.bubble a.img-broken-link {
  display: inline-block;
  margin: 4px 0;
  padding: 6px 10px;
  border: 1px solid #5a4a2a;
  border-radius: 8px;
  background: rgba(120, 90, 30, 0.18);
  color: #e3b96b;
  text-decoration: none;
  font-size: 13px;
}

/* ===== Markdown 富文本（标题/表格/列表/引用等，对标官方 iframe 渲染） ===== */
.bubble h1, .bubble h2, .bubble h3, .bubble h4 { margin: 8px 0 6px; line-height: 1.4; color: #e8e8e8; font-weight: 600; }
.bubble h1 { font-size: 18px; }
.bubble h2 { font-size: 16px; }
.bubble h3 { font-size: 15px; }
.bubble h4 { font-size: 14px; }
.bubble p { margin: 6px 0; }
.bubble ul, .bubble ol { margin: 6px 0; padding-left: 22px; }
.bubble li { margin: 2px 0; }
.bubble blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid #444; color: #aaa; background: rgba(255,255,255,0.03); border-radius: 0 6px 6px 0; }
.bubble hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
.bubble table.md-table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12.5px; }
.bubble table.md-table th, .bubble table.md-table td { border: 1px solid #3a3a3a; padding: 6px 8px; text-align: left; vertical-align: top; }
.bubble table.md-table th { background: #252525; color: #ddd; font-weight: 600; }
.bubble table.md-table td { color: #ccc; }
.bubble table.md-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }

/* ===== 工具调用卡片（可展开，对标官方 iframe 的 function call box） ===== */
.tool-calls { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.tool-call {
  position: relative;
  border: 1px solid #333; border-radius: 10px; overflow: hidden;
  background: #161616; font-size: 13px;
}
/* assistant 列：头像右侧，工具调用与回答垂直堆叠 */
.assistant-col {
  display: flex; flex-direction: column; gap: 12px;
  flex: 1;
  max-width: calc(100% - 38px);   /* 头像 30px + gap 8px */
}

/* standalone：在 assistant-col 内部占满该列宽度 */
.tool-call.standalone {
  width: 100%;
  max-width: 100%;
}
.tool-call.request { border-color: rgba(111, 194, 138, 0.35); }
.tool-progress {
  position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
  background: rgba(111, 194, 138, 0.18); overflow: hidden; z-index: 1;
}
.tool-progress-bar {
  height: 100%; width: 45%;
  background: linear-gradient(90deg, transparent, #7fdca0, transparent);
  animation: toolProgressMove 1.3s ease-in-out infinite;
}
@keyframes toolProgressMove {
  0% { transform: translateX(-160%); }
  100% { transform: translateX(360%); }
}
.tool-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer; user-select: none;
  background: #1e1e1e;
}
.tool-head:hover { background: #242424; }
.tool-chevron {
  color: #888; font-size: 11px; transition: transform 0.15s;
  display: inline-block; transform: rotate(0deg);
}
.tool-call.open .tool-chevron { transform: rotate(90deg); }
.tool-name { color: #d8c08a; font-weight: 600; font-family: ui-monospace,'Cascadia Code',monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; flex-shrink: 0; }
.tool-badge.req { background: rgba(220,180,90,0.15); color: #d8b45a; }
.tool-badge.done { background: rgba(90,170,120,0.15); color: #6fc28a; }
.tool-body { padding: 8px 10px; border-top: 1px solid #2a2a2a; }
.tool-section { margin-bottom: 6px; }
.tool-section:last-child { margin-bottom: 0; }
.tool-section-label { color: #777; font-size: 11px; margin-bottom: 3px; }
.tool-pre {
  background: #0d1117; color: #c9d1d9; padding: 8px 10px; border-radius: 6px;
  overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 0;
  font-family: ui-monospace,'Cascadia Code',monospace; white-space: pre-wrap; word-break: break-word;
}

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
