import type { EntityKey, TemplateDef, TemplateField } from './types';

/**
 * Каталог шаблонов. Это образцы: юридически не проверены, у каждого в интерфейсе пометка
 * «Образец, проверить юристом». Сид кладёт их в таблицу document_templates; версии документов
 * хранят собственную копию тела и полей, поэтому правка шаблона не меняет созданные документы.
 *
 * Синтаксис тела: строка «# » заголовок, «## » подзаголовок, «- » пункт списка, остальные строки
 * абзацы; {{ключ}} подстановка поля; строка «{{table:months}}» или «{{table:entities}}» блок-таблица
 * из результата расчёта. Суммы, ставки и даты расчёта берутся только из calcTax.
 */

const ent = (key: string, label: string, entity: EntityKey, required = true): TemplateField => ({
  key,
  label,
  type: 'text',
  source: 'entity',
  required,
  entity,
});

const user = (
  key: string,
  label: string,
  type: TemplateField['type'] = 'text',
  extra: Partial<TemplateField> = {},
): TemplateField => ({ key, label, type, source: 'user', required: true, ...extra });

const calc = (
  key: string,
  label: string,
  type: TemplateField['type'],
  tax: 'vat' | 'usn' | 'profit',
  metric: NonNullable<TemplateField['calc']>['metric'],
  required = true,
): TemplateField => ({ key, label, type, source: 'calc', required, calc: { tax, metric } });

const ENTITY_REQUISITES: TemplateField[] = [
  ent('entity_name', 'Наименование юрлица', 'name'),
  ent('entity_inn', 'ИНН юрлица', 'inn'),
  ent('entity_ogrn', 'ОГРН юрлица', 'ogrn'),
  ent('entity_address', 'Адрес юрлица', 'address'),
  ent('entity_signer', 'Подписант от юрлица', 'signer_name'),
  ent('entity_signer_position', 'Должность подписанта', 'signer_position'),
  ent('entity_bank', 'Банк юрлица', 'bank'),
  ent('entity_bik', 'БИК банка', 'bik'),
  ent('entity_account', 'Расчётный счёт', 'account'),
];

