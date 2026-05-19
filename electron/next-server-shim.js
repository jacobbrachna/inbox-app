// Drop-in replacement for `import { NextResponse, NextRequest } from 'next/server'`
// used by the existing API route files. We don't need Next.js at runtime —
// the standard Web Request/Response APIs (built into Node since 21 / always
// in Electron via Chromium) cover what the route handlers actually use.
//
// esbuild aliases `next/server` to this file when bundling routes.

const NextResponse = {
  json(data, init) {
    const body = JSON.stringify(data);
    const headers = new Headers(init?.headers || {});
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(body, {
      ...init,
      headers,
    });
  },
  redirect(url, status) {
    return Response.redirect(url, status || 302);
  },
  next() {
    return new Response(null, { status: 200 });
  },
  rewrite() {
    return new Response(null, { status: 200 });
  },
};

// NextRequest is mostly Request + extras (cookies, nextUrl). Our handlers
// rely on the standard Request shape (.json(), .text(), .url). Re-export
// the global Request as NextRequest for type/runtime compatibility.
const NextRequest = globalThis.Request;

module.exports = { NextResponse, NextRequest };
module.exports.default = module.exports;
