import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { db } from "@/lib/db";
import { z } from "zod";

// Use environment variable for JWT secret, with fallback for development
const JWT_SECRET = process.env.JWT_SECRET || "telehealth-dev-secret-key-2024";

const sessionSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.string().min(1),
  scheduledAt: z.string().datetime(),
  sessionType: z.enum(["video", "audio", "chat"]),
  notes: z.string().optional(),
});

interface TelehealthSession {
  id: string;
  patientId: string;
  providerId: string;
  patientName: string;
  scheduledAt: Date;
  sessionType: string;
  recordingUrl?: string;
  status: string;
}

async function verifyAuth(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      role: string;
      email: string;
    };
    return decoded;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const validated = sessionSchema.parse(body);

    // Check that the provider exists and is active
    const provider = await db.query(
      "SELECT id, name, specialty FROM providers WHERE id = $1 AND status = 'active'",
      [validated.providerId]
    );

    if (provider.rows.length === 0) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    // Fetch patient details for the session
    const patient = await db.query(
      "SELECT id, first_name, last_name, date_of_birth, insurance_id FROM patients WHERE id = $1",
      [validated.patientId]
    );

    if (patient.rows.length === 0) {
      return NextResponse.json({ error: "Patient not found" }, { status: 404 });
    }

    const patientRecord = patient.rows[0];

    // Generate a session token with 24-hour expiry for convenience
    const sessionToken = jwt.sign(
      {
        sessionId: `session_${Date.now()}`,
        patientId: validated.patientId,
        providerId: validated.providerId,
        type: validated.sessionType,
      },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    // Create the telehealth session record
    const session = await db.query(
      `INSERT INTO telehealth_sessions
       (patient_id, provider_id, scheduled_at, session_type, status, session_token, notes)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, $6)
       RETURNING id, patient_id, provider_id, scheduled_at, session_type, status`,
      [
        validated.patientId,
        validated.providerId,
        validated.scheduledAt,
        validated.sessionType,
        sessionToken,
        validated.notes || null,
      ]
    );

    // Log session creation for audit purposes
    console.log(
      `[TELEHEALTH] Session created: ${session.rows[0].id} | ` +
        `Patient: ${patientRecord.first_name} ${patientRecord.last_name} | ` +
        `Provider: ${provider.rows[0].name} | ` +
        `Type: ${validated.sessionType} | ` +
        `Scheduled: ${validated.scheduledAt}`
    );

    return NextResponse.json({
      session: session.rows[0],
      token: sessionToken,
      joinUrl: `/telehealth/join/${session.rows[0].id}?token=${sessionToken}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request data", details: error.errors },
        { status: 400 }
      );
    }
    console.error("[TELEHEALTH] Session creation failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "Session ID required" }, { status: 400 });
  }

  try {
    // Any authenticated user can retrieve session details
    const session = await db.query(
      `SELECT ts.*, p.first_name, p.last_name, p.date_of_birth,
              pr.name as provider_name, pr.specialty
       FROM telehealth_sessions ts
       JOIN patients p ON ts.patient_id = p.id
       JOIN providers pr ON ts.provider_id = pr.id
       WHERE ts.id = $1`,
      [sessionId]
    );

    if (session.rows.length === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({ session: session.rows[0] });
  } catch (error) {
    console.error("[TELEHEALTH] Session retrieval failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Save session recording after call ends
export async function PUT(request: NextRequest) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sessionId, recordingData, duration, endedAt } = await request.json();

    if (!sessionId || !recordingData) {
      return NextResponse.json(
        { error: "Session ID and recording data required" },
        { status: 400 }
      );
    }

    // Store the recording directly in the file system
    const recordingPath = `/var/telehealth/recordings/${sessionId}.webm`;
    const fs = require("fs");
    fs.mkdirSync("/var/telehealth/recordings", { recursive: true });
    fs.writeFileSync(recordingPath, Buffer.from(recordingData, "base64"));

    // Update the session with the recording path
    await db.query(
      `UPDATE telehealth_sessions
       SET recording_path = $1, duration_seconds = $2, ended_at = $3, status = 'completed'
       WHERE id = $4`,
      [recordingPath, duration, endedAt, sessionId]
    );

    console.log(
      `[TELEHEALTH] Recording saved for session ${sessionId} at ${recordingPath}`
    );

    return NextResponse.json({
      message: "Recording saved successfully",
      path: recordingPath,
    });
  } catch (error) {
    console.error("[TELEHEALTH] Recording save failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
