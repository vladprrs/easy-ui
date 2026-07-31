/**
 * Политика матчинга дубликатов (план 2026-07-31 §3.3, отступление D7).
 *
 * Веса и пороги — **не** контрактные константы кода: они инъектируются в матчер параметром
 * `policy`, а итоговые значения выбирает калибровка T0 по замеренному распределению score
 * на прод-каталоге. Здесь лежит стартовая точка спеки §3 и версия политики.
 *
 * `policyVersion` обязателен в каждой аудит-записи: score корпус-относителен (IDF считается по
 * описаниям каталога), поэтому без версии политики решение невоспроизводимо задним числом.
 * Значение `0` — provisional по §4 плана: пока калибровка не принята, enforce не включается.
 */

export interface MatchWeights {
  /** Сходство сигнатуры props. */
  props: number;
  /** Сходство событий и именованных слотов. */
  io: number;
  /** Jaccard k-шинглов нормализованного исходника. */
  source: number;
  /** Пересечение токенов имени (с разбиением camelCase/kebab-case). */
  name: number;
  /** IDF-взвешенное пересечение описания/intent (отступление D1: без FTS). */
  description: number;
  /** Совпадение `atomicLevel` и `scope`. */
  levelScope: number;
}

export interface MatchPolicy {
  /** Версия политики; пишется в аудит рядом со score. `0` — provisional (до отчёта T0). */
  policyVersion: number;
  weights: MatchWeights;
  /** score ≥ порога → blocking независимо от прочих сигналов. */
  blockingThreshold: number;
  /** review-кандидаты: `reviewThreshold ≤ score < blockingThreshold`. */
  reviewThreshold: number;
}

/**
 * Стартовые значения спеки §3. Замер ревьюера (план §1.1, B3): под ними на 37 активных
 * yandex-pay блокирующих пар **ноль**, а переименованная копипаста набирает 0.685 — поэтому
 * значения заведомо временные и переопределяются T0 вместе с повышением `policyVersion`.
 */
export const SPEC_DEFAULT_POLICY: MatchPolicy = {
  policyVersion: 0,
  weights: { props: 0.25, io: 0.15, source: 0.2, name: 0.15, description: 0.15, levelScope: 0.1 },
  blockingThreshold: 0.82,
  reviewThreshold: 0.65,
};

/** Сумма весов стартовой политики равна 1.0; перенормировка матчера от этого не зависит. */
export const totalWeight = (weights: MatchWeights): number =>
  weights.props + weights.io + weights.source + weights.name + weights.description + weights.levelScope;
