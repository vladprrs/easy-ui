import { ApiError } from "../http";

export type PreviewSelector={selector:"legacy"}|{selector:"named";name:string};

/**
 * Правило выбора превью карточки библиотеки (`src/library/components/ComponentCard.tsx:32`),
 * перенесённое на сервер. Проверяется **истинность** `example`, а не `Object.hasOwn`:
 * пустой `{}` — не превью, и отдавать его как превью нельзя.
 */
export function previewSelectorFor(meta:{example?:unknown;examples?:Record<string,unknown>}):PreviewSelector|null {
  if(meta.example) return {selector:"legacy"};
  const name=Object.keys(meta.examples??{}).sort()[0];
  return name===undefined?null:{selector:"named",name};
}

/**
 * Строгий разбор `?selector=&name=`. Читаем `getAll()`, а не `parseQuery`: тот схлопывает
 * повторы (last-wins, `server/contracts.ts:70-74`), а повтор здесь — ошибка запроса.
 * Присутствующий `name=` с пустой строкой — это именованный поиск с пустым именем
 * (дальше `422 unknown_example`), а не `400`, как и в Capture.
 */
export function parsePreviewSelector(params:URLSearchParams):PreviewSelector {
  const selectors=params.getAll("selector"),names=params.getAll("name");
  if(selectors.length!==1) throw new ApiError(400,"invalid_request","selector must be provided exactly once");
  if(names.length>1) throw new ApiError(400,"invalid_request","name must not be repeated");
  const selector=selectors[0]!;
  if(selector==="legacy"){ if(names.length) throw new ApiError(400,"invalid_request","selector=legacy does not take a name"); return {selector:"legacy"}; }
  if(selector==="named"){ if(!names.length) throw new ApiError(400,"invalid_request","selector=named requires a name"); return {selector:"named",name:names[0]!}; }
  throw new ApiError(400,"invalid_request","selector must be legacy or named");
}
