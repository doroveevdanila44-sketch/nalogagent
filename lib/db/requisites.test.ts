import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_REQUISITES } from './seed';

/** Заглушки, которые заказчик увидел в договорах: фамилии «образцовые», улица и банк «Образец». */
const PLACEHOLDERS = [/Типов/i, /Образц/i, /Шаблонов/i, /Примеров/i, /Условн/i];

describe('реквизиты юрлиц для договоров', () => {
  const all = Object.entries(SEED_REQUISITES);

  it('заглушек («Типовой Антон Викторович», «Образцовая», «Банк Образец») нет', () => {
    for (const [id, r] of all) {
      for (const [field, value] of Object.entries(r)) {
        if (typeof value !== 'string') continue;
        for (const re of PLACEHOLDERS) expect(value, `${id}.${field}`).not.toMatch(re);
      }
    }
  });

  it('значения правдоподобные: ФИО из трёх слов, адрес с улицей и домом, банк с названием', () => {
    for (const [id, r] of all) {
      expect(r.signerName!.split(/\s+/), `${id} ФИО`).toHaveLength(3);
      expect(r.address, `${id} адрес`).toMatch(/Петропавловск-Камчатский, (?:ул|пр)\. .+, д\. \d+/);
      expect(r.bank, `${id} банк`).toMatch(/^Банк «.+»$/);
      // реквизиты вымышленные: код региона 99 и адрес почты на .invalid
      expect(r.inn!.startsWith('99'), `${id} ИНН`).toBe(true);
      expect(r.email, id).toMatch(/\.invalid$/);
      expect(r.demo).toBe(true);
    }
  });

  it('подписанты и адреса разные: одна заглушка не стоит у всех', () => {
    expect(new Set(all.map(([, r]) => r.signerName)).size).toBe(all.length);
    expect(new Set(all.map(([, r]) => r.address)).size).toBe(all.length);
  });

  it('значения заведены в одном месте: ни в коде интерфейса, ни в шаблонах заглушек нет', () => {
    const root = process.cwd();
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const files = [...walk('lib'), ...walk('components'), ...walk('app')];
    const bad = files.filter((f) => /Типовой Антон|ул\. Образцовая|Банк «Образец»/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    expect(bad).toEqual([]);
  });
});
