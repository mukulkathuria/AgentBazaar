import type { z } from 'zod';
import { fmt } from './format';
import type { Dict } from './i18n/en';

/** Localized fallback messages for form validation. Messages defined on a contracts schema take precedence. */
export function formErrorMap(t: Dict['form']): z.core.$ZodErrorMap {
  return (iss) => {
    if (iss.input === undefined || iss.input === '') return t.required;
    switch (iss.code) {
      case 'too_small':
        if (iss.origin === 'array') return t.choose;
        return fmt(iss.origin === 'string' ? t.tooShort : t.min, { n: Number(iss.minimum) });
      case 'too_big':
        return fmt(iss.origin === 'string' ? t.tooLong : t.max, { n: Number(iss.maximum) });
      case 'invalid_format':
        return iss.format === 'email' ? t.email : t.invalid;
      case 'invalid_value':
        return t.choose;
      default:
        return t.invalid;
    }
  };
}
