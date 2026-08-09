import { describe, expect, test } from "bun:test";

/**
 * Матрица kill-switch'ей волны снятия блокеров EUI-BR (план
 * `docs/plans/2026-08-08-blocker-removal-eui-br.md` §13, done-критерий V5).
 *
 * Предмет файла — **не** «работает ли фича», а два операционных обещания деплоя, которые иначе
 * проверяются только на проде:
 *
 * 1. **`deploy all-off` действительно доволновой.** Образ выкатывается со всеми девятью
 *    тумблерами волны в `1`, и в этой конфигурации discovery обязано выглядеть **ровно как до
 *    волны**: ни одного волнового флага в `true`, и все три версии — доволновые
 *    (`acceptance.readinessPolicyVersion: 3`, `features.prototypeSchemaResolverVersion: 1`,
 *    `acceptance.geometryContractVersion: 2`). Если хоть один флаг «протекает», порядок включения
 *    §13 бессмысленен: первая же выкладка изменила бы поведение до того, как её кто-то разрешил.
 * 2. **Каждый тумблер владеет ровно своим.** Снятие одного switch'а на фоне остальных восьми
 *    обязано зажечь **ровно** объявленный им набор флагов/версий и ни одного чужого — иначе
 *    поштучное включение (единственная замена отсутствующему staging) не даёт локализации отката.
 *
 * **Почему подпроцессы, а не `process.env` в общем процессе.** `EASYUI_RESOURCE_BARRIER_V4_DISABLED`
 * читается **один раз на процесс** (политика барьера входит в `policyProfileHash`,
 * `readinessPolicyHash` и `rendererFingerprint`, и смена значения на середине жизни процесса дала
 * бы одному рану два разных отпечатка — см. `server/capture/resourceBarrier.ts`). Значит матрица,
 * которая мутирует env текущего процесса, физически не способна проверить строку барьера — а
 * именно она в §13 стоит в самом дорогом окне (пересъёмка). Поэтому каждая конфигурация
 * поднимается **свежим процессом** с нужным env, ровно как это делает redeploy.
 *
 * Тумблеры, не принадлежащие волне (`EASYUI_RESOURCE_BARRIER_DISABLED`, `EASYUI_SURFACES`,
 * `EASYUI_COMPOSITION_V3`, …), матрица не трогает: они старше волны, и их поведение покрыто
 * тестами своих волн.
 */

/** Девять тумблеров волны (§13 плана) и то, что каждый из них гасит в discovery. */
const WAVE_SWITCHES = {
  // BR-01a/BR-01b — резолвер схемы published component. Матрицей не гейтится.
  EASYUI_SCHEMA_RESOLVER_V2_DISABLED: {
    features: { prototypeSchemaResolverV2: true },
    versions: { "features.prototypeSchemaResolverVersion": 2 },
  },
  // BR-02 + BR-04 — capture-группа: кадр краски и канва сравнения. Одно окно re-diff'а.
  EASYUI_CAPTURE_V4_DISABLED: {
    features: { paintCapturePaddingV1: true, exactContentHugCanvasV1: true },
    versions: { "features.comparisonPolicyVersion": 2 },
  },
  // BR-03 — барьер ресурсов v4. Restart required: политика входит в три отпечатка.
  EASYUI_RESOURCE_BARRIER_V4_DISABLED: {
    features: { resourceBarrierV4: true },
    versions: { "features.resourceBarrierPolicyVersion": 4, "acceptance.readinessPolicyVersion": 4 },
  },
  // BR-05 + BR-09 — группа владения геометрией.
  EASYUI_GEOMETRY_OWNERSHIP_DISABLED: {
    features: { geometryDecorationOwnershipV1: true, flowOverflowOwnershipV1: true },
    versions: { "features.geometryOwnershipPolicyVersion": 1 },
  },
  // BR-06 — продолжение остановленного рана (matrix-зависимая).
  EASYUI_ACCEPTANCE_RESUME_DISABLED: { features: { acceptanceResumeV1: true }, versions: {} },
  // BR-07 (S1 + атрибуция) — report-only слой evidence (matrix-зависимая).
  EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED: { features: { visualAttributionV2: true }, versions: {} },
  // BR-07 (профили) — **своя ось**: меняет promote-eligibility (matrix-зависимая).
  EASYUI_RENDERER_POLICY_PROFILES_DISABLED: { features: { rendererPolicyProfilesV2: true }, versions: {} },
  // BR-08 — два вердикта одного сравнения (matrix-зависимая).
  EASYUI_COMPARISON_OWNERSHIP_DISABLED: { features: { comparisonOwnershipV1: true }, versions: {} },
  // BR-10a/BR-10b — отпечаток блокера и retry-disposition (matrix-зависимая).
  EASYUI_BLOCKER_FINGERPRINT_DISABLED: { features: { blockerFingerprintV1: true }, versions: {} },
} as const;

type SwitchName = keyof typeof WAVE_SWITCHES;
const SWITCH_NAMES = Object.keys(WAVE_SWITCHES) as SwitchName[];

/**
 * Доволновое состояние discovery: то, что видел клиент до волны (и увидит при `deploy all-off`).
 * Числа — не «какие получились», а зафиксированные значения предыдущих волн: `3` — барьер W2
 * волны 2026-08-07, `2` — контракт измерения геометрии W2 той же волны (волна EUI-BR его
 * сознательно **не** двигает: новые факты замера аддитивны и кадры не инвалидируют), `1` —
 * доволновой резолвер схемы.
 */
