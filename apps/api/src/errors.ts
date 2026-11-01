export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  path: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly issues?: ValidationIssue[];

  constructor(
    status: number,
    code: string,
    title: string,
    detail?: string,
    issues?: ValidationIssue[]
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.issues = issues;
  }
}

export function badRequest(code: string, title: string, detail?: string, issues?: ValidationIssue[]): ApiError {
  return new ApiError(400, code, title, detail, issues);
}

export function unauthorized(detail = 'Missing or invalid bearer token'): ApiError {
  return new ApiError(401, 'unauthenticated', 'Unauthorized', detail);
}

export function forbidden(detail = 'Outside the allowed department or role scope'): ApiError {
  return new ApiError(403, 'forbidden', 'Forbidden', detail);
}

export function notFound(entity = 'Resource'): ApiError {
  return new ApiError(404, 'not_found', 'Not found', `${entity} was not found or is outside your scope`);
}

export function conflict(code: string, detail: string): ApiError {
  return new ApiError(409, code, 'Conflict', detail);
}

export function preconditionFailed(detail = 'If-Match does not match the current resource version'): ApiError {
  return new ApiError(412, 'precondition_failed', 'Precondition failed', detail);
}

export function unprocessable(detail: string, issues?: ValidationIssue[]): ApiError {
  return new ApiError(422, 'validation_failed', 'Validation failed', detail, issues);
}

export function serviceUnavailable(detail: string): ApiError {
  return new ApiError(503, 'service_unavailable', 'Service unavailable', detail);
}

export function problemBody(error: ApiError, correlationId: string) {
  return {
    type: `https://errors.cpm-lite.example/${error.code}`,
    title: error.title,
    status: error.status,
    detail: error.detail,
    code: error.code,
    correlation_id: correlationId,
    ...(error.issues ? { errors: error.issues } : {}),
  };
}
