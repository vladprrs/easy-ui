import type { AtomicLevel, CatalogComponent, ComponentVersionSummary, DesignSystemSummary, LibraryCatalogStatus, VisualReference } from "../api/client";
import { libraryStatusLabels } from "../app/strings/library";
import { tokenize } from "./text";

export type LibrarySelection = { kind: "custom"; componentId: string; designSystem: string };

export interface LibrarySystemGroup {
  system: DesignSystemSummary;
  components: CatalogComponent[];
}

export const atomicLevelLabel = (level?: AtomicLevel) => level
  ? `${level[0].toUpperCase()}${level.slice(1)}s`
  : "Other";

export function groupLibraryEntries(
  systems: DesignSystemSummary[],
  components: CatalogComponent[],
): LibrarySystemGroup[] {
  const groups = systems.map((system) => ({ system, components: [] as CatalogComponent[] }));
  const byId = new Map(groups.map((group) => [group.system.id, group]));
  for (const component of components) byId.get(component.designSystem)?.components.push(component);
  for (const group of groups) {
    group.components.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups.sort((a, b) => a.system.name.localeCompare(b.system.name));
}

export const selectionForComponent = (component: CatalogComponent): LibrarySelection => ({
  kind: "custom", componentId: component.id, designSystem: component.designSystem,
});

export function selectionKey(selection: LibrarySelection): string {
  return `custom:${selection.componentId}:${selection.designSystem}`;
}

// --- Поиск по product job (волна 3 §3.3) ---
//
// Задача поиска — «найти компонент по работе, которую он делает», а не по точному имени.
// Поэтому запрос токенизируется и матчится сразу по четырём осям: объявленные роли
// (`canonicalFor`), имя, описание и классификаторы (scope + atomicLevel). Словаря синонимов
// нет намеренно (RU/EN вперемешку) — матчинг идёт по подстрокам токенов.
//
// Ранжирование фиксировано и документировано, чтобы результат был предсказуем:
//   точное совпадение роли (100) > префикс роли (60) > имя (50/40) > классификатор (20) > описание (10).
// Семантика между токенами запроса — И: компонент показывается, только если каждый токен
// запроса что-то нашёл.
const ROLE_EXACT = 100, ROLE_PREFIX = 60, NAME_EXACT = 50, NAME_PARTIAL = 40, CLASSIFIER = 20, DESCRIPTION = 10;

// Токенизатор общий с серверным матчером дубликатов (`src/library/text.ts`): «найти компонент
// по работе» и «этот компонент уже есть» обязаны нормализовать текст одинаково.
export { tokenize };

export interface ComponentSearchFields {
  name: string;
  description?: string;
  canonicalFor?: string[];
  scope?: string;
  atomicLevel?: string;
}

function tokenScore(component: ComponentSearchFields, token: string): number {
  let score = 0;
  for (const role of component.canonicalFor ?? []) {
    const roleTokens = tokenize(role);
    if (role.toLowerCase() === token || roleTokens.includes(token)) score = Math.max(score, ROLE_EXACT);
    else if (role.toLowerCase().includes(token) || roleTokens.some((part) => part.startsWith(token))) score = Math.max(score, ROLE_PREFIX);
  }
  const nameTokens = tokenize(component.name);
  if (nameTokens.includes(token)) score = Math.max(score, NAME_EXACT);
  else if (component.name.toLowerCase().includes(token)) score = Math.max(score, NAME_PARTIAL);
  for (const classifier of [component.scope, component.atomicLevel]) {
    if (classifier && classifier.toLowerCase().includes(token)) score = Math.max(score, CLASSIFIER);
  }
  if ((component.description ?? "").toLowerCase().includes(token)) score = Math.max(score, DESCRIPTION);
  return score;
}

/** Суммарный ранг компонента для запроса; 0 — компонент не подходит (хотя бы один токен не найден). */
export function searchScore(component: ComponentSearchFields, query: string): number {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(component, token);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/** Пустой запрос возвращает исходный список без пересортировки. */
export function searchComponents<T extends ComponentSearchFields>(components: T[], query: string): T[] {
  if (!tokenize(query).length) return components;
  return components
    .map((component) => ({ component, score: searchScore(component, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name))
    .map((entry) => entry.component);
}

/**
 * «Похожие компоненты»: та же объявленная роль (`canonicalFor`) либо тот же scope с
 * пересечением токенов имени. Co-occurrence-майнинг сознательно не используется —
 * выборки прототипов слишком мало, чтобы он что-то значил.
 */
export function similarComponents<T extends ComponentSearchFields & { id: string }>(component: T, all: T[], limit = 6): T[] {
  const roles = new Set(component.canonicalFor ?? []);
  const nameTokens = new Set(tokenize(component.name));
  return all
    .filter((candidate) => candidate.id !== component.id)
    .map((candidate) => {
      const sharedRoles = (candidate.canonicalFor ?? []).filter((role) => roles.has(role)).length;
      const sharedName = tokenize(candidate.name).filter((token) => nameTokens.has(token)).length;
      const sameScope = component.scope !== undefined && candidate.scope === component.scope;
      return { candidate, score: sharedRoles * ROLE_EXACT + (sameScope ? sharedName * CLASSIFIER : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

// --- Library status filters (plan §H.2) ---
//
// A custom component maps to a boolean status vector derived from its version history and its
// latest passing visual run. The mapping is intentionally fixed and documented so the filter
// chips are unambiguous:
//   published     = the component has at least one active version.
//   rejected      = its latest (highest-numbered) version is rejected.
//   blocked       = its latest version is deprecated | superseded | archived.
//   verified      = published AND the active version has a passing last visual run for its
//                   component reference (fingerprint {scope:"component", componentId, refVersion}).
//   visualPending = published AND not verified.
// Note that rejected/blocked describe the *latest* version even when an older active version keeps
// the component present in the manifest, so a manifest entry can still read as blocked/rejected.
export const LIBRARY_STATUS_KEYS = ["published", "verified", "visual-pending", "blocked", "rejected"] as const;
export type LibraryStatusKey = (typeof LIBRARY_STATUS_KEYS)[number];
export const libraryStatusLabel: Record<LibraryStatusKey, string> = libraryStatusLabels;

/** Статусный вектор карточки — он же `LibraryCatalogStatus` read-model: чипы фильтров общие. */
export type ComponentLibraryStatus = LibraryCatalogStatus;

const BLOCKED_STATUSES = new Set(["deprecated", "superseded", "archived"]);

/**
 * Легаси-вычисление статуса на клиенте. `LibraryPage` его больше не вызывает — статус приходит
 * в записи `/api/catalog/library`. Функция и её тесты сознательно оставлены: это исполняемая
 * спецификация той семантики, на которую ссылается таблица расхождений read-model
 * (`server/library-catalog.test.ts`, план 2026-07-31 §3.1/B3). Удалять — отдельным шагом,
 * вместе с таблицей.
 */
export function componentLibraryStatus(
  componentId: string,
  activeVersion: number,
  versions: ComponentVersionSummary[],
  references: VisualReference[],
): ComponentLibraryStatus {
  const published = versions.some((version) => version.status === "active");
  const latest = versions.reduce<ComponentVersionSummary | null>((max, version) => (!max || version.version > max.version ? version : max), null);
  const rejected = latest?.status === "rejected";
  const blocked = latest !== null && BLOCKED_STATUSES.has(latest.status);
  const verified = published && references.some((reference) =>
    reference.fingerprint.scope === "component"
    && (reference.fingerprint as { componentId?: string }).componentId === componentId
    && (reference.fingerprint as { refVersion?: number }).refVersion === activeVersion
    && reference.lastRun?.status === "pass");
  return { published, rejected, blocked, verified, visualPending: published && !verified };
}

export function matchesLibraryFilter(status: ComponentLibraryStatus, filter: LibraryStatusKey): boolean {
  switch (filter) {
    case "published": return status.published;
    case "verified": return status.verified;
    case "visual-pending": return status.visualPending;
    case "blocked": return status.blocked;
    case "rejected": return status.rejected;
  }
}

// A filter is useful only when it narrows the current component list. This also keeps lifecycle
// controls out of uniform component lists.
export function applicableLibraryStatusKeys(statuses: ComponentLibraryStatus[]): LibraryStatusKey[] {
  if (statuses.length < 2) return [];
  return LIBRARY_STATUS_KEYS.filter((key) => {
    const matches = statuses.filter((status) => matchesLibraryFilter(status, key)).length;
    return matches > 0 && matches < statuses.length;
  });
}
