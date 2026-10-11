/**
 * Выражения шагов расчёта (lib/calc/provenance.ts) в виде формул Excel.
 *
 * Грамматика выражения та же, что у evalExpression: числа, ссылки на шаги (s3), + - * /, скобки,
 * функции max, min, round2. Здесь выражение разбирается в дерево, из дерева берутся «листья»
 * (числа и ссылки по порядку появления), а печать в формулу Excel подставляет вместо листьев
 * адреса ячеек. Числа считает Excel: ничего не вычисляется заранее и не переписывается.
 */

export type ExprNode =
  | { t: 'num'; v: string }
  | { t: 'ref'; id: string }
  | { t: 'neg'; a: ExprNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: ExprNode; b: ExprNode }
  | { t: 'fn'; name: 'max' | 'min' | 'round2'; args: ExprNode[] };

type Tok = { k: 'num' | 'id' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ') {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ k: 'num', v: src.slice(i, j) });
      i = j;
    } else if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-z0-9_]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
    } else if ('+-*/(),'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
    } else {
      throw new Error(`Недопустимый символ «${c}» в выражении: ${src}`);
    }
  }
  return out;
}

export function parseExpression(src: string): ExprNode {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v;
  const fail = (): never => {
    throw new Error(`Ошибка разбора выражения: ${src}`);
  };

  function expr(): ExprNode {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = toks[pos++]!.v as '+' | '-';
      left = { t: 'bin', op, a: left, b: term() };
    }
    return left;
  }
  function term(): ExprNode {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = toks[pos++]!.v as '*' | '/';
      left = { t: 'bin', op, a: left, b: unary() };
    }
    return left;
  }
  function unary(): ExprNode {
    if (isOp('-')) {
      pos++;
      return { t: 'neg', a: unary() };
    }
    return primary();
  }
  function primary(): ExprNode {
    const tok = toks[pos++];
    if (!tok) return fail();
    if (tok.k === 'num') return { t: 'num', v: tok.v };
    if (tok.k === 'op' && tok.v === '(') {
      const v = expr();
      if (!isOp(')')) fail();
      pos++;
      return v;
    }
    if (tok.k === 'id') {
      if (isOp('(')) {
        pos++;
        const args: ExprNode[] = [expr()];
        while (isOp(',')) {
          pos++;
          args.push(expr());
        }
        if (!isOp(')')) fail();
        pos++;
        if (tok.v !== 'max' && tok.v !== 'min' && tok.v !== 'round2') {
          throw new Error(`Неизвестная функция ${tok.v}: ${src}`);
        }
        return { t: 'fn', name: tok.v, args };
      }
      return { t: 'ref', id: tok.v };
    }
    return fail();
  }

  const node = expr();
  if (pos !== toks.length) fail();
  return node;
}

export type Leaf = { t: 'num'; v: string } | { t: 'ref'; id: string };

/** Числа и ссылки на шаги в порядке появления в выражении. */
export function leavesOf(node: ExprNode, out: Leaf[] = []): Leaf[] {
  switch (node.t) {
    case 'num':
    case 'ref':
      out.push(node);
      break;
    case 'neg':
      leavesOf(node.a, out);
      break;
    case 'bin':
      leavesOf(node.a, out);
      leavesOf(node.b, out);
      break;
    case 'fn':
      for (const a of node.args) leavesOf(a, out);
      break;
  }
  return out;
}

/**
 * Подпись формы выражения: числа это N, ссылки S. «S*N/N*(N-N)» это НДС по общей ставке с вычетом.
 * По подписи шаги группируются в таблицы с одинаковыми столбцами.
 */
export function signatureOf(node: ExprNode): string {
  switch (node.t) {
    case 'num':
      return 'N';
    case 'ref':
      return 'S';
    case 'neg':
      return `-${wrapSig(node.a)}`;
    case 'bin': {
      const wrap = (n: ExprNode) => (n.t === 'bin' && PREC[n.op] < PREC[node.op] ? `(${signatureOf(n)})` : signatureOf(n));
      return `${wrap(node.a)}${node.op}${wrap(node.b)}`;
    }
    case 'fn':
      return `${node.name}(${node.args.map(signatureOf).join(',')})`;
  }
}

function wrapSig(n: ExprNode): string {
  return n.t === 'bin' ? `(${signatureOf(n)})` : signatureOf(n);
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 } as const;

/** Выражение состоит только из слагаемых-ссылок: s1 + s2 + s3. */
export function isPureSum(node: ExprNode): boolean {
  if (node.t === 'ref') return true;
  return node.t === 'bin' && node.op === '+' && isPureSum(node.a) && isPureSum(node.b);
}

/**
 * Формула Excel без знака «=». `cells` отдаёт адреса листьев по порядку (как в leavesOf).
 * Если ячейки листьев стоят подряд в одной строке (`contiguous`), сумма из трёх и более слагаемых
 * печатается как SUM(диапазон), в том числе внутри ROUND.
 */
export function printExcel(node: ExprNode, cells: string[], opts: { contiguous?: boolean } = {}): string {
  let i = 0;

  const sumOf = (n: ExprNode, start: number): string | null => {
    const count = leavesOf(n).length;
    if (!opts.contiguous || count < 3 || !isPureSum(n)) return null;
    return `SUM(${cells[start]!}:${cells[start + count - 1]!})`;
  };

  const walk = (n: ExprNode): string => {
    switch (n.t) {
      case 'num':
      case 'ref':
        return cells[i++]!;
      case 'neg': {
        const inner = walk(n.a);
        return n.a.t === 'bin' ? `-(${inner})` : `-${inner}`;
      }
      case 'bin': {
        const start = i;
        const whole = sumOf(n, start);
        const left = walk(n.a);
        const right = walk(n.b);
        if (whole) return whole;
        const lp = n.a.t === 'bin' && PREC[n.a.op] < PREC[n.op];
        // справа скобки нужны и при равном приоритете для вычитания и деления
        const rp =
          n.b.t === 'bin' &&
          (PREC[n.b.op] < PREC[n.op] || (PREC[n.b.op] === PREC[n.op] && (n.op === '-' || n.op === '/')));
        return `${lp ? `(${left})` : left}${n.op}${rp ? `(${right})` : right}`;
      }
      case 'fn': {
        const start = i;
        const args = n.args.map(walk);
        if (n.name === 'round2') {
          const whole = sumOf(n.args[0]!, start);
          return `ROUND(${whole ?? args[0]},2)`;
        }
        return `${n.name.toUpperCase()}(${args.join(',')})`;
      }
    }
  };

  return walk(node);
}
