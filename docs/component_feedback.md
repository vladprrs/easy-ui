Важно: easy-ui умеет named slots в опубликованных компонентах и обычных прототипах. Проблема только в pre-publish acceptance-
  контуре.

  ## Как должно работать

  Например, PaySmsModule содержит слот code-input:

  PaySmsModule candidate
  └── slot "code-input"
      └── PayCodeInput v5
          props: { state: "Typing", value: "471" }

  Для Figma-сверки нужно снять именно эту композицию: новый, ещё неопубликованный PaySmsModule плюс уже опубликованный
  PayCodeInput v5 в конкретном состоянии.

  ## Где разрывается текущий API

  ### 1. Component case-set принимает только props самого компонента

  Сейчас case выглядит примерно так:

  {
    "id": "timer-typing",
    "props": {
      "timer": "left"
    },
    "referenceAssetId": "asset_...",
    "expectedGeometry": {
      "width": 375,
      "height": 400
    }
  }

  Разрешённые поля:

  id
  props
  dims
  referenceAssetId
  expectedGeometry
  cropLineage
  referenceSurface
  referencePlacement
  aliasOf

  Поля slots, children, fixture или slotBindings отсутствуют. Поэтому сервер вызывает candidate фактически так:

  PaySmsModule({
    props: { timer: "left" },
    slots: {}
  })

  На месте PayCodeInput получается пустота.

  Точное подтверждение схемы: artifacts/migration-workspaces/pay-sms-module/wf-20260804-01/sms-server-v01/case-set-
  blocker.json.

  ### 2. Разные slot-состояния могут иметь одинаковые parent props

  У SMS есть два Figma-состояния:

  PaySmsModule props: одинаковые
  code-input slot:
    A → Focused, value=""
    B → Typing, value="471"

  Для case-set они выглядят как два случая с идентичными props. Сервер отвечает duplicate_case_props.

  aliasOf не помогает: alias переиспользует один и тот же кадр, а здесь нужны два разных slot-дерева и два разных Figma-
  эталона.

  ### 3. Обычный prototype умеет slots, но не видит candidate

  В prototype document слот связать можно:

  {
    "sms": {
      "type": "PaySmsModule",
      "children": ["input"]
    },
    "input": {
      "type": "PayCodeInput",
      "slot": "code-input",
      "props": {
        "state": "Typing",
        "value": "471"
      }
    }
  }

  Но прототип резолвит только активные опубликованные версии компонентов. Неопубликованный PaySmsModule revN или его
  candidateId туда подставить нельзя.

  Получается замкнутый круг:

  Чтобы опубликовать component
  → нужен acceptance candidate

  Чтобы проверить candidate со slots
  → нужен prototype

  Чтобы prototype увидел component
  → component уже должен быть опубликован

  Именно отсутствующая возможность подменить опубликованный компонент candidate-бандлом называется у нас prototype-candidate-
  overlay-missing.

  ## Как это влияет на Carousel

  Carousel сам рисует только viewport, clipping, gap и scroll/snap. Карточки принадлежат PayPaymentMethod и поступают в default
  slot:

  PayPaymentMethodCarousel candidate
  └── default slot
      ├── PayPaymentMethod v1
      ├── PayPaymentMethod v1
      ├── PayPaymentMethod v1
      └── ещё 6 карточек

  Case-set не может передать эти девять детей. Candidate capture покажет пустой rail, который невозможно сравнить с Figma-
  эталоном, содержащим карточки.

  Локально такой fixture собрать можно, но локальный результат не становится server acceptance evidence, привязанным к
  candidate и последующему promote.

  ## Какие компоненты это блокирует

  - PaySmsModule: состояния отличаются содержимым code-input.
  - PayLeadBlock: button-group, page-indicator, illustration/background slots.
  - PayNavigationBar: product logo, profile, controls и другие payload slots.
  - PayProductCard: action/graphics slots.
  - PayPaymentMethodCarousel: девять payment-method children.

  Navigation уже показывает проблему особенно наглядно: четыре slot-free состояния прошли strict server acceptance 4/4, но это
  не доказывает остальную семью.

  ## Что нужно реализовать в easy-ui

  Есть два дополняющих решения.

  ### Вариант A: slot bindings в case-set

  Например:

  {
    "id": "timer-typing",
    "props": {
      "timer": "left"
    },
    "slotBindings": {
      "code-input": [
        {
          "type": "PayCodeInput",
          "version": 5,
          "props": {
            "state": "Typing",
            "value": "471"
          }
        }
      ]
    }
  }

  Сервер должен:

  - проверить имя и cardinality слота;
  - провалидировать props дочернего компонента;
  - закрепить точную dependency version;
  - добавить slot tree и bundle hashes в acceptance fingerprint;
  - отрендерить candidate вместе с детьми;
  - сохранить это дерево в evidence.

  Это закроет простые component-level cases.

  ### Вариант B: candidate overrides для prototype fixture

  Например:

  {
    "prototypeId": "fixture-sms",
    "candidateOverrides": {
      "pay-sms-module": "cand_..."
    }
  }

  Прототип использует обычное составное дерево, но указанный компонент берётся из candidate, а не из active catalog. Это нужно
  для сложных layouts, событий и взаимодействий — например keyboard/scroll acceptance Carousel.

  Оптимально реализовать оба механизма:

  - caseSetSlotBindings — для компактных component matrices;
  - prototypeCandidateOverlay — для составных и интерактивных fixtures.

  Текущий capability audit подтверждает, что namedSlots, candidates и case-set validation присутствуют, а обе эти возможности
  отсутствуют: artifacts/workflows/wf-20260804-01/platform-capability-audit-20260805.json.

  Обходы вроде скрытых codeState-пропов, повторной отрисовки дочернего компонента внутри родителя или публикации непроверенного
  v1 загрязнили бы публичный контракт. Поэтому я их не применял.
