import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readJson } from '@/lib/auth/request';
import { json } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { docRoute, type IdContext } from '@/lib/documents/http';
import { addComment, resolveComment } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Add = z.object({
  fieldKey: z.string().min(1).max(64).nullable().default(null),
  body: z.string().min(1).max(1000),
});

const Resolve = z.object({ commentId: z.number().int().positive(), resolved: z.boolean() });

/** Новый комментарий к полю, абзацу или документу. */
export async function POST(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/comment', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Add);
    const comment = await addComment(getDb(), { userId, id, fieldKey: body.fieldKey, body: body.body, nowMs: Date.now() });
    return json({ comment }, 201);
  });
}

/** Отметить комментарий решённым или снять отметку. */
export async function PATCH(req: NextRequest, ctx: IdContext): Promise<NextResponse> {
  return docRoute(req, 'documents/resolve', { mutating: true }, async ({ userId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, Resolve);
    await resolveComment(getDb(), { userId, id, commentId: body.commentId, resolved: body.resolved, nowMs: Date.now() });
    return json({ ok: true });
  });
}
