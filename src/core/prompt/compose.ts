import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { configRoot } from '../config/paths.ts';
import type { Identity } from '../identity/identity.ts';
import { loadPersonality } from '../identity/personality.ts';
import type { Mode } from '../modes/mode.ts';

/**
 * The five fragments of §4.3, kept separate all the way to the join. There is no
 * mode×personality file anywhere in this repo and there is no code path that could produce
 * one — `composeSystemPrompt` is a pure concatenation in a fixed order, which is what makes
 * "never hand-write a combination" (invariant 4) a structural property rather than a habit.
 */
export interface PromptParts {
  readonly base: string;
  readonly mode: string;
  readonly personality: string;
  readonly identity: string;
  readonly archiveContext: string;
}

export const PART_SEPARATOR = '\n\n---\n\n';

export function composeSystemPrompt(parts: PromptParts): string {
  return [parts.base, parts.mode, parts.personality, parts.identity, parts.archiveContext]
    .map((part) => part.trim())
    .join(PART_SEPARATOR);
}

export function identityBlock(identity: Identity): string {
  return [
    '## Who you are',
    '',
    `Your name is ${identity.name}. Use it when you refer to yourself.`,
    '',
    'The name is a label, not a wake word and not a character: it does not come with a',
    'backstory, a species, or opinions of its own. It is recorded in this session’s',
    'metadata as a fact about who was in the conversation.',
  ].join('\n');
}

export interface ArchiveContextInput {
  readonly archiveRoot: string;
  readonly mode: Mode;
  readonly retrievalAvailable: boolean;
}

export function archiveContextBlock(input: ArchiveContextInput): string {
  const lines = [
    '## This archive',
    '',
    `Archive: \`${basename(input.archiveRoot)}\``,
    `Mode: ${input.mode.label} (\`${input.mode.id}\`)`,
    `Readable: ${input.mode.scope.read.map((glob) => `\`${glob}\``).join(', ')}`,
    `Writable: ${input.mode.scope.write.map((glob) => `\`${glob}\``).join(', ')}`,
    `Tools: ${input.mode.tools.map((tool) => `\`${tool}\``).join(', ')}`,
  ];

  if (!input.retrievalAvailable) {
    lines.push(
      '',
      '**You have no retrieval tool in this build.** You cannot search the archive, so you',
      'cannot know what it contains. That means you may not report a gap either: "not in',
      'your notes" is a claim about the archive, and you have no way to check it. Say that',
      'you cannot search rather than reporting an absence you did not verify — a confident',
      '"undocumented" that was really a missing tool is the exact failure §3.1 exists to',
      'prevent.',
    );
  }

  return lines.join('\n');
}

export interface SystemPromptInput {
  readonly archiveRoot: string;
  readonly mode: Mode;
  readonly identity: Identity;
  readonly retrievalAvailable?: boolean;
  readonly configDir?: string;
}

export async function buildSystemPrompt(
  input: SystemPromptInput,
): Promise<{ prompt: string; parts: PromptParts }> {
  const root = input.configDir ?? configRoot();
  const personality = loadPersonality(input.identity.personality, root);

  const [base, mode, personalityFragment] = await Promise.all([
    readFile(join(root, 'prompts', 'base.md'), 'utf8'),
    readFile(input.mode.promptFragmentPath, 'utf8'),
    readFile(personality.promptFragmentPath, 'utf8'),
  ]);

  const parts: PromptParts = {
    base,
    mode,
    personality: personalityFragment,
    identity: identityBlock(input.identity),
    archiveContext: archiveContextBlock({
      archiveRoot: input.archiveRoot,
      mode: input.mode,
      retrievalAvailable: input.retrievalAvailable ?? false,
    }),
  };

  return { prompt: composeSystemPrompt(parts), parts };
}
