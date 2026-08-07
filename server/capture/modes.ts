/**
 * Режимы capture (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 **E8**, §5 R4).
 *
 * Режим — **пресет над существующими ручками**, а не новый капчур-путь: он лишь называет
 * согласованную тройку «политика readiness × канал доставки кадра × полоса очереди», которую до
 * сих пор каждый вызывающий собирал у себя руками. Публичный API-параметр `mode` **отложен**
 * (§8, триаж S-S1): его функциональная суть закрывается политиками профилей (R4), receipt'ом (R5)
 * и guard'ом (R6), а лишний публичный параметр конфликтует с «замком драйвера». Поэтому функция
 * внутренняя: она нужна серверу, чтобы дефолты режимов жили в одном месте и не разъезжались.
 */
import { DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import { barrierAwareReadinessPolicy } from "./resourceBarrier";

/**
 * `interactive` — галерея/библиотека/драфт-превью: кадр уезжает в asset-store, политика
 * доволновая (строгость интерактиву не нужна — его вердикт смотрит человек);
 * `acceptance` — прогон приёмки: байты мимо asset-store (A4), фоновая полоса очереди, политика
 * приходит **из профиля** рана, поэтому здесь только дефолт на случай её отсутствия;
 * `reference` — съёмка визуального эталона: та же доставка, но политика заведомо строгая —
 * эталон, снятый до готовности шрифтов, отравляет все последующие сравнения. С волны W2 это
 * политика v3 (строгая + барьер ресурсов); kill-switch возвращает её в доволновую v2.
 */
export type CaptureMode = "interactive" | "acceptance" | "reference";

export interface ResolvedCaptureMode {
  mode: CaptureMode;
  readiness: ReadinessPolicy;
  deliver: "asset" | "bytes";
  /** Фоновая постановка отказывается на зарезервированных слотах очереди (план family §4.7). */
  background: boolean;
}

const MODES: Readonly<Record<CaptureMode, ResolvedCaptureMode>> = Object.freeze({
  interactive: { mode: "interactive", readiness: DEFAULT_READINESS_POLICY, deliver: "asset", background: false },
  acceptance: { mode: "acceptance", readiness: DEFAULT_READINESS_POLICY, deliver: "bytes", background: true },
  reference: { mode: "reference", readiness: barrierAwareReadinessPolicy("reference"), deliver: "bytes", background: true },
});

export const isCaptureMode = (value: unknown): value is CaptureMode =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(MODES, value);

/** Неизвестное имя — `interactive`: пресет не вправе молча включить кому-то строгость. */
export function resolveCaptureMode(mode: unknown): ResolvedCaptureMode {
  return isCaptureMode(mode) ? MODES[mode] : MODES.interactive;
}
