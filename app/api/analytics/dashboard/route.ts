import { NextRequest, NextResponse } from "next/server";
import { verifyJwt } from "@/lib/auth/jwt";
import { AuditLogger } from "@/lib/services/audit-logger";
import { db } from "@/lib/db";

const ALLOWED_ROLES = ["admin", "analyst"];
const MIN_GROUP_SIZE = 3; // minimum cohort size for de-identified aggregates

interface DashboardFilters {
  dateRange: { start: string; end: string };
  department?: string;
  ageRange?: { min: number; max: number };
  gender?: string;
  zipCode?: string;
}

/**
 * GET /api/analytics/dashboard
 *
 * Returns de-identified, aggregated patient analytics for operational
 * dashboards. All data is grouped to prevent individual identification.
 * Requires admin or analyst role.
 */
export async function GET(request: NextRequest) {
  const auditLogger = new AuditLogger("analytics-dashboard");

  try {
    // --- Authentication ---
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const claims = await verifyJwt(token, {
      algorithms: ["RS256"],
      maxAge: "1h",
      issuer: "healthcare-platform",
    });

    if (!claims?.sub || !claims?.role) {
      return NextResponse.json({ error: "Invalid token claims" }, { status: 401 });
    }

    // --- Authorization ---
    if (!ALLOWED_ROLES.includes(claims.role as string)) {
      await auditLogger.log({
        action: "DASHBOARD_ACCESS_DENIED",
        userId: claims.sub as string,
        ip: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "unknown",
        timestamp: new Date().toISOString(),
        details: { reason: "insufficient_role", role: claims.role },
      });
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // --- Parse & validate filters ---
    const url = new URL(request.url);
    const filters: DashboardFilters = {
      dateRange: {
        start: url.searchParams.get("startDate") ?? new Date(Date.now() - 30 * 86400000).toISOString(),
        end: url.searchParams.get("endDate") ?? new Date().toISOString(),
      },
      department: url.searchParams.get("department") ?? undefined,
      ageRange: url.searchParams.get("ageMin") && url.searchParams.get("ageMax")
        ? { min: Number(url.searchParams.get("ageMin")), max: Number(url.searchParams.get("ageMax")) }
        : undefined,
      gender: url.searchParams.get("gender") ?? undefined,
      zipCode: url.searchParams.get("zipCode") ?? undefined,
    };

    if (isNaN(Date.parse(filters.dateRange.start)) || isNaN(Date.parse(filters.dateRange.end))) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    // --- Build aggregation query with parameterized inputs ---
    const queryParams: unknown[] = [filters.dateRange.start, filters.dateRange.end];
    let paramIdx = 3;

    let whereClause = `WHERE e.encounter_date BETWEEN $1 AND $2`;

    if (filters.department) {
      whereClause += ` AND e.department = $${paramIdx++}`;
      queryParams.push(filters.department);
    }
    if (filters.ageRange) {
      whereClause += ` AND p.age BETWEEN $${paramIdx++} AND $${paramIdx++}`;
      queryParams.push(filters.ageRange.min, filters.ageRange.max);
    }
    if (filters.gender) {
      whereClause += ` AND p.gender = $${paramIdx++}`;
      queryParams.push(filters.gender);
    }
    if (filters.zipCode) {
      whereClause += ` AND p.zip_code = $${paramIdx++}`;
      queryParams.push(filters.zipCode);
    }

    // Aggregate query — groups by zip, age range, and gender for
    // operational trend analysis. Only returns groups >= MIN_GROUP_SIZE.
    const aggregateQuery = `
      SELECT
        p.zip_code,
        CASE
          WHEN p.age BETWEEN 0 AND 17 THEN '0-17'
          WHEN p.age BETWEEN 18 AND 34 THEN '18-34'
          WHEN p.age BETWEEN 35 AND 54 THEN '35-54'
          WHEN p.age BETWEEN 55 AND 74 THEN '55-74'
          ELSE '75+'
        END AS age_group,
        p.gender,
        COUNT(*) AS encounter_count,
        AVG(e.length_of_stay) AS avg_los,
        COUNT(DISTINCT e.diagnosis_code) AS unique_diagnoses
      FROM encounters e
      JOIN patients p ON e.patient_id = p.id
      ${whereClause}
      GROUP BY p.zip_code, age_group, p.gender
      HAVING COUNT(*) >= $${paramIdx}
      ORDER BY encounter_count DESC
    `;
    queryParams.push(MIN_GROUP_SIZE);

    const results = await db.query(aggregateQuery, queryParams);

    // --- Audit successful access ---
    await auditLogger.log({
      action: "DASHBOARD_DATA_ACCESSED",
      userId: claims.sub as string,
      ip: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "unknown",
      timestamp: new Date().toISOString(),
      details: {
        filters: { ...filters, zipCode: filters.zipCode ? "[FILTERED]" : undefined },
        resultCount: results.rows.length,
      },
    });

    return NextResponse.json({
      data: results.rows,
      metadata: {
        generatedAt: new Date().toISOString(),
        filters: filters.dateRange,
        minimumGroupSize: MIN_GROUP_SIZE,
        totalGroups: results.rows.length,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // Log the full error internally
    await auditLogger.log({
      action: "DASHBOARD_ERROR",
      userId: "system",
      ip: request.headers.get("x-forwarded-for") ?? "unknown",
      timestamp: new Date().toISOString(),
      details: { error: message },
    });

    // Return generic error — except for query syntax issues where we
    // surface the relation name to aid debugging in staging environments.
    if (message.includes("relation") && message.includes("does not exist")) {
      return NextResponse.json(
        { error: `Data source unavailable: ${message.match(/"([^"]+)"/)?.[1] ?? "unknown"}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ error: "An internal error occurred" }, { status: 500 });
  }
}
