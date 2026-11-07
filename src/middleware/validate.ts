import type { RequestHandler } from 'express';
import type { ZodIssue, ZodTypeAny, z } from 'zod';
import { AppError } from '../lib/errors.js';
import { isMessageId, type MessageId } from '../lib/messages.js';

type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

/** "nextFollowUpAt" → "Next follow up" when a route gives no label. */
const humanise = (key: string) => {
  const s = key.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function toField(issue: ZodIssue, labels: Record<string, string>) {
  const field = issue.path.join('.') || '(request)';
  const label = labels[field] ?? labels[String(issue.path[0])] ?? humanise(String(issue.path.at(-1) ?? 'value'));
  const params = { 'Field label': label, ...((issue as { params?: Record<string, string | number> }).params ?? {}) };
  let messageId: MessageId;
  if (issue.code === 'invalid_type' && (issue.received === 'undefined' || issue.received === 'null')) messageId = 'GEN-01';
  else if (isMessageId(issue.message)) messageId = issue.message;
  else messageId = 'VAL-22';
  return { field, messageId, params };
}

/**
 * Validates and REPLACES body/params with the cleaned output (GR-06). Every problem becomes a field
 * error with its exact message ID (GR-03, GR-05): GEN-01 for a missing required field (with its label),
 * the field rule's VAL message otherwise, and GEN-02 on top when two or more fields fail.
 */
export function validate(schemas: Schemas, labels: Record<string, string> = {}): RequestHandler {
  return (req, res, next) => {
    const fields: ReturnType<typeof toField>[] = [];
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        if (part === 'params') throw AppError.notFound(); // a malformed ID can't be a record you can see
        for (const issue of result.error.issues) fields.push(toField(issue, labels));
      } else if (part === 'query') {
        res.locals.query = result.data;
      } else {
        (req as unknown as Record<string, unknown>)[part] = result.data;
      }
    }
    if (fields.length) {
      const seen = new Set<string>();
      throw AppError.fields(fields.filter((f) => !seen.has(f.field) && seen.add(f.field)));
    }
    next();
  };
}

export type Infer<T extends ZodTypeAny> = z.infer<T>;