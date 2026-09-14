// 记录落盘：每个会话一个 JSONL 文件。
//
// 为什么要落盘：监听者要读"聊天记录"，而记录只在内存里的话，
// 一次重启就全没了 —— 那监听者就无从谈起。

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(conversationId) {
    // 会话 id 由服务端生成或客户端提供，做一次清洗避免路径穿越
    const safe = String(conversationId).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** 追加一个事件。失败不影响主流程（记录不是关键路径）。 */
  append(conversationId, event) {
    try {
      fs.appendFileSync(this.fileFor(conversationId), `${JSON.stringify(event)}\n`);
    } catch {
      // 忽略
    }
  }

  /** 读一个会话的全部事件。 */
  read(conversationId) {
    try {
      const raw = fs.readFileSync(this.fileFor(conversationId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 列出所有会话 id 与最后活动时间。 */
  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const id = f.slice(0, -'.jsonl'.length);
          const events = this.read(id);
          return { conversationId: id, updatedAt: events.at(-1)?.at || 0, count: events.length };
        })
        .filter((c) => c.count > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }
}

/**
 * 把事件流还原成"人话记录"。
 *
 * 这是监听者真正要读的东西 —— 不是原始事件，而是
 * 「谁在什么时候说了什么」的对话稿。
 */
export function toTranscript(events) {
  const turns = [];
  let current = null;

  for (const e of events) {
    switch (e.type) {
      case 'user/echo':
        turns.push({ role: 'user', text: e.text, at: e.at });
        break;
      case 'message/start':
        current = {
          role: 'assistant',
          agent: e.agent,
          origin: e.origin,
          interrupts: e.interrupts,
          text: '',
          at: e.at,
        };
        turns.push(current);
        break;
      case 'message/text':
        if (current) current.text += e.text;
        break;
      case 'task/created':
        turns.push({ role: 'task', text: `[开始处理] ${e.title}`, at: e.at });
        break;
      case 'task/completed':
        turns.push({ role: 'task', text: '[处理完成]', at: e.at });
        break;
      case 'error':
        turns.push({ role: 'error', text: `${e.code}: ${e.message}`, at: e.at });
        break;
    }
  }

  return turns.filter((t) => t.role !== 'assistant' || t.text.trim());
}

/** 渲染成给模型看的纯文本。 */
export function renderTranscript(turns) {
  const label = { user: '用户', assistant: '助手', task: '（系统）', error: '（出错）' };
  return turns.map((t) => `${label[t.role] ?? t.role}：${t.text}`).join('\n');
}
