import fs from 'fs';
import path from 'path';
import os from 'os';
import type { IChatMessage } from './types';

const DB_FILE = 'messages.db';

// 数据库连接缓存（避免重复打开）
const dbCache = new Map<string, any>();

/**
 * 获取客户端数据库目录（~/.cc-ding/clientId/）
 */
function getClientDbDir(clientId: string): string {
  return path.join(os.homedir(), '.cc-ding', clientId);
}

/**
 * 获取或创建数据库连接
 * 所有会话共享一个数据库，存放在 ~/.cc-ding/clientId/messages.db
 */
function getDatabase(clientId: string): any {
  const clientDbDir = getClientDbDir(clientId);
  const dbPath = path.join(clientDbDir, DB_FILE);

  if (dbCache.has(dbPath)) {
    return dbCache.get(dbPath);
  }

  // 确保目录存在
  if (!fs.existsSync(clientDbDir)) {
    fs.mkdirSync(clientDbDir, { recursive: true });
  }

  // 延迟加载 better-sqlite3，避免未安装时启动失败
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('[chat-messages] ❌ better-sqlite3 未安装，请运行: npm install better-sqlite3');
    throw new Error('better-sqlite3 is required. Run: npm install better-sqlite3');
  }

  const db = new Database(dbPath);

  // 启用 WAL 模式（提升并发性能）
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // 初始化表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      sender_staff_id TEXT,
      sender_nick TEXT,
      source TEXT NOT NULL CHECK(source IN ('ding', 'web')),
      timestamp INTEGER NOT NULL,
      attachments TEXT,
      quote TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_timestamp
      ON messages(conversation_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_conversation_role
      ON messages(conversation_id, role, timestamp);
  `);

  dbCache.set(dbPath, db);
  return db;
}

/**
 * 追加消息到数据库
 * @param clientId 客户端ID，用于定位数据库文件
 * @param conversationId 会话ID，用于区分不同会话的消息
 * @param msg 消息对象
 * @param opts.replaceLastAssistant 如果为 true，替换最后一条 assistant 消息（用于 web 会话避免重试导致重复）
 */
export function appendChatMessage(
  clientId: string,
  conversationId: string,
  msg: IChatMessage,
  opts?: { replaceLastAssistant?: boolean },
): void {
  const db = getDatabase(clientId);

  // replaceLastAssistant 逻辑
  if (opts?.replaceLastAssistant && msg.role === 'assistant') {
    const lastMsg = db.prepare(`
      SELECT id, timestamp FROM messages
      WHERE conversation_id = ? AND role = 'assistant' AND source = 'web'
      ORDER BY timestamp DESC LIMIT 1
    `).get(conversationId) as any;

    if (lastMsg && Math.abs(msg.timestamp - lastMsg.timestamp) < 10000) {
      db.prepare(`
        UPDATE messages SET content = ?, timestamp = ? WHERE id = ?
      `).run(msg.content, msg.timestamp, lastMsg.id);
      return;
    }
  }

  // 插入新消息
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, sender_staff_id, sender_nick, source, timestamp, attachments, quote)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    conversationId,
    msg.role,
    msg.content,
    msg.senderStaffId || null,
    msg.senderNick || null,
    msg.source,
    msg.timestamp,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.quote ? JSON.stringify(msg.quote) : null,
  );
}

/**
 * 读取会话消息
 * @param clientId 客户端ID，用于定位数据库文件
 * @param conversationId 会话ID，用于查询特定会话的消息
 * @param opts 查询选项
 */
export function readChatMessages(
  clientId: string,
  conversationId: string,
  opts?: { since?: number; limit?: number; source?: 'ding' | 'web' },
): IChatMessage[] {
  const db = getDatabase(clientId);

  let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
  const params: any[] = [ conversationId ];

  // 按来源过滤
  if (opts?.source !== undefined) {
    sql += ' AND source = ?';
    params.push(opts.source);
  }

  if (opts?.since !== undefined) {
    sql += ' AND timestamp > ?';
    params.push(opts.since);
  }

  sql += ' ORDER BY timestamp ASC';

  if (opts?.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as any[];

  return rows.map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    senderStaffId: row.sender_staff_id || undefined,
    senderNick: row.sender_nick || undefined,
    source: row.source,
    timestamp: row.timestamp,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    quote: row.quote ? JSON.parse(row.quote) : undefined,
  }));
}

/**
 * 关闭数据库连接（用于测试或清理）
 */
export function closeDatabase(clientId: string): void {
  const clientDbDir = getClientDbDir(clientId);
  const dbPath = path.join(clientDbDir, DB_FILE);
  if (dbCache.has(dbPath)) {
    const db = dbCache.get(dbPath);
    db.close();
    dbCache.delete(dbPath);
  }
}
