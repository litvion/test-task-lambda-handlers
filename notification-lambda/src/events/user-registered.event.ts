import { z } from 'zod';
import { EventType } from '../enums/event-type.enum.js';
import { NotificationType } from '../enums/notification-type.enum.js';
import {
  dateSchema,
  emailSchema,
  eventIdSchema,
  nameSchema,
  rolesSchema,
} from '../schemas/fields.schema.js';
import type { EventDefinition } from './event-definition.interface.js';

export const userRegisteredEvent: EventDefinition = {
  type: EventType.UserRegistered,
  notificationTypeId: NotificationType.UserRegistered,
  schema: z.object({
    event_id: eventIdSchema,
    name: nameSchema,
    email: emailSchema,
    roles: rolesSchema,
    joined: dateSchema,
  }),
};
