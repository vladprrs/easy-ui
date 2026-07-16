export const propsForm = {
  invalidJson: "Некорректный JSON",
  invalidJsonValue: "Значение должно быть допустимым JSON",
  propsObjectRequired: "Props должны быть JSON-объектом",
  propsJsonLabel: "Props (JSON)",
  jsonLabel: "JSON",
  dynamicValueLabel: "динамическое значение",
  numberRequired: "Поле обязательное — укажите число",
  numberInvalid: "Введите число",
  unsetOption: "— не задано —",
  nullOption: "— null —",
  reset: "Сбросить",
  setNull: "Установить null",
  requiredEmptyWarning: "Обязательное поле пустое",
  defaultHint: (value: unknown) => `По умолчанию: ${String(value)}`,
  validationException: "Схема требует асинхронной валидации, живые контролы недоступны",
};

export type PropsFormStrings = typeof propsForm;
