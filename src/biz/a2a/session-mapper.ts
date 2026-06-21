import fs from 'fs';
import path from 'path';
import type { IA2AInternalTask } from './types';
import type { DingClaude } from '../cc-ding-cli';

const A2A_TASKS_FILE = 'a2a-tasks.json';

function getFilePath(self: DingClaude): string {
  return path.join(self.getClientDir(), A2A_TASKS_FILE);
}

// In-memory cache, lazily loaded, single source of truth
const cache = new WeakMap<DingClaude, Map<string, IA2AInternalTask>>();

function getCache(self: DingClaude): Map<string, IA2AInternalTask> {
  if (!cache.has(self)) {
    const fp = getFilePath(self);
    const map = new Map<string, IA2AInternalTask>();
    if (fs.existsSync(fp)) {
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (Array.isArray(data)) data.forEach(t => map.set(t.taskId, t));
      } catch { /* ignore */ }
    }
    cache.set(self, map);
  }
  return cache.get(self)!;
}

function flush(self: DingClaude): void {
  try {
    fs.writeFileSync(getFilePath(self), JSON.stringify([ ...getCache(self).values() ], null, 2), 'utf-8');
  } catch (err) {
    console.error('[A2A] Failed to save tasks:', err);
  }
}

export function getOrCreateTaskStore(self: DingClaude): void {
  getCache(self); // lazy load / init
  const fp = getFilePath(self);
  if (!fs.existsSync(fp)) {
    try { fs.writeFileSync(fp, '[]', 'utf-8'); } catch { /* ignore */ }
  }
}

export function saveTask(self: DingClaude, task: IA2AInternalTask): void {
  getCache(self).set(task.taskId, task);
  flush(self);
}

export function getTask(self: DingClaude, taskId: string): IA2AInternalTask | null {
  return getCache(self).get(taskId) || null;
}

export function updateTaskStatus(
  self: DingClaude,
  taskId: string,
  status: IA2AInternalTask['status'],
): void {
  const task = getCache(self).get(taskId);
  if (task) {
    task.status = status;
    task.updatedAt = Date.now();
    if (status.state === 'completed' || status.state === 'failed' || status.state === 'canceled') {
      task.completedAt = Date.now();
    }
    flush(self);
  }
}

export function updateTaskResult(
  self: DingClaude,
  taskId: string,
  result: string,
): void {
  const task = getCache(self).get(taskId);
  if (task) {
    task.result = result;
    task.updatedAt = Date.now();
    flush(self);
  }
}
