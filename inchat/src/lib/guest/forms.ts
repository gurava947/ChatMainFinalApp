import { z } from 'zod';

import { zodFieldErrors, type FieldErrors } from '@/lib/forms';

export const guestProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Choose a display name.').max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._]{3,32}$/, 'Use 3–32 characters: a-z, 0-9, dot, underscore.'),
  bio: z.string().trim().max(200).optional().default('')
});

export type GuestFormState = {
  errors?: FieldErrors;
  message?: string;
};

export const guestFormErrors = zodFieldErrors;
