import type { AppConfig } from '../config.js';
import { ModeName } from '../enums/mode-name.enum.js';
import { ClassifyMode } from './classify.mode.js';
import type { Mode } from './mode.interface.js';
import { SummarizeMode } from './summarize.mode.js';

// The Record type makes TypeScript flag a new ModeName that isn't registered here.
const MODE_FACTORIES: Record<ModeName, (config: AppConfig) => Mode> = {
  [ModeName.Classify]: (config) => new ClassifyMode(config.topics),
  [ModeName.Summarize]: () => new SummarizeMode(),
};

export function createMode(name: ModeName, config: AppConfig): Mode {
  return MODE_FACTORIES[name](config);
}
