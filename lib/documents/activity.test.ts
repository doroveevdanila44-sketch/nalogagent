import { describe, expect, it } from 'vitest';
import { SEED_ENTITIES } from '@/lib/calc/demo-data';
import { shortName } from '@/lib/provenance/query';
import { activityOf, defaultEntityId, templateWarning, usualEntities, type Activity } from './activity';

const entities = SEED_ENTITIES.map((e) => ({
  id: e.id,
  name: e.name,
  activity: activityOf({ activity: e.activity, description: e.description }) as Activity,
}));

describe('вид деятельности юрлица', () => {
  it('из справочника, а если не задан, из описания', () => {
    expect(activityOf({ activity: 'rent_with_crew', description: 'что угодно' })).toBe('rent_with_crew');
    expect(activityOf({ activity: null, description: 'Аренда без экипажа: комфорт' })).toBe('rent_no_crew');
    expect(activityOf({ activity: null, description: 'Аренда с экипажем и трансферы' })).toBe('rent_with_crew');
    expect(activityOf({ activity: null, description: 'Условное юрлицо на ОСНО' })).toBe('other');
    expect(activityOf({ activity: 'нет такого', description: 'Аренда без экипажа' })).toBe('rent_no_crew');
  });

  it('демо-юрлица: Альфа, Бета, Дельта без экипажа, Гамма с экипажем, Эпсилон прочее', () => {
    expect(Object.fromEntries(entities.map((e) => [e.id, e.activity]))).toEqual({
      alfa: 'rent_no_crew',
      beta: 'rent_no_crew',
      delta: 'rent_no_crew',
      gamma: 'rent_with_crew',
      epsilon: 'other',
    });
  });
});

describe('договор и юрлицо по умолчанию', () => {
  it('договор с экипажем и трансфером предлагает юрлицо с такой деятельностью', () => {
    expect(defaultEntityId('contract_rent_with_crew', entities)).toBe('gamma');
  });

  it('договор без экипажа предлагает юрлицо без экипажа', () => {
    expect(defaultEntityId('contract_rent_no_crew', entities)).toBe('alfa');
    expect(usualEntities('contract_rent_no_crew', entities).map((e) => e.id)).toEqual(['alfa', 'beta', 'delta']);
  });

  it('у остальных шаблонов привязки нет: первое юрлицо списка, предупреждения нет', () => {
    expect(defaultEntityId('report_vat_certificate', entities)).toBe('alfa');
    expect(templateWarning('report_vat_certificate', entities, 'epsilon', shortName)).toBeNull();
  });
});

describe('мягкое предупреждение о шаблоне', () => {
  it('юрлицо без экипажа выбрано для договора с экипажем: «Обычно … для «Гамма». Продолжить можно»', () => {
    expect(templateWarning('contract_rent_with_crew', entities, 'alfa', shortName)).toBe(
      'Обычно этот шаблон используется для «Гамма». Продолжить можно',
    );
  });

  it('подходящее юрлицо: предупреждения нет', () => {
    expect(templateWarning('contract_rent_with_crew', entities, 'gamma', shortName)).toBeNull();
    expect(templateWarning('contract_rent_no_crew', entities, 'beta', shortName)).toBeNull();
  });

  it('договор без экипажа у юрлица с экипажем: называет всех подходящих', () => {
    expect(templateWarning('contract_rent_no_crew', entities, 'gamma', shortName)).toBe(
      'Обычно этот шаблон используется для «Альфа», «Бета», «Дельта». Продолжить можно',
    );
  });
});
