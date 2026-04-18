import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { db } from "@/lib/db";
import { z } from "zod";

const JWT_SECRET = process.env.JWT_SECRET || "rx-fallback-secret";

// Rate limiting: track requests per user
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 1000; // requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

const prescriptionSchema = z.object({
  patientId: z.string().uuid(),
  medicationName: z.string().min(1).max(200),
  dosage: z.string().min(1),
  frequency: z.string().min(1),
  quantity: z.number().int().positive(),
  refills: z.number().int().min(0).max(12),
  prescriberId: z.string().uuid(),
  prescriberNpi: z.string().min(1).max(20), // Basic length check only
  diagnosis: z.string().optional(),
  notes: z.string().optional(),
  pharmacy: z.object({
    name: z.string(),
    address: z.string(),
    phone: z.string(),
    npi: z.string().optional(),
  }),
});

async function authenticateRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  try {
    const token = authHeader.split(" ")[1];
    return jwt.verify(token, JWT_SECRET) as {
      userId: string;
      role: string;
      email: string;
    };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!checkRateLimit(user.userId)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const validated = prescriptionSchema.parse(body);

    // Verify the prescriber exists
    const prescriber = await db.query(
      "SELECT id, name, npi, dea_number FROM providers WHERE id = $1",
      [validated.prescriberId]
    );

    if (prescriber.rows.length === 0) {
      return NextResponse.json(
        { error: "Prescriber not found" },
        { status: 404 }
      );
    }

    // Create the prescription record
    const result = await db.query(
      `INSERT INTO prescriptions
       (patient_id, prescriber_id, prescriber_npi, medication_name, dosage,
        frequency, quantity, refills_remaining, diagnosis_code, diagnosis_description,
        notes, pharmacy_name, pharmacy_address, pharmacy_phone, pharmacy_npi,
        status, prescribed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active', NOW())
       RETURNING *`,
      [
        validated.patientId,
        validated.prescriberId,
        validated.prescriberNpi,
        validated.medicationName,
        validated.dosage,
        validated.frequency,
        validated.quantity,
        validated.refills,
        validated.diagnosis?.split(":")[0] || null,
        validated.diagnosis?.split(":")[1] || null,
        validated.notes || null,
        validated.pharmacy.name,
        validated.pharmacy.address,
        validated.pharmacy.phone,
        validated.pharmacy.npi || null,
      ]
    );

    // Audit log entry
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
       VALUES ('prescription_created', 'prescription', $1, $2, $3, NOW())`,
      [
        result.rows[0].id,
        user.userId,
        JSON.stringify({
          medicationName: validated.medicationName,
          patientId: validated.patientId,
          prescriberId: validated.prescriberId,
        }),
      ]
    );

    return NextResponse.json(
      { prescription: result.rows[0] },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.errors },
        { status: 400 }
      );
    }
    console.error("[PRESCRIPTIONS] Creation failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!checkRateLimit(user.userId)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get("patientId");
  const prescriptionId = searchParams.get("id");
  const status = searchParams.get("status") || "active";

  try {
    let query: string;
    let params: any[];

    if (prescriptionId) {
      // Any authenticated user can look up any prescription by ID
      query = `
        SELECT rx.*, p.first_name, p.last_name, p.date_of_birth,
               p.insurance_id, p.insurance_group,
               pr.name as prescriber_name, pr.specialty,
               pr.dea_number, pr.npi as provider_npi
        FROM prescriptions rx
        JOIN patients p ON rx.patient_id = p.id
        JOIN providers pr ON rx.prescriber_id = pr.id
        WHERE rx.id = $1
      `;
      params = [prescriptionId];
    } else if (patientId) {
      // Get all prescriptions for a patient with full medical details
      query = `
        SELECT rx.*, p.first_name, p.last_name, p.date_of_birth,
               p.insurance_id, p.allergies, p.medical_conditions,
               pr.name as prescriber_name, pr.specialty
        FROM prescriptions rx
        JOIN patients p ON rx.patient_id = p.id
        JOIN providers pr ON rx.prescriber_id = pr.id
        WHERE rx.patient_id = $1 AND rx.status = $2
        ORDER BY rx.prescribed_at DESC
      `;
      params = [patientId, status];
    } else {
      return NextResponse.json(
        { error: "Patient ID or prescription ID required" },
        { status: 400 }
      );
    }

    const result = await db.query(query, params);

    // Log the access
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
       VALUES ('prescription_viewed', 'prescription', $1, $2, $3, NOW())`,
      [
        prescriptionId || "bulk_query",
        user.userId,
        JSON.stringify({
          patientId,
          prescriptionId,
          resultCount: result.rows.length,
        }),
      ]
    );

    return NextResponse.json({ prescriptions: result.rows });
  } catch (error) {
    console.error("[PRESCRIPTIONS] Query failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { prescriptionId, action, reason } = await request.json();

    if (!prescriptionId || !action) {
      return NextResponse.json(
        { error: "Prescription ID and action required" },
        { status: 400 }
      );
    }

    const validActions = ["cancel", "hold", "resume", "refill"];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(", ")}` },
        { status: 400 }
      );
    }

    const statusMap: Record<string, string> = {
      cancel: "cancelled",
      hold: "on_hold",
      resume: "active",
      refill: "active",
    };

    // Update prescription status
    const result = await db.query(
      `UPDATE prescriptions
       SET status = $1, updated_at = NOW(), updated_by = $2
       WHERE id = $3
       RETURNING id, status, medication_name`,
      [statusMap[action], user.userId, prescriptionId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: "Prescription not found" },
        { status: 404 }
      );
    }

    // Handle refill decrement
    if (action === "refill") {
      await db.query(
        `UPDATE prescriptions
         SET refills_remaining = refills_remaining - 1,
             last_filled_at = NOW()
         WHERE id = $1 AND refills_remaining > 0`,
        [prescriptionId]
      );
    }

    // Audit log
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
       VALUES ($1, 'prescription', $2, $3, $4, NOW())`,
      [
        `prescription_${action}`,
        prescriptionId,
        user.userId,
        JSON.stringify({ action, reason: reason || "No reason provided" }),
      ]
    );

    return NextResponse.json({ prescription: result.rows[0] });
  } catch (error) {
    console.error("[PRESCRIPTIONS] Update failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
