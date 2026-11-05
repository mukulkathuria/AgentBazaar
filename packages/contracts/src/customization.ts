import { z } from 'zod';
import { Paise, Uuid } from './common.js';

export const TextScript = z.enum(['latin', 'latin_devanagari']);

export const TextFieldSpec = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  label: z.string().max(60),
  minLength: z.number().int().min(0).max(200).default(0),
  maxLength: z.number().int().min(1).max(200),
  script: TextScript.default('latin'),
  required: z.boolean().default(false),
  allowEmoji: z.boolean().default(false),
});
export type TextFieldSpec = z.infer<typeof TextFieldSpec>;

export const DesignView = z.object({ id: Uuid, name: z.string(), previewUrl: z.string() });

export const CustomizationOptions = z.object({
  productId: Uuid,
  schemaId: Uuid,
  fields: z.array(TextFieldSpec),
  designs: z.array(DesignView),
  designRequired: z.boolean(),
  surchargePaise: Paise,
  nonReturnable: z.literal(true),
  notice: z.string(),
});
export type CustomizationOptions = z.infer<typeof CustomizationOptions>;

/** Raw buyer input. Lengths are re-checked per field by the validator. */
export const CustomizationValues = z.strictObject({
  text: z.record(z.string().max(40), z.string().max(500)).default({}),
  designId: Uuid.optional(),
});
export type CustomizationValues = z.infer<typeof CustomizationValues>;

export const CustomizationIssueCode = z.enum([
  'required',
  'too_short',
  'too_long',
  'charset',
  'control_chars',
  'bidi_override',
  'zero_width',
  'mixed_script',
  'emoji',
  'markup',
  'prompt_injection',
  'blocked_word',
  'trademark',
  'unknown_field',
  'design_not_allowed',
  'design_required',
]);
export type CustomizationIssueCode = z.infer<typeof CustomizationIssueCode>;

export const CustomizationIssue = z.object({
  field: z.string(),
  code: CustomizationIssueCode,
  message: z.string(),
});
export type CustomizationIssue = z.infer<typeof CustomizationIssue>;

export const CustomizationVerdict = z.enum(['approved', 'rejected', 'needs_review']);

export const CustomizationValidation = z.object({
  verdict: CustomizationVerdict,
  issues: z.array(CustomizationIssue),
  normalized: CustomizationValues.nullable(),
  surchargePaise: Paise,
  previewUrl: z.string().nullable(),
});
export type CustomizationValidation = z.infer<typeof CustomizationValidation>;
