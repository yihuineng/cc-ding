import fs from 'fs';
import path from 'path';
import type { DingClaude } from './cc-ding-cli';

// ==================== 常量 ====================

/** 预设模型列表（仅 Anthropic 官方模型） */
const PRESET_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-4-20251001',
];

// ==================== 持久化路径 ====================

/**
 * 获取 model.json 持久化文件路径
 */
function getModelFilePath(dc: DingClaude): string {
  const clientDir = dc.getClientDir();
  return path.join(clientDir, 'model.json');
}

// ==================== 数据加载/保存 ====================

interface IModelData {
  models: string[];
  defaultModel?: string;
}

/**
 * 加载模型列表（包含预设 + 用户自定义）
 */
function loadModelData(dc: DingClaude): IModelData {
  const filePath = getModelFilePath(dc);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<IModelData>;
      return {
        models: Array.isArray(data.models) ? data.models : [ ...PRESET_MODELS ],
        defaultModel: data.defaultModel,
      };
    }
  } catch (err) {
    console.warn(`[model] 加载 model.json 失败:`, err);
  }
  return { models: [ ...PRESET_MODELS ], defaultModel: undefined };
}

/**
 * 保存模型列表
 */
function saveModelData(dc: DingClaude, data: IModelData): void {
  const filePath = getModelFilePath(dc);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[model] 保存 model.json 失败:`, err);
  }
}

// ==================== 导出函数 ====================

/**
 * 加载模型列表（去重后的完整列表）
 */
export function loadModelOptions(dc: DingClaude): string[] {
  const data = loadModelData(dc);
  return data.models;
}

/**
 * 添加模型（去重）
 */
export function addModelOptions(dc: DingClaude, newModels: string[]): string[] {
  const data = loadModelData(dc);
  const set = new Set(data.models);
  for (const m of newModels) {
    set.add(m);
  }
  data.models = Array.from(set);
  saveModelData(dc, data);
  return data.models;
}

/**
 * 移除模型
 */
export function removeModelOptions(dc: DingClaude, toRemove: string[]): string[] {
  const data = loadModelData(dc);
  const removeSet = new Set(toRemove.map(s => s.trim()));
  data.models = data.models.filter(m => !removeSet.has(m));
  // 如果移除的是默认模型，清空默认
  if (data.defaultModel && removeSet.has(data.defaultModel)) {
    data.defaultModel = undefined;
  }
  saveModelData(dc, data);
  return data.models;
}

/**
 * 初始化预设模型列表（首次启动时，确保预设模型存在）
 */
export function initModelOptions(dc: DingClaude): string[] {
  const data = loadModelData(dc);
  const set = new Set(data.models);
  let changed = false;
  for (const m of PRESET_MODELS) {
    if (!set.has(m)) {
      data.models.push(m);
      changed = true;
    }
  }
  if (changed) {
    saveModelData(dc, data);
  }
  return data.models;
}

/**
 * 获取当前生效的模型（优先级：会话级 > 全局 > 默认）
 */
export function resolveCurrentModel(dc: DingClaude, conversationId: string): string | undefined {
  const convCfg = dc.getConversationConfig(conversationId);
  // 会话级 model 优先
  if (convCfg?.model) return convCfg.model;
  // 全局 model
  if (dc.config.model) return dc.config.model;
  // model.json 中的 defaultModel
  const data = loadModelData(dc);
  if (data.defaultModel) return data.defaultModel;
  return undefined;
}

/**
 * 设置全局默认模型（同时保存到 model.json 和 config.json）
 */
export function setGlobalModel(dc: DingClaude, modelName: string): void {
  // 保存到 model.json
  const data = loadModelData(dc);
  data.defaultModel = modelName;
  saveModelData(dc, data);

  // 同步到 config.json 的全局 model 字段
  dc.config.model = modelName;
  const { saveClientConfig } = require('./api-key-manager');
  saveClientConfig(dc);
}

/**
 * 设置会话级模型
 */
export function setConversationModel(dc: DingClaude, conversationId: string, modelName: string): void {
  const convCfg = dc.getConversationConfig(conversationId);
  if (convCfg) {
    convCfg.model = modelName;
    const { saveClientConfig } = require('./api-key-manager');
    saveClientConfig(dc);
  }
}
