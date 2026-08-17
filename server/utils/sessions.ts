// 会话记录持久化（conversation_id + session_id + 完整 messages）。
// 用服务端 JSON 文件存储，避免引入数据库；刷新/重进页面后可由前端读取恢复会话列表与历史消息。
//
// 存储内部采用「以 conversation_id 为 key 的对象」（类哈希表），查找/删除为 O(1)；
// 对外通过 SessionStore 接口暴露，当前用 JsonFileStore 实现，将来换数据库只需新增一个实现并在底部替换实例。

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

export interface SessionRecord {
  conversation_id: string;
  session_id: string;
  updatedAt: number; // epoch ms
  messages?: unknown[]; // 完整对话消息（本地刷新后回显用，不依赖 Coze）
}

export type SessionMap = Record<string, SessionRecord>;

// ---- 存储抽象：将来换数据库只需新增一个实现并在底部替换实例 ----
export interface SessionStore {
  list(): Promise<SessionRecord[]>;
  get(conversationId: string): Promise<SessionRecord | null>;
  upsert(rec: { conversation_id: string; session_id: string; messages?: unknown[] }): Promise<SessionRecord>;
  delete(conversationId: string): Promise<boolean>;
}

// ---- JSON 文件实现（以 conversation_id 为 key 的对象，类哈希表）----
class JsonFileStore implements SessionStore {
  private dir = resolve(process.cwd(), 'server/data');
  private file = resolve(this.dir, 'sessions.json');

  private async ensureFile(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await fs.writeFile(this.file, '{}', 'utf8');
    }
  }

  // 读取为 keyed 对象；兼容旧版「数组」格式（自动迁移），解析失败则回退空对象。
  private async readMap(): Promise<SessionMap> {
    await this.ensureFile();
    const raw = await fs.readFile(this.file, 'utf8');
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 旧格式迁移：数组 -> 以 conversation_id 为 key 的对象
        const map: SessionMap = {};
        for (const r of parsed as SessionRecord[]) {
          if (r?.conversation_id) map[r.conversation_id] = r;
        }
        return map;
      }
      return (parsed && typeof parsed === 'object' ? parsed : {}) as SessionMap;
    } catch {
      return {};
    }
  }

  private async writeMap(map: SessionMap): Promise<void> {
    await this.ensureFile();
    await fs.writeFile(this.file, JSON.stringify(map, null, 2), 'utf8');
  }

  async list(): Promise<SessionRecord[]> {
    const map = await this.readMap();
    return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<SessionRecord | null> {
    const map = await this.readMap();
    return map[conversationId] ?? null;
  }

  async upsert(rec: { conversation_id: string; session_id: string; messages?: unknown[] }): Promise<SessionRecord> {
    const map = await this.readMap();
    const prev = map[rec.conversation_id];
    const record: SessionRecord = {
      conversation_id: rec.conversation_id,
      session_id: rec.session_id,
      updatedAt: Date.now(),
      // messages 仅在调用方显式提供时覆盖（undefined 保留旧值，避免清空历史）
      messages: rec.messages !== undefined ? rec.messages : (prev?.messages ?? []),
    };
    map[rec.conversation_id] = record;
    await this.writeMap(map);
    return record;
  }

  async delete(conversationId: string): Promise<boolean> {
    const map = await this.readMap();
    if (!(conversationId in map)) return false;
    delete map[conversationId];
    await this.writeMap(map);
    return true;
  }
}

// 当前使用的存储实例；将来换 DB 时把这一行换成 new DbStore() 即可，其余代码无需改动。
const store: SessionStore = new JsonFileStore();

// ---- 对外薄封装（保持既有函数签名，API 路由无需改动）----
export async function listSessions(): Promise<SessionRecord[]> {
  return store.list();
}

export async function upsertSession(rec: {
  conversation_id: string;
  session_id: string;
  messages?: unknown[];
}): Promise<SessionRecord> {
  return store.upsert(rec);
}

export async function deleteSession(conversationId: string): Promise<void> {
  await store.delete(conversationId);
}
