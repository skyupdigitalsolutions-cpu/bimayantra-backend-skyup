import { z } from 'zod';
import { cfgNum } from '../config/cfg.js';

/** GR-35: lists are paged at CFG-23 rows unless the caller asks for fewer or more (up to 100). */
export const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};
export const pageSize = (limit?: number) => limit ?? cfgNum('CFG-23');
export const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

/** Escape user input before using it inside a RegExp, so search text can't become a pattern. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
