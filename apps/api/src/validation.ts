import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { OpenAPI } from 'openapi-types';
import { badRequest, type ValidationIssue } from './errors.js';

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; keyword?: string; message?: string }> | null;
}

interface AjvInstance {
  compile: (schema: object) => CompiledValidator;
}

const Ajv2020 = ((Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import) as new (
  options: Record<string, unknown>
) => AjvInstance;

const addFormats = (((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (
  ajv: unknown
) => void);

export interface ValidationBundle {
  document: OpenAPI.Document;
  validators: Map<string, CompiledValidator>;
}

export async function loadValidationBundle(specPath: string): Promise<ValidationBundle> {
  const document = (await SwaggerParser.bundle(specPath)) as OpenAPI.Document;
  const dereferenced = (await SwaggerParser.dereference(specPath)) as OpenAPI.Document;

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const validators = new Map<string, CompiledValidator>();
  const schemas = (dereferenced as unknown as { components?: { schemas?: Record<string, object> } }).components?.schemas ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    validators.set(name, ajv.compile(schema));
  }

  return { document, validators };
}

export function validateBody(
  bundle: ValidationBundle,
  schemaName: string | undefined,
  body: unknown
): void {
  if (!schemaName) return;
  const validate = bundle.validators.get(schemaName);
  if (!validate) {
    throw new Error(`No validator registered for schema ${schemaName}`);
  }
  if (validate(body)) return;

  const issues: ValidationIssue[] = (validate.errors ?? []).map((error) => ({
    severity: 'error',
    path: error.instancePath || '/',
    code: error.keyword ?? 'invalid',
    message: error.message ?? 'Invalid value',
  }));

  throw badRequest('request_validation_failed', 'Request validation failed', 'One or more request fields are invalid', issues);
}
