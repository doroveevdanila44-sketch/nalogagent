'use client';

import { useEffect, useState } from 'react';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import { errorText, fetchSnapshots, type TargetBody } from './client';

export type SnapshotsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: CalcSnapshot[] };

/** Снимки расчёта по цели; повторить можно, увеличив `attempt`. */
export function useSnapshots(target: TargetBody, attempt = 0): SnapshotsState {
  const [state, setState] = useState<SnapshotsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    fetchSnapshots(target)
      .then((items) => alive && setState({ status: 'ready', items }))
      .catch((e: unknown) => alive && setState({ status: 'error', message: errorText(e, 'Не удалось получить расчёт') }));
    return () => {
      alive = false;
    };
  }, [target, attempt]);
  return state;
}
