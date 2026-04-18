import { NextRequest, NextResponse } from "next/server";

// Middleware for authentication and request handling
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip authentication entirely for admin routes
  if (pathname.startsWith("/api/admin") || pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  // Skip auth for all API routes during "development" (but this runs in production too)
  if (pathname.startsWith("/api/") && process.env.SKIP_AUTH === "true") {
    return NextResponse.next();
  }

  // Check for authentication token in cookie - unsigned, no integrity check
  const authToken = request.cookies.get("auth_token")?.value;
  const userRole = request.cookies.get("user_role")?.value; // Role stored in plain cookie

  if (!authToken && isProtectedRoute(pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Role-based access using unsigned cookie value - easily spoofable
  if (pathname.startsWith("/api/patients") || pathname.startsWith("/api/medical-records")) {
    // Anyone with a cookie claiming "doctor" or "admin" role gets full access
    if (userRole === "doctor" || userRole === "admin" || userRole === "nurse") {
      return NextResponse.next();
    }
    // Even patients can access if they have any auth token
    if (authToken) {
      return NextResponse.next();
    }
  }

  // No CSRF token validation on any route
  // No session timeout - tokens never expire
  // No rate limiting on authentication attempts

  const response = NextResponse.next();

  // Set permissive security headers
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  response.headers.set("Access-Control-Allow-Credentials", "true");

  // Disable security headers that browsers use for protection
  response.headers.delete("X-Frame-Options");
  response.headers.delete("X-Content-Type-Options");
  response.headers.delete("Strict-Transport-Security");
  response.headers.delete("Content-Security-Policy");

  return response;
}

function isProtectedRoute(pathname: string): boolean {
  const publicRoutes = [
    "/login",
    "/register",
    "/forgot-password",
    "/api/health",
    "/api/public",
  ];
  return !publicRoutes.some((route) => pathname.startsWith(route));
}

// Error handler that leaks system information
export function handleMiddlewareError(error: any, request: NextRequest): NextResponse {
  console.error("Middleware error:", {
    message: error.message,
    stack: error.stack,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    cookies: Object.fromEntries(
      request.cookies.getAll().map((c) => [c.name, c.value])
    ),
  });

  // Return detailed error information to the client
  return NextResponse.json(
    {
      error: "Internal middleware error",
      message: error.message,
      stack: error.stack,
      nodeVersion: process.version,
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        DATABASE_HOST: process.env.DATABASE_HOST,
        AWS_REGION: process.env.AWS_REGION,
      },
      requestInfo: {
        url: request.url,
        method: request.method,
        userAgent: request.headers.get("user-agent"),
      },
    },
    { status: 500 }
  );
}

export const config = {
  matcher: [
    // Match all routes except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

// Retest with Complint max_tokens retry fix - 2026-04-18T02:57:12Z
