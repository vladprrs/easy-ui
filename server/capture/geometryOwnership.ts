/**
 * Общий kill-switch группы **владения геометрией** волны снятия блокеров (план
 * `docs/plans/2026-08-08-blocker-removal-eui-br.md` §5 и §9): **EUI-BR-05** (decoration-aware
 * geometry, capability `geometryDecorationOwnershipV1`) и **EUI-BR-09** (scroll/overflow ownership
 * для FlowRoot, capability `flowOverflowOwnershipV1`).
 *
 * Один тумблер на две фичи — решение §13 плана (C6): обе меняют **интерпретацию одних и тех же
 * фактов замера** (что входит в layout-union, что считается корнем, что считается переливом), и два
 * независимых тумблера дали бы состояние «декорация прозрачна для корня, но её же перелив всё ещё
 * поднимает `content-clipped-by-frame`», которого ни один тест не описывает.
 *
 * `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` — **legacy byte-for-byte**: авто-правило decoration не
 * применяется (сбор ведёт себя доволново, `rootBounds` у fragment-корня снова `null`), манифест с
 * `cases[].geometryOwnership` отвергается типизированным `422 geometry_ownership_disabled`,
 * документ с `overflowOwnership` отвергается `422 flow_overflow_ownership_disabled` на записи, а
 * `analyzeGeometry` поднимает прежний `content-clipped-by-frame` на любом переливе.
 *
 * **Почему тумблер не входит в отпечатки.** Он — аварийный откат, а не свойство случая: хэшировать
 * окружение процесса значило бы делать отпечатки невоспроизводимыми (тот же аргумент, что у
 * `EASYUI_RUNTIME_DEFAULTS_DISABLED`, `server/acceptance/ids.ts`). Инвалидация волны выражена двумя
 * честными входами:
 *
 * - `geometryContractVersion: 3` в `frameFingerprint` — **условно по манифестному факту** (кейс
 *   объявил `geometryOwnership`), то есть известному до съёмки: отпечатки считаются при постановке
 *   рана, и условность «по результату измерения» дала бы кейсу два разных fingerprint (блокер B1
 *   раунда 2);
 * - `geometryOwnershipPolicyVersion` в **вердиктном** снимке — это и есть инвалидация авто-правила:
 *   оно не меняет ни одного пикселя, а меняет прочтение фактов, поэтому стоит recompute'а, а не
 *   пересъёмки. Симметрично `COMPARISON_POLICY_VERSION` слоя сравнения (BR-04,
 *   `server/capture/captureV4.ts`), но на своём слое.
 *
 * Значение читается **на каждом вызове**, а не один раз на процесс: это делает тумблер проверяемым
 * парными тестами «фича / legacy» без перезапуска процесса.
 */

/** Активна ли группа владения геометрией (BR-05 + BR-09). */
export const geometryOwnershipEnabled = (): boolean => process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED !== "1";

/**
 * Версия политики **вердикта** волны (BR-05). Входит в `VerdictPolicySnapshot` условным спредом
 * ровно тогда, когда группа активна. Смысл кода изменился (краска, объяснённая декорациями, больше
 * не блокирует; поверхность `paint` наблюдается с поправкой на владение), а ни одно поле манифеста
 * при этом не поменялось — значит сохранённые под старой семантикой вердикты обязаны перестать
 * переиспользоваться. `CASE_FINGERPRINT_ALGO_VERSION` при этом **не** двигается: bump ALGO
 * инвалидировал бы reuse всего корпуса вместе с кадрами, а вердиктный вход даёт дешёвый recompute.
 */
export const GEOMETRY_OWNERSHIP_POLICY_VERSION = 1;

/** Потолок деклараций `cases[].geometryOwnership` на случай (дублирует схему: `src/` не знает `server/`). */
export const GEOMETRY_OWNERSHIP_MAX_NODES = 16;
