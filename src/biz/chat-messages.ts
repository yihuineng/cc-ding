import fs from 'fs';
import path from 'path';
import type { IChatMessage } from './types';

const DB_FILE = 'messages.db';
const JSON_FILE = 'messages.json';

// 数据库连接缓存（避免重复打开）
const dbCache = new Map<string, any>();

/**
 * 获取或创建数据库连接
 */
function getDatabase(convDir: string): any {
  const dbPath = path.join(convDir, DB_FILE);

  if (dbCache.has(dbPath)) {
    return dbCache.get(dbPath);
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
 * 检查并执行 JSON -> SQLite 迁移
 */
function migrateIfNeeded(convDir: string): void {
  const jsonPath = path.join(convDir, JSON_FILE);
  const dbPath = path.join(convDir, DB_FILE);

  // 已迁移或无 JSON 文件
  if (!fs.existsSync(jsonPath) || fs.existsSync(dbPath)) {
    return;
  }

  try {
    // 读取 JSON
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(content) as { messages: IChatMessage[] };

    if (!data.messages || data.messages.length === 0) {
      // 空文件，直接备份
      fs.renameSync(jsonPath, jsonPath + '.bak');
      console.log(`[chat-messages] ✅ 空 JSON 文件已备份: ${jsonPath}.bak`);
      return;
    }

    // 批量插入到 SQLite
    const db = getDatabase(convDir);
    const insert = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, sender_staff_id, sender_nick, source, timestamp, attachments, quote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((messages: IChatMessage[]) => {
      for (const msg of messages) {
        insert.run(
          msg.id,
          convDir,
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
    });

    insertMany(data.messages);

    // 迁移成功，备份原文件
    fs.renameSync(jsonPath, jsonPath + '.bak');
    console.log(`[chat-messages] ✅ 已迁移 ${data.messages.length} 条消息到 SQLite: ${dbPath}`);
  } catch (err) {
    console.error('[chat-messages] ❌ 迁移失败，保留原 JSON 文件:', err);
    // 迁移失败，不删除原文件
  }
}

/**
 * 追加消息到数据库
 * @param opts.replaceLastAssistant 如果为 true，替换最后一条 assistant 消息（用于 web 会话避免重试导致重复）
 */
export function appendChatMessage(convDir: string, msg: IChatMessage, opts?: { replaceLastAssistant?: boolean }): void {
  // 自动迁移
  migrateIfNeeded(convDir);

  const db = getDatabase(convDir);

  // replaceLastAssistant 逻辑
  if (opts?.replaceLastAssistant && msg.role === 'assistant') {
    const lastMsg = db.prepare(`
      SELECT id, timestamp FROM messages
      WHERE conversation_id = ? AND role = 'assistant' AND source = 'web'
      ORDER BY timestamp DESC LIMIT 1
    `).get(convDir) as any;

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
    convDir,
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

export function readChatMessages(
  convDir: string,
  opts?: { since?: number; limit?: number },
): IChatMessage[] {
  // 自动迁移
  migrateIfNeeded(convDir);

  const db = getDatabase(convDir);

  let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
  const params: any[] = [ convDir ];

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
export function closeDatabase(convDir: string): void {
  const dbPath = path.join(convDir, DB_FILE);
  if (dbCache.has(dbPath)) {
    const db = dbCache.get(dbPath);
    db.close();
    dbCache.delete(dbPath);
  }
}
