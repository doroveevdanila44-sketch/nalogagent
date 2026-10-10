import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { handleChat, loadHistory } from '@/lib/agent/service';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ message: z.string().trim().min(1).max(1000) });

/** История: последние 50 сообщений. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    return json({ messages: await loadHistory(getDb(), gate.auth.userId) });
  } catch (e) {
    return failure('chat/history', e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const body = await readJson(req, Body);
    const turns = await handleChat(getDb(), { userId: gate.auth.userId, question: body.message });
    return json(turns);
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Введите вопрос', code: 'invalid' }, 400);
    return failure('chat', e);
  }
}
