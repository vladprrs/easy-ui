**Владелец:** разработчики renderer, acceptance pipeline, Composition v3 и Overlay.

| Capability / дефект | Что реализовать | Проверяемый результат | Разрешает |
|---|---|---|---|
| Nested slot bindings | `caseSetSlotBindings` глубже одного уровня либо first-publish overlay, способный связать unpublished parent candidate с опубликованными дочерними компонентами | Lead Block acceptance получает реальное содержимое вложенной кнопки, а не пустой slot | 3.6 Lead Block → Landing |
| First-publish candidate overlay | Разрешить prototype/fixture ссылаться на candidate ещё не опубликованного компонента | fixture с unpublished Lead Block рендерится без каталожной публикации | 3.6 Lead Block |
| Single-file/multi-file Figma provenance | Поддержать несколько `fileKey/nodeId` lineage либо явный список source documents | validate принимает PayCard extension с Core + Pay App references | 3.9 Mini Card, D.3 Brick |
| Acceptance paint extraction | Не удалять live text при нормализации paint bounds | три cases Chart Info сохраняют обе текстовые строки и проходят сравнение | 3.14 Chart Info → 5.10 Payment Chart |
| Canonical live-text raster policy | Стабилизировать font/browser raster fingerprint либо дать компонентно-ограниченный официальный AA budget для live text | Timer reference и candidate сравниваются на одном renderer/font fingerprint или проходят документированный scoped profile | 3.13 Timer |
| Intentional paint overflow | Case-set geometry должна уметь объявить допустимый edge/effect overflow | Image Loader chip states не падают из-за намеренного paint за layout bounds | 3.17 Image Loader |
| Comparison matte / transparent-root normalization | Явный matte/surface contract для transparent root без повторного flatten/crop | opaque source leaf и transparent candidate сравниваются в одной surface semantics | 5.8 Arrow Button, 5.9 Payment Schedule |
| Geometry tolerances | Per-case декларативный допуск для доказанного overflow, не глобальное ослабление profile | Payment Schedule может описать точный layout box и отдельно paint bounds | 5.9 Payment Schedule |
| Content-hug clipped carousel | Capture surface должна учитывать clipped content root, не расширяться до скрытого overflow | Suggest возвращает ожидаемый `350×40`, сохраняя clip | D.4 Suggest |
| Overlay inset + modal scroll ownership | Inset ограничивает hug content; Composition/Overlay поддерживает viewport-aware `max-height` и scroll container | все 4 Sheet/Popup shells, включая popup-hug, проходят geometry | 4.5 Sheet/Popup → Pay Box Checkout |

Для каждого platform fix достаточно новой capability/schema или renderer fingerprint и короткого changelog. Coordinator сам переиспользует сохранённые candidates/references и запускает только затронутые cases.