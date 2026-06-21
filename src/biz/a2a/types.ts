// ============================================================================
// A2A Protocol Types
// ============================================================================

/**
 * A2A Agent Skill
 */
export interface IAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  inputMode?: ('text' | 'image' | 'file')[];
  outputMode?: ('text' | 'image' | 'file')[];
}

/**
 * A2A Agent Card - served at /.well-known/agent.json
 */
export interface IAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities?: {
    streaming?: boolean;
  };
  securitySchemes?: Array<{
    apiKey?: {
      type: 'apiKey';
      in: 'header';
      name: string;
    };
  }>;
  skills?: IAgentSkill[];
}

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

export interface IJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface IJsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result: T;
}

export interface IJsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type IJsonRpcResponse<T = unknown> = IJsonRpcSuccessResponse<T> | IJsonRpcErrorResponse;

// ============================================================================
// A2A Message Types
// ============================================================================

export interface IA2AMessagePart {
  type?: 'text' | 'image' | 'file';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface IA2AMessage {
  role: 'user' | 'assistant' | 'system';
  parts: IA2AMessagePart[];
}

// ============================================================================
// A2A Task Types
// ============================================================================

export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

export interface IA2ATaskStatus {
  state: A2ATaskState;
  message?: string;
  timestamp?: string;
}

export interface IA2ATaskResult {
  taskId: string;
  status: IA2ATaskStatus;
  message?: IA2AMessage;
  createdAt?: string;
  updatedAt?: string;
}

// ============================================================================
// A2A Method Params
// ============================================================================

export interface ITasksSendParams {
  taskId: string;
  message: IA2AMessage;
  skillId?: string;
}

export interface ITasksGetParams {
  taskId: string;
}

export interface ITasksCancelParams {
  taskId: string;
}

// ============================================================================
// A2A Config Types
// ============================================================================

export interface IRemoteAgent {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultSkill?: string;
}

export interface IA2AConfig {
  enabled?: boolean;
  port?: number;
  baseUrl?: string;
  apiKey?: string;
  remoteAgents?: IRemoteAgent[];
}

// ============================================================================
// A2A Internal Types
// ============================================================================

export interface IA2AInternalTask {
  taskId: string;
  conversationId: string;
  prompt: string;
  status: IA2ATaskStatus;
  result?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// ============================================================================
// A2A Error Codes
// ============================================================================

export const A2AErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  TaskNotFound: -32002,
  TaskAlreadyExists: -32003,
  AgentUnavailable: -32004,
} as const;
