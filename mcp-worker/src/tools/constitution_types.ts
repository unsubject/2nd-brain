import { z } from 'zod';

// Constitution-domain fields. crisis_origin is the precipitating event
// (depression diagnosis, lipoma scare, ADHD, etc) — required by schema:
// if the user cannot name the crisis, the domain isn't constitutional yet.
export const constitutionFieldsSchema = z.object({
  label: z.string().min(1).max(40),
  statement: z.string().min(3).max(500),
  crisis_origin: z.string().min(3).max(4000),
});

export const constitutionFieldsPartialSchema = constitutionFieldsSchema.partial();

export const constitutionStatusSchema = z.enum(['active', 'merged', 'retired']);
