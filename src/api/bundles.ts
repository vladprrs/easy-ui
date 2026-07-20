import { ApiError, type ApiErrorBody } from "./client";
import type { ImportReport } from "../bundle/schema";

/** Извлекает filename из заголовка content-disposition (RFC 5987 filename* и обычный filename). */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
  try {
    const value = await response.json() as { error?: Partial<ApiErrorBody> };
    if (value.error && typeof value.error.code === "string" && typeof value.error.message === "string") error = value.error as ApiErrorBody;
  } catch { /* Preserve the fallback for a non-JSON error response. */ }
  return new ApiError(response.status, error);
}

/**
 * Скачивает ZIP-бандл по `url` через временный `<a download>`. Ошибочный ответ разбирается
 * в `ApiError` (единый формат тела ошибки сервера). Имя файла берётся из content-disposition,
 * иначе — `fallbackName`.
 */
export async function downloadBundle(url: string, fallbackName: string): Promise<void> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw await errorFromResponse(response);
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Загружает бандл на импорт (multipart, паттерн `uploadAsset`). `mode` управляет сухим прогоном
 * (`dry-run` — без записи) или применением (`apply`). Endpoint появляется в T3.
 */
export async function importBundle(file: File, mode: "dry-run" | "apply"): Promise<ImportReport> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/bundles/import?mode=${mode}`, { method: "POST", credentials: "same-origin", body: form });
  if (!response.ok) throw await errorFromResponse(response);
  return await response.json() as ImportReport;
}
