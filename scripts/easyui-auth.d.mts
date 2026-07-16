export type EasyUiCredentials = { legacyBasicAuth?: string; username?: string; password?: string };
export function easyUiCredentials(env?: NodeJS.ProcessEnv): EasyUiCredentials;
export function createEasyUiClient(options: {
  apiBase: string;
  credentials?: EasyUiCredentials;
  fetchImpl?: typeof fetch;
}): {
  apiBase: string;
  origin: string;
  legacyAuthorization?: string;
  login(): Promise<string>;
  request(path: string, init?: RequestInit): Promise<Response>;
  readonly cookieHeader?: string;
};