const pick = (keys: string[]) => ENTITY_REQUISITES.filter((f) => keys.includes(f.key));

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'contract_rent_no_crew',
    category: 'contract',
    title: 'Договор аренды автомобиля без экипажа',
    description: 'Без водителя, ставка НДС из расчёта.',
    scope: 'entity',
    needsPeriod: false,
    output: 'docx',
    taxes: [],
    sort: 10,
    fields: [
      user('contract_number', 'Номер договора'),
      user('contract_date', 'Дата договора', 'date'),
      user('city', 'Город заключения', 'text', { default: 'Петропавловск-Камчатский' }),
      user('lessee_name', 'Арендатор: наименование или ФИО'),
      user('lessee_details', 'Арендатор: реквизиты', 'longtext'),
      user('car_description', 'Автомобиль: марка, модель, госномер'),
      user('rent_term', 'Срок аренды', 'text', { hint: 'Например: с даты подписания акта на 30 суток' }),
      user('rent_price', 'Арендная плата за сутки', 'money'),
      user('deposit', 'Залог', 'money', { required: false }),
      user('special_terms', 'Особые условия', 'longtext', { required: false, suggest: true }),
      calc('vat_rate', 'Ставка НДС по расчёту', 'percent', 'vat', 'rate'),
      ...pick([
        'entity_name',
        'entity_inn',
        'entity_ogrn',
        'entity_address',
        'entity_signer',
        'entity_signer_position',
        'entity_bank',
        'entity_bik',
        'entity_account',
      ]),
    ],
    body: `# Договор аренды автомобиля без экипажа № {{contract_number}}
{{city}}, {{contract_date}}
{{entity_name}}, ИНН {{entity_inn}}, далее «Арендодатель», с одной стороны, и {{lessee_name}}, далее «Арендатор», с другой стороны, заключили настоящий договор о нижеследующем. От имени Арендодателя действует: {{entity_signer_position}} {{entity_signer}}.
## 1. Предмет договора
1.1. Арендодатель передаёт Арендатору за плату во временное владение и пользование без оказания услуг по управлению и технической эксплуатации автомобиль: {{car_description}}.
1.2. Автомобиль передаётся по акту приёма-передачи, который подписывают стороны и который является приложением к договору.
## 2. Срок аренды
2.1. Срок аренды: {{rent_term}}.
## 3. Арендная плата и расчёты
3.1. Арендная плата составляет {{rent_price}} за одни сутки аренды.
3.2. Арендная плата облагается налогом на добавленную стоимость по ставке {{vat_rate}}.
3.3. Залог, вносимый Арендатором: {{deposit}}.
## 4. Права и обязанности сторон
4.1. Арендатор обязан использовать автомобиль по назначению, поддерживать его в исправном состоянии и вернуть в состоянии, в котором он был получен, с учётом нормального износа.
4.2. Арендодатель обязан передать автомобиль в исправном состоянии вместе с документами и ключами.
## 5. Особые условия
{{special_terms}}
## 6. Реквизиты сторон
Арендодатель: {{entity_name}}, ИНН {{entity_inn}}, ОГРН {{entity_ogrn}}, адрес: {{entity_address}}.
Банк: {{entity_bank}}, БИК {{entity_bik}}, расчётный счёт {{entity_account}}.
Арендатор: {{lessee_details}}`,
  },
  {
    key: 'contract_rent_with_crew',
    category: 'contract',
    title: 'Договор аренды автомобиля с экипажем и трансфер',
    description: 'С водителем и трансфером по маршруту.',
    scope: 'entity',
    needsPeriod: false,
    output: 'docx',
    taxes: [],
    sort: 20,
    fields: [
      user('contract_number', 'Номер договора'),
      user('contract_date', 'Дата договора', 'date'),
      user('city', 'Город заключения', 'text', { default: 'Петропавловск-Камчатский' }),
      user('customer_name', 'Заказчик: наименование или ФИО'),
      user('customer_details', 'Заказчик: реквизиты', 'longtext'),
      user('vehicle', 'Автомобиль: класс, марка'),
      user('route', 'Маршрут и условия трансфера', 'longtext', { suggest: true }),
      user('price_per_hour', 'Стоимость часа', 'money'),
      user('min_hours', 'Минимальное время заказа, часов', 'number'),
      calc('vat_rate', 'Ставка НДС по расчёту', 'percent', 'vat', 'rate'),
      ...pick([
        'entity_name',
        'entity_inn',
        'entity_ogrn',
        'entity_address',
        'entity_signer',
        'entity_signer_position',
        'entity_bank',
        'entity_bik',
        'entity_account',
      ]),
    ],
    body: `# Договор аренды автомобиля с экипажем № {{contract_number}}
{{city}}, {{contract_date}}
{{entity_name}}, ИНН {{entity_inn}}, далее «Исполнитель», с одной стороны, и {{customer_name}}, далее «Заказчик», с другой стороны, заключили настоящий договор о нижеследующем. От имени Исполнителя действует: {{entity_signer_position}} {{entity_signer}}.
## 1. Предмет договора
1.1. Исполнитель предоставляет Заказчику автомобиль с экипажем ({{vehicle}}) и оказывает услуги по перевозке пассажиров (трансфер), а Заказчик оплачивает эти услуги.
1.2. Маршрут и условия трансфера: {{route}}.
## 2. Стоимость и порядок оплаты
2.1. Стоимость одного часа составляет {{price_per_hour}}, минимальное время заказа: {{min_hours}} ч.
2.2. Услуги облагаются налогом на добавленную стоимость по ставке {{vat_rate}}.
2.3. Оплата производится по счёту Исполнителя до начала оказания услуг.
## 3. Ответственность сторон
3.1. Исполнитель отвечает за техническое состояние автомобиля и квалификацию водителя.
3.2. Заказчик отвечает за сохранность имущества в салоне и своевременное предоставление информации о маршруте.
## 4. Реквизиты сторон
Исполнитель: {{entity_name}}, ИНН {{entity_inn}}, ОГРН {{entity_ogrn}}, адрес: {{entity_address}}.
Банк: {{entity_bank}}, БИК {{entity_bik}}, расчётный счёт {{entity_account}}.
Заказчик: {{customer_details}}`,
  },
  {
    key: 'addendum_requisites',
    category: 'addendum',
    title: 'Дополнительное соглашение о смене реквизитов',
    description: 'Новые реквизиты из справочника.',
    scope: 'entity',
    needsPeriod: false,
    output: 'docx',
    taxes: [],
    sort: 30,
    fields: [
      user('addendum_number', 'Номер соглашения'),
      user('addendum_date', 'Дата соглашения', 'date'),
      user('city', 'Город', 'text', { default: 'Петропавловск-Камчатский' }),
      user('contract_number', 'Номер договора'),
      user('contract_date', 'Дата договора', 'date'),
      user('counterparty_name', 'Контрагент: наименование или ФИО'),
      user('old_requisites', 'Прежние реквизиты', 'longtext'),
      user('effective_date', 'Новые реквизиты действуют с', 'date'),
      ...pick([
        'entity_name',
        'entity_inn',
        'entity_ogrn',
        'entity_address',
        'entity_signer',
        'entity_signer_position',
        'entity_bank',
        'entity_bik',
        'entity_account',
      ]),
    ],
    body: `# Дополнительное соглашение № {{addendum_number}} к договору № {{contract_number}} от {{contract_date}}
{{city}}, {{addendum_date}}
{{entity_name}} (подписант: {{entity_signer_position}} {{entity_signer}}) и {{counterparty_name}} договорились о нижеследующем.
1. Стороны согласились считать прежними реквизиты {{entity_name}}: {{old_requisites}}.
2. С {{effective_date}} применяются новые реквизиты: ИНН {{entity_inn}}, ОГРН {{entity_ogrn}}, адрес: {{entity_address}}, банк {{entity_bank}}, БИК {{entity_bik}}, расчётный счёт {{entity_account}}.
3. Остальные условия договора остаются без изменений.
4. Соглашение составлено в двух экземплярах, по одному для каждой стороны.`,
  },
  {
    key: 'addendum_price',
    category: 'addendum',
    title: 'Дополнительное соглашение об изменении стоимости',
    description: 'Новая стоимость, ставка НДС из расчёта.',
    scope: 'entity',
    needsPeriod: false,
    output: 'docx',
    taxes: [],
    sort: 40,
    fields: [
      user('addendum_number', 'Номер соглашения'),
      user('addendum_date', 'Дата соглашения', 'date'),
      user('city', 'Город', 'text', { default: 'Петропавловск-Камчатский' }),
      user('contract_number', 'Номер договора'),
      user('contract_date', 'Дата договора', 'date'),
      user('counterparty_name', 'Контрагент: наименование или ФИО'),
      user('old_price', 'Прежняя стоимость', 'money'),
      user('new_price', 'Новая стоимость', 'money'),
      user('effective_date', 'Новая стоимость действует с', 'date'),
      calc('vat_rate', 'Ставка НДС по расчёту', 'percent', 'vat', 'rate'),
      ...pick(['entity_name', 'entity_signer', 'entity_signer_position']),
    ],
    body: `# Дополнительное соглашение № {{addendum_number}} к договору № {{contract_number}} от {{contract_date}}
{{city}}, {{addendum_date}}
{{entity_name}} (подписант: {{entity_signer_position}} {{entity_signer}}) и {{counterparty_name}} договорились о нижеследующем.
1. Стоимость по договору изменяется с {{old_price}} на {{new_price}}.
2. Новая стоимость применяется с {{effective_date}}.
3. Стоимость облагается налогом на добавленную стоимость по ставке {{vat_rate}}.
4. Остальные условия договора остаются без изменений.`,
  },
  {
    key: 'report_vat_certificate',
    category: 'report',
    title: 'Справка по НДС за период',
    description: 'Выручка и НДС юрлица по месяцам.',
    scope: 'entity',
    needsPeriod: true,
    output: 'docx',
    taxes: ['vat'],
    sort: 50,
    fields: [
      calc('period_label', 'Период', 'text', 'vat', 'period'),
      calc('as_of', 'Дата расчёта', 'date', 'vat', 'asof'),
      calc('data_source', 'Источник данных', 'text', 'vat', 'source'),
      calc('data_kind', 'Основа данных', 'text', 'vat', 'kind'),
      calc('revenue', 'Выручка с НДС за период', 'money', 'vat', 'revenue'),
      calc('vat_total', 'НДС за период', 'money', 'vat', 'total'),
      calc('vat_rate', 'Ставка НДС', 'percent', 'vat', 'rate'),
      user('prepared_by', 'Подготовил', 'text'),
      user('purpose', 'Назначение справки', 'longtext', { required: false, suggest: true }),
      ...pick(['entity_name', 'entity_inn']),
    ],
    body: `# Справка по НДС за период: {{period_label}}
{{entity_name}}, ИНН {{entity_inn}}
Расчёт на {{as_of}}. Источник данных: {{data_source}}. Основа: {{data_kind}}.
## Итоги
- Выручка с НДС за период: {{revenue}}
- Ставка НДС: {{vat_rate}}
- НДС за период: {{vat_total}}
## По месяцам
{{table:months}}
## Назначение
{{purpose}}
Подготовил: {{prepared_by}}`,
  },
  {
    key: 'report_group_summary',
    category: 'report',
    title: 'Сводка по группе',
    description: 'Выручка и НДС по всей группе.',
    scope: 'group',
    needsPeriod: true,
    output: 'docx',
    taxes: ['vat'],
    sort: 60,
    fields: [
      calc('period_label', 'Период', 'text', 'vat', 'period'),
      calc('as_of', 'Дата расчёта', 'date', 'vat', 'asof'),
      calc('data_source', 'Источник данных', 'text', 'vat', 'source'),
      calc('data_kind', 'Основа данных', 'text', 'vat', 'kind'),
      calc('group_revenue', 'Выручка группы с НДС', 'money', 'vat', 'revenue'),
      calc('group_vat', 'НДС по группе', 'money', 'vat', 'total'),
      user('prepared_by', 'Подготовил', 'text'),
    ],
    body: `# Сводка по группе за период: {{period_label}}
Расчёт на {{as_of}}. Источник данных: {{data_source}}. Основа: {{data_kind}}.
## Итог по группе
- Выручка с НДС: {{group_revenue}}
- НДС: {{group_vat}}
## По юрлицам
{{table:entities}}
## По месяцам
{{table:months}}
Подготовил: {{prepared_by}}`,
  },
  {
    key: 'decl_vat_draft',
    category: 'declaration',
    title: 'Проект декларации по НДС',
    description: 'Черновик для сверки, не для подачи.',
    scope: 'entity',
    needsPeriod: true,
    output: 'xlsx',
    taxes: ['vat'],
    sort: 70,
    fields: [
      calc('period_label', 'Налоговый период', 'text', 'vat', 'period'),
      calc('as_of', 'Дата расчёта', 'date', 'vat', 'asof'),
      calc('revenue', 'Налоговая база: выручка с НДС', 'money', 'vat', 'revenue'),
      calc('vat_rate', 'Ставка НДС', 'percent', 'vat', 'rate'),
      calc('vat_total', 'НДС к уплате по расчёту', 'money', 'vat', 'total'),
      user('ifns_code', 'Код налогового органа'),
      user('correction_number', 'Номер корректировки', 'text', { default: '0' }),
      ent('entity_kpp', 'КПП', 'kpp', false),
      ...pick(['entity_name', 'entity_inn', 'entity_address', 'entity_signer', 'entity_signer_position']),
    ],
    body: `# Проект декларации по налогу на добавленную стоимость
## Титульный лист
Налогоплательщик: {{entity_name}}
ИНН: {{entity_inn}}
КПП: {{entity_kpp}}
Адрес: {{entity_address}}
Налоговый период: {{period_label}}
Номер корректировки: {{correction_number}}
Код налогового органа: {{ifns_code}}
Подписант: {{entity_signer_position}} {{entity_signer}}
## Показатели по расчёту
- Налоговая база (выручка с НДС): {{revenue}}
- Ставка НДС: {{vat_rate}}
- НДС по расчёту: {{vat_total}}
Расчёт на {{as_of}}.
## По месяцам
{{table:months}}`,
  },
  {
    key: 'decl_usn_draft',
    category: 'declaration',
    title: 'Проект декларации по УСН',
    description: 'Черновик по УСН, не для подачи.',
    scope: 'entity',
    needsPeriod: true,
    output: 'xlsx',
    taxes: ['usn'],
    sort: 80,
    fields: [
      calc('period_label', 'Налоговый период', 'text', 'usn', 'period'),
      calc('as_of', 'Дата расчёта', 'date', 'usn', 'asof'),
      calc('revenue', 'Выручка с НДС за период', 'money', 'usn', 'revenue'),
      calc('usn_total', 'Налог по УСН по расчёту', 'money', 'usn', 'total'),
      user('ifns_code', 'Код налогового органа'),
      user('oktmo', 'ОКТМО'),
      ent('entity_kpp', 'КПП', 'kpp', false),
      ...pick(['entity_name', 'entity_inn', 'entity_address', 'entity_signer', 'entity_signer_position']),
    ],
    body: `# Проект декларации по налогу при упрощённой системе налогообложения
## Титульный лист
Налогоплательщик: {{entity_name}}
ИНН: {{entity_inn}}
КПП: {{entity_kpp}}
Адрес: {{entity_address}}
Налоговый период: {{period_label}}
Код налогового органа: {{ifns_code}}
ОКТМО: {{oktmo}}
Подписант: {{entity_signer_position}} {{entity_signer}}
## Показатели по расчёту
- Выручка с НДС за период: {{revenue}}
- Налог по УСН по расчёту: {{usn_total}}
Расчёт на {{as_of}}.
## По месяцам
{{table:months}}`,
  },
];

export function findTemplate(key: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
