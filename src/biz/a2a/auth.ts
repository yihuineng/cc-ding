import type http from 'http';
import { A2AErrorCode } from './types';

/**
 * Authenticate incoming request using API key.
 * Returns null if authenticated, or an error response object.
 */
export function authenticateRequest(
  req: http.IncomingMessage,
  expectedApiKey?: string,
): { code: number; message: string } | null {
  if (!expectedApiKey) {
    return null;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    if (authHeader.slice(7) === expectedApiKey) return null;
  }

  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader === expectedApiKey) return null;

  return {
    code: A2AErrorCode.Unauthorized,
    message: 'Unauthorized: invalid or missing API key',
  };
}
