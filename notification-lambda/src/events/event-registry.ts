import type { EventDefinition } from './event-definition.interface.js';
import { passwordResetEvent } from './password-reset.event.js';
import { userDeletedEvent } from './user-deleted.event.js';
import { userRegisteredEvent } from './user-registered.event.js';

// To support a new event type, add its definition here.
export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  userRegisteredEvent,
  passwordResetEvent,
  userDeletedEvent,
];

export class EventRegistry {
  private readonly byType = new Map<string, EventDefinition>();

  constructor(definitions: readonly EventDefinition[] = EVENT_DEFINITIONS) {
    for (const definition of definitions) {
      if (this.byType.has(definition.type)) {
        throw new Error(`Duplicate event type "${definition.type}"`);
      }

      this.byType.set(definition.type, definition);
    }
  }

  // Case- and whitespace-insensitive, so " User_Registered " still matches.
  get(type: string): EventDefinition | undefined {
    return this.byType.get(type.trim().toLowerCase());
  }

  get types(): string[] {
    return [...this.byType.keys()];
  }
}
