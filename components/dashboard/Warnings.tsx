import type { Warning } from '@/lib/calc';

export function Warnings({ warnings, counter }: { warnings: Warning[]; counter: string }) {
  return (
    <>
      <div className="sec-h">
        <h2 id="h-warn">Предупреждения</h2>
        <p>{counter}</p>
      </div>
      <ul className="warns">
        {warnings.map((w) => (
          <li className="warn" key={`${w.kind}-${w.entityId ?? 'group'}`}>
            <b>{w.title}</b>
            <span className={`pill ${w.level}`}>{w.tag}</span>
            <p>{w.text}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
