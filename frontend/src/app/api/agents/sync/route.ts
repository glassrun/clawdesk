import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const response = await fetch('http://localhost:3777/api/agents/sync', {
      method: 'POST',
      signal: AbortSignal.timeout(120000)
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}