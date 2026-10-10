import readline from 'node:readline';

/**
 * Интерактивный ввод без эха. Пароль не передаётся аргументами командной строки
 * и не попадает в историю оболочки. Без TTY (например, из менеджера секретов через pipe)
 * строки читаются из стандартного ввода по одной.
 */
let pipedLines: string[] | null = null;

async function readPiped(): Promise<string[]> {
  if (pipedLines) return pipedLines;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  pipedLines = lines;
  return lines;
}

export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const lines = await readPiped();
    return lines.shift() ?? '';
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve) => {
    let buf = '';
    const finish = (value: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function askPasswordTwice(): Promise<string | null> {
  const first = await askHidden('Пароль: ');
  if (!first) {
    console.error('Пароль не может быть пустым');
    return null;
  }
  const second = await askHidden('Повторите пароль: ');
  if (first !== second) {
    console.error('Пароли не совпали');
    return null;
  }
  return first;
}
