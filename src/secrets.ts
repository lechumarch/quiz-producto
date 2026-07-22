// Ownia injects secrets as APP_SECRETS env var (JSON), not as individual vars.
const parsed: Record<string, string> = JSON.parse(process.env.APP_SECRETS ?? '{}');

export function getSecret(key: string): string | undefined {
  return parsed[key] ?? process.env[key];
}
