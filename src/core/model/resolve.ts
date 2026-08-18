import { CoreError } from '../errors.ts';
import type { ModelClient } from './model-client.ts';
import { OllamaModelClient } from './ollama-model.ts';
import { ScriptedModelClient } from './scripted-model.ts';

/**
 * Pick a model client from configuration.
 *
 * The default is the scripted client, which is a deliberate choice rather than a
 * placeholder: starting the daemon should never reach the network, contact a service, or
 * spend anything by accident. You opt in explicitly.
 *
 *   CREATIVE_ARCHIVE_MODEL=ollama:llama3.1
 *   CREATIVE_ARCHIVE_MODEL=scripted        (default)
 */
export function resolveModelClient(env: NodeJS.ProcessEnv = process.env): ModelClient {
  const spec = env.CREATIVE_ARCHIVE_MODEL?.trim();
  if (spec === undefined || spec.length === 0 || spec === 'scripted') {
    return new ScriptedModelClient();
  }

  if (spec.startsWith('ollama:')) {
    const model = spec.slice('ollama:'.length);
    if (model.length === 0) {
      throw new CoreError('model_config', 'CREATIVE_ARCHIVE_MODEL=ollama: needs a model name');
    }
    const options: { model: string; host?: string } = { model };
    const host = env.OLLAMA_HOST?.trim();
    if (host !== undefined && host.length > 0) options.host = host;
    return new OllamaModelClient(options);
  }

  throw new CoreError(
    'model_config',
    `unknown CREATIVE_ARCHIVE_MODEL '${spec}' (expected 'scripted' or 'ollama:<model>')`,
  );
}
