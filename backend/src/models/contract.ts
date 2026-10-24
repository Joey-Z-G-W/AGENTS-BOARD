import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ApiError } from './errors.js';

export const contract = JSON.parse(readFileSync(new URL('../../../_docs/api/openapi.json', import.meta.url), 'utf8'));
const schemaId = 'https://agents-board.local/contract';
const schemas = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
const validator = new Ajv2020({ strict: false, allErrors: false, coerceTypes: false, removeAdditional: false });
addFormats.default(validator);
validator.addSchema({ $id: schemaId, $defs: schemas });
const compiled = new Map<string, ReturnType<typeof validator.compile>>();

export function validateModel(name: string, value: unknown): boolean {
  let validate = compiled.get(name);
  if (!validate) {
    validate = validator.compile({ $ref: schemaId + '#/$defs/' + name });
    compiled.set(name, validate);
  }
  return !!validate(value);
}

export function parseBody<Result>(name: string, value: unknown): Result {
  if (!validateModel(name, value)) throw new ApiError(400, 'INVALID_REQUEST', '请求体不符合接口契约。');
  return value as Result;
}

export function identifier(value: string): string {
  if (!value || value.length > 256) throw new ApiError(400, 'INVALID_REQUEST', '标识格式无效。');
  return value;
}
