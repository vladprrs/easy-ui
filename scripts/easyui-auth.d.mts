export type EasyUiCredentials = { legacyBasicAuth?: string; username?: string; password?: string };
export function easyUiCredentials(env?: NodeJS.ProcessEnv): EasyUiCredentials;
/**
 * Сессионная cookie кэшируется на диске между процессами: `$EASYUI_SESSION_FILE` либо
 * `$XDG_STATE_HOME/easyui` (fallback `~/.cache/easyui`), TTL 24 ч. `EASYUI_SESSION_CACHE=0`
 * выключает кэш и удаляет существующий файл. `login()` всегда форсирует логин;
 * `request()` использует кэш и однократно перелогинивается на application-401.
 */
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
