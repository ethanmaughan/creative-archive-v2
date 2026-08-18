import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configRoot } from '../config/paths.ts';
import { ConfigInvalid, CoreError } from '../errors.ts';

/** §4.2. Personality controls tone and register only. */
export const PERSONALITY_IDS = ['plain', 'warm', 'dry', 'socratic', 'expansive'] as const;

export type PersonalityId = (typeof PERSONALITY_IDS)[number];

export interface Personality {
  readonly id: PersonalityId;
  readonly register: string;
  readonly verbosity: 'terse' | 'moderate' | 'high';
  readonly promptFragmentPath: string;
}

const PRESETS: Record<PersonalityId, { register: string; verbosity: Personality['verbosity'] }> = {
  plain: { register: 'neutral', verbosity: 'terse' },
  warm: { register: 'encouraging', verbosity: 'moderate' },
  dry: { register: 'wry, understated', verbosity: 'terse' },
  socratic: { register: 'question-forward', verbosity: 'moderate' },
  expansive: { register: 'discursive, associative', verbosity: 'high' },
};

export const DEFAULT_PERSONALITY: PersonalityId = 'plain';

export function isPersonalityId(value: string): value is PersonalityId {
  return (PERSONALITY_IDS as readonly string[]).includes(value);
}

export function loadPersonality(id: string, root: string = configRoot()): Personality {
  if (!isPersonalityId(id)) {
    throw new CoreError(
      'unknown_personality',
      `unknown personality '${id}' (available: ${PERSONALITY_IDS.join(', ')})`,
    );
  }

  const promptFragmentPath = join(root, 'prompts', 'personalities', `${id}.md`);
  if (!existsSync(promptFragmentPath)) {
    throw new ConfigInvalid(promptFragmentPath, `missing prompt fragment for personality '${id}'`);
  }

  const preset = PRESETS[id];
  return { id, register: preset.register, verbosity: preset.verbosity, promptFragmentPath };
}

export function listPersonalities(root: string = configRoot()): Personality[] {
  return PERSONALITY_IDS.map((id) => loadPersonality(id, root));
}
