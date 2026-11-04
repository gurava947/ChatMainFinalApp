import { NextResponse, type NextRequest } from 'next/server';

export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/', request.url));
}
