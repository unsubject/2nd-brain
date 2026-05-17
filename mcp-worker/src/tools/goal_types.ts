import { z } from 'zod';

// SMART breakdown — required when authoring a brand-new goal or a
// synthesized successor. For kind='amend' the partial schema applies
// (any subset; omitted fields preserved by COALESCE in commit_amendment).
export const smartFieldsSchema = z.object({
  statement: z.string().min(3).max(500),
  specific: z.string().min(3).max(2000),
  measurable: z.string().min(3).max(2000),
  achievable: z.string().min(3).max(2000),
  relevant: z.string().min(3).max(2000),
  time_bound: z.string().min(3).max(2000),
  crisis_origin: z.string().min(3).max(4000),
});

export const smartFieldsPartialSchema = smartFieldsSchema.partial();

export const undertakingKindSchema = z.enum(['outcome', 'habit_forming']);
export const undertakingStatusSchema = z.enum([
  'active',
  'completed',
  'archived',
  'sleeping',
]);
export const goalStatusSchema = z.enum(['active', 'merged', 'retired']);
