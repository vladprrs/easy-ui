/**
 * Наблюдённые ресурсы случая (план §3 D6, §5 W6; триаж R2-14).
 *
 * Импакт-анализ обязан отвечать на вопрос «этот случай вообще видел изменившийся ресурс?». Ответ
 * даёт не статический анализ исходника, а **доказательство** — readiness-evidence кадра (W4):
 * `themeResources.{tokens, icons, images}` собираются в браузере уже после того, как кадр стал
 * готов, и уезжают и в метрики гейта `readiness`, и в CAS (`readiness.json`).
 *
 * Три инварианта этого модуля, и все три — про консервативность:
 *
 * 1. **Отсутствие доказательства ≠ «ресурсов нет».** Случай без evidence (старый шелл,
 *    `indeterminate`, инфраструктурный `error`, вычищенный GC артефакт) описывается `null` —
 *    «неизвестно», — и вызывающий обязан считать его затронутым. Пустое множество и `null` здесь
 *    принципиально разные значения.
 * 2. **Читается только то, что уже записано.** Ни одного капчура: источник — `gates_json` строки
 *    случая, фолбэк — байты `readiness.json` из CAS по адресу из того же `gates_json`.
 * 3. **Нормализация односторонняя.** Наблюдаются CSS-кастом-проперти (`--eui-color-bg`), а тема
 *    хранит ключи (`color.bg`); сравнение идёт в пространстве **наблюдений**, поэтому ключи темы
 *    приводятся к именам переменных, а не наоборот (обратное отображение неоднозначно: точка и
 *    дефис схлопываются в один дефис).
 */
import { readArtifact } from "./evidence";
import type { AcceptanceCaseRow, AcceptanceRepo } from "./repo";

export interface CaseResources {
  /** Имена применённых CSS-кастом-проперти темы (`--eui-…`). */
  tokens: Set<string>;
  /** asset-id иконок темы, попавших в кадр. */
  icons: Set<string>;
  /** asset-id прочих изображений кадра. */
  images: Set<string>;
  /** `icons ∪ images` — множество, с которым сравнивается дифф ассетов (D6, класс «asset-only»). */
  assets: Set<string>;
}

/** `null` — доказательства по случаю нет; такой случай консервативно считается затронутым. */
export type ObservedResources = Map<string, CaseResources | null>;

/**
 * Ключ токена темы → имя CSS-кастом-проперти. Тот же алгоритм, что у клиентского `tokenCssVar`
 * (`src/designSystems/theme.tsx`): дублируется намеренно — серверу нельзя тянуть React-модуль
 * ради одной строковой замены, а расхождение поймал бы тест нормализации.
 */
export function themeTokenCssVar(key: string): string {
  return `--eui-${key.replace(/\./g, "-")}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** `{tokens, icons, images}` любой формы (метрики гейта или evidence из CAS) → нормализованный набор. */
export function normalizeThemeResources(raw: unknown): CaseResources | null {
  if (!isObject(raw)) return null;
  // Все три коллекции обязательны по контракту W4. Их отсутствие означает кадр от шелла, который
  // протокол ресурсов не знает, — это «неизвестно», а не «пусто».
  if (!Array.isArray(raw.tokens) || !Array.isArray(raw.icons) || !Array.isArray(raw.images)) return null;
  const icons = new Set(stringsOf(raw.icons));
  const images = new Set(stringsOf(raw.images));
  return {
    tokens: new Set(stringsOf(raw.tokens)),
    icons,
    images,
    assets: new Set([...icons, ...images]),
  };
}

interface StoredGate {
  gate?: unknown;
  metrics?: unknown;
  artifacts?: unknown;
}

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/** Результат гейта `readiness` из сохранённых гейтов случая (raw-форма, без схемы). */
function readinessGateOf(gatesJson: string | null): StoredGate | null {
  const parsed = parseJson(gatesJson);
  if (!Array.isArray(parsed)) return null;
  const gate = parsed.filter(isObject).find((item) => item.gate === "readiness");
  return gate ?? null;
}

/** sha256 артефакта `readiness.json` этого гейта (адрес CAS), либо `null`. */
function readinessArtifactSha(gate: StoredGate): string | null {
  if (!Array.isArray(gate.artifacts)) return null;
  const entry = gate.artifacts.filter(isObject).find((item) => item.name === "readiness.json");
  return typeof entry?.sha256 === "string" ? entry.sha256 : null;
}

/**
 * Ресурсы одного случая: сначала метрики гейта (дёшево, durable в строке случая), затем — байты
 * `readiness.json` из CAS по адресу из тех же гейтов. Вычищенный GC артефакт даёт `null`, а не
 * пустой набор: доказательства больше нет.
 */
export async function observedResourcesOfCase(dataDir: string, row: AcceptanceCaseRow): Promise<CaseResources | null> {
  const gate = readinessGateOf(row.gates_json);
  if (!gate) return null;
  const fromMetrics = isObject(gate.metrics) ? normalizeThemeResources(gate.metrics.themeResources) : null;
  if (fromMetrics) return fromMetrics;
  const sha = readinessArtifactSha(gate);
  if (sha === null) return null;
  const bytes = await readArtifact(dataDir, sha);
  if (!bytes) return null;
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObject(payload) || !isObject(payload.evidence)) return null;
  return normalizeThemeResources(payload.evidence.themeResources);
}

/**
 * Наблюдённые ресурсы всех случаев рана, по `caseId`. Алиасы попадают в карту наравне с целями:
 * их строка несёт скопированные гейты цели, а значит и то же доказательство.
 */
export async function observedResourcesOfRun(dataDir: string, repo: AcceptanceRepo, runId: string): Promise<ObservedResources> {
  const map: ObservedResources = new Map();
  for (const row of repo.cases(runId)) {
    map.set(row.case_id, await observedResourcesOfCase(dataDir, row));
  }
  return map;
}

/** Непустое пересечение множеств — предикат «этот случай видел изменившийся ресурс». */
export function intersects(observed: Set<string>, changed: readonly string[]): boolean {
  for (const item of changed) if (observed.has(item)) return true;
  return false;
}
