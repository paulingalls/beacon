import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Shared API error format (REQUIREMENTS.md §5.5). The query API (Phase 5) and the
// ingest endpoint (Phase 4) return errors in this exact shape so agents and SDKs
// can parse failures uniformly.

/** The fixed set of API error codes (REQUIREMENTS.md §5.5). */
export type ErrorCode =
  | 'INVALID_PARAMETER'
  | 'MISSING_PARAMETER'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

/** The §5.5 error response body. `parameter` names the offending field when relevant. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    parameter?: string;
  };
}

/** HTTP status per error code (REQUIREMENTS.md §5.5). */
const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  INVALID_PARAMETER: 400,
  MISSING_PARAMETER: 400,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 403,
  INTERNAL_ERROR: 500,
};

/** The HTTP status code for an error code. */
export function errorStatus(code: ErrorCode): ContentfulStatusCode {
  return STATUS_BY_CODE[code];
}

/**
 * Build the §5.5 error body. `parameter` is omitted entirely when not supplied —
 * the key is absent rather than set to undefined, keeping the JSON clean.
 */
export function errorBody(code: ErrorCode, message: string, parameter?: string): ErrorBody {
  return {
    error: parameter === undefined ? { code, message } : { code, message, parameter },
  };
}

/**
 * Write a §5.5 error response with the code-mapped status. Header-agnostic: a
 * caller needing a Retry-After (RATE_LIMITED) sets `c.header('Retry-After', …)`
 * before calling. Shared by the ingest endpoint and the query API.
 */
export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  parameter?: string,
): Response {
  return c.json(errorBody(code, message, parameter), errorStatus(code));
}