const PRE_WAVE_VERSIONS = {
  "acceptance.readinessPolicyVersion": 3,
  "features.prototypeSchemaResolverVersion": 1,
  "acceptance.geometryContractVersion": 2,
  "features.resourceBarrierPolicyVersion": 3,
  "features.comparisonPolicyVersion": 1,
  "features.geometryOwnershipPolicyVersion": null,
} as const;

/** Все волновые флаги (объединение по тумблерам) — множество, которое `all-off` обязан погасить. */
const WAVE_FLAGS = [...new Set(SWITCH_NAMES.flatMap((name) => Object.keys(WAVE_SWITCHES[name].features)))].sort();

interface Discovery {
  features: Record<string, unknown>;
  acceptance: Record<string, unknown>;
  promotionPolicyProfiles: string[];
}

/**
 * Discovery свежего процесса с заданным env. Матричная приёмка включена всегда (`acceptanceMatrix:
 * true`): без неё половина волновых флагов гаснет по другой причине, и матрица тумблеров мерила бы
 * не тумблеры. База — пустая `:memory:` после `migrate`: capabilities читает из неё только реестр
 * дизайн-систем, на волновые поля он не влияет.
 */
async function discovery(env: Record<string, string>): Promise<Discovery> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      import { migrate } from "./server/migrations.ts";
      import { capabilities } from "./server/routes/meta.ts";
      const db = new Database(":memory:");
      migrate(db);
      const value = capabilities(db, "shadow", { acceptanceMatrix: true });
      console.log(JSON.stringify({
        features: value.features,
        acceptance: value.acceptance,
        promotionPolicyProfiles: value.acceptance.promotionPolicyProfiles,
      }));
    `],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`capabilities probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout) as Discovery;
}

/** Env «все девять выключены», из которого поштучно снимаются тумблеры. */
const allOffEnv = (except?: SwitchName): Record<string, string> =>
  Object.fromEntries(SWITCH_NAMES.filter((name) => name !== except).map((name) => [name, "1"]));

const versionAt = (value: Discovery, path: string): unknown =>
  path.startsWith("features.") ? value.features[path.slice("features.".length)] : value.acceptance[path.slice("acceptance.".length)];

describe("матрица kill-switch'ей волны EUI-BR (план §13, V5)", () => {
  test("deploy all-off: ни одного волнового флага и доволновые версии", async () => {
    const value = await discovery(allOffEnv());

    // Ни один волновой флаг не «протекает» — это и есть обещание «выкладка образа ничего не меняет».
    expect(WAVE_FLAGS.filter((flag) => value.features[flag] !== false)).toEqual([]);
    // Три версии, названные в §13 смоук-ключами включения, — доволновые.
    for (const [path, expected] of Object.entries(PRE_WAVE_VERSIONS)) {
      expect({ path, value: versionAt(value, path) }).toEqual({ path, value: expected });
    }
    // BR-07: под своим тумблером профиль с `allowExceptions` перестаёт быть промоутабельным —
    // иначе discovery обещал бы promote, который сервер отвергнет (`acceptance_policy_mismatch`).
    expect(value.promotionPolicyProfiles).not.toContain("default-v1-exceptions");
  }, 60_000);

  test("каждый тумблер снимается по одному и зажигает ровно своё", async () => {
    const baseline = await discovery(allOffEnv());

    for (const name of SWITCH_NAMES) {
      const spec = WAVE_SWITCHES[name];
      const value = await discovery(allOffEnv(name));

      // 1. Зажглись ровно объявленные флаги этого тумблера.
      const lit = WAVE_FLAGS.filter((flag) => value.features[flag] === true);
      expect({ name, lit }).toEqual({ name, lit: Object.keys(spec.features).sort() });

      // 2. Версии: свои — волновые, чужие — по-прежнему доволновые.
      for (const [path, expected] of Object.entries(PRE_WAVE_VERSIONS)) {
        const own = (spec.versions as Record<string, number>)[path];
        expect({ name, path, value: versionAt(value, path) })
          .toEqual({ name, path, value: own ?? expected });
      }

      // 3. Ничего постороннего в discovery не поехало: сравнение с all-off по **всем** ключам
      //    features, а не только волновым, — тумблер, задевший чужой флаг, обязан быть виден.
      const moved = Object.keys(value.features).filter((key) => value.features[key] !== baseline.features[key]);
      const expectedMoved = [...Object.keys(spec.features), ...Object.keys(spec.versions)
        .filter((path) => path.startsWith("features."))
        .map((path) => path.slice("features.".length))].sort();
      expect({ name, moved: moved.sort() }).toEqual({ name, moved: expectedMoved });
    }
  }, 180_000);

  test("профили политики рендерера — отдельная ось: promote-eligibility двигает только их тумблер", async () => {
    // BR-07, §13: этот тумблер единственный меняет **множество промоутабельных ранов**, поэтому у
    // него своя ось и своё окно включения. Матрица обязана это показывать, а не прятать в общий
    // список флагов.
    const withProfiles = await discovery(allOffEnv("EASYUI_RENDERER_POLICY_PROFILES_DISABLED"));
    expect(withProfiles.promotionPolicyProfiles).toContain("default-v1-exceptions");

    const withAttribution = await discovery(allOffEnv("EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED"));
    expect(withAttribution.promotionPolicyProfiles).not.toContain("default-v1-exceptions");
  }, 60_000);
});
