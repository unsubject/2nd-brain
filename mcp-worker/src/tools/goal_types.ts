import { z } from 'zod';

// SMART breakdown for a goal under a constitution_domain. outcome_metric
// is the quarterly-review yardstick — measured by outcomes not output
// (e.g. "lose 10 lbs", not "go to gym 3x/week"; output-level test
// criteria live on undertakings). target_date is optional — open-ended
// goals are allowed, but should explain themselves in time_bound.
export const goalFieldsSchema = z.object({
  statement: z.string().min(3).max(500),
  specific: z.string().min(3).max(2000),
  measurable: z.string().min(3).max(2000),
  achievable: z.string().min(3).max(2000),
  relevant: z.string().min(3).max(2000),
  time_bound: z.string().min(3).max(2000),
  outcome_metric: z.string().min(3).max(2000),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const goalFieldsPartialSchema = goalFieldsSchema.partial();

export const goalStatusSchema = z.enum(['active', 'achieved', 'abandoned', 'merged']);

export const undertakingKindSchema = z.enum(['outcome', 'habit_forming']);
export const undertakingStatusSchema = z.enum([
  'active',
  'completed',
  'archived',
  'sleeping',
]);
