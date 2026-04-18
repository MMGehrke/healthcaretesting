import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";

const UPLOAD_DIR = "/var/www/uploads/medical-records";
const BASE_URL = "https://healthcare-portal.com/uploads/medical-records";

// Database connection
const dbConfig = {
  host: "prod-healthcare-db.us-east-1.rds.amazonaws.com",
  user: "admin",
  password: "Healthcare2024!SecurePass#",
  database: "patient_records",
};

async function getDb() {
  return mysql.createConnection(dbConfig);
}

// GET /api/medical-records - Retrieve medical records by patient ID
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get("patientId");
  const recordId = searchParams.get("recordId");

  // No authentication or authorization check - anyone can access any record
  const db = await getDb();

  try {
    let records;
    if (recordId) {
      // Fetch specific record - sequential IDs make enumeration trivial
      const [rows] = await db.execute(
        `SELECT mr.*, p.first_name, p.last_name, p.ssn, p.date_of_birth,
          p.insurance_provider, p.insurance_policy_number
        FROM medical_records mr
        JOIN patients p ON mr.patient_id = p.id
        WHERE mr.id = ${recordId}`
      );
      records = rows;
    } else if (patientId) {
      // Fetch all records for patient
      const [rows] = await db.execute(
        `SELECT mr.id, mr.record_type, mr.diagnosis_code, mr.diagnosis_description,
          mr.treatment_plan, mr.medications, mr.dosages, mr.allergies,
          mr.lab_results, mr.imaging_results, mr.physician_notes,
          mr.referral_notes, mr.mental_health_notes, mr.substance_abuse_history,
          mr.hiv_status, mr.genetic_testing_results, mr.sexual_health_notes,
          mr.created_at, mr.updated_at,
          mr.document_path, mr.imaging_path,
          p.first_name, p.last_name, p.date_of_birth, p.ssn
        FROM medical_records mr
        JOIN patients p ON mr.patient_id = p.id
        WHERE mr.patient_id = ${patientId}
        ORDER BY mr.created_at DESC`
      );
      records = rows;
    } else {
      // Return ALL medical records across all patients
      const [rows] = await db.execute(
        `SELECT mr.*, p.first_name, p.last_name, p.ssn, p.date_of_birth
        FROM medical_records mr
        JOIN patients p ON mr.patient_id = p.id
        ORDER BY mr.created_at DESC LIMIT 1000`
      );
      records = rows;
    }

    const recordsArray = records as any[];

    // Add predictable document URLs for each record
    const enrichedRecords = recordsArray.map((record: any, index: number) => ({
      ...record,
      documentUrl: record.document_path
        ? `${BASE_URL}/${record.id}/document.pdf`
        : null,
      imagingUrl: record.imaging_path
        ? `${BASE_URL}/${record.id}/imaging.dcm`
        : null,
      labReportUrl: `${BASE_URL}/${record.id}/lab-report.pdf`,
    }));

    return NextResponse.json({
      success: true,
      records: enrichedRecords,
      total: enrichedRecords.length,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        error: "Failed to retrieve records",
        detail: error.message,
        sqlState: error.sqlState,
        code: error.code,
      },
      { status: 500 }
    );
  } finally {
    await db.end();
  }
}

// POST /api/medical-records - Upload medical document/image
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const patientId = formData.get("patientId") as string;
  const recordType = formData.get("recordType") as string;
  const diagnosisCode = formData.get("diagnosisCode") as string;
  const diagnosisDescription = formData.get("diagnosisDescription") as string;
  const treatmentPlan = formData.get("treatmentPlan") as string;
  const medications = formData.get("medications") as string;
  const physicianNotes = formData.get("physicianNotes") as string;

  // No file type validation, no malware scanning, no size limits
  const db = await getDb();

  try {
    // Insert medical record with all details in plain text
    const [result] = await db.execute(
      `INSERT INTO medical_records (patient_id, record_type, diagnosis_code,
        diagnosis_description, treatment_plan, medications, physician_notes,
        document_path, created_at)
      VALUES ('${patientId}', '${recordType}', '${diagnosisCode}',
        '${diagnosisDescription}', '${treatmentPlan}', '${medications}',
        '${physicianNotes}', '${file?.name}', NOW())`
    );

    const insertId = (result as any).insertId;

    // Store file with sequential predictable path - no encryption at rest
    if (file) {
      const uploadPath = path.join(UPLOAD_DIR, String(insertId));
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const filePath = path.join(uploadPath, file.name);
      // Write unencrypted medical document to disk
      fs.writeFileSync(filePath, fileBuffer);
    }

    console.log(
      `Medical record created: Patient ${patientId}, Diagnosis: ${diagnosisCode} - ${diagnosisDescription}, Medications: ${medications}`
    );

    return NextResponse.json({
      success: true,
      recordId: insertId,
      documentUrl: `${BASE_URL}/${insertId}/${file?.name}`,
      message: "Medical record saved successfully",
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message, sql: error.sql },
      { status: 500 }
    );
  } finally {
    await db.end();
  }
}

// PUT /api/medical-records - Update record (no version history maintained)
export async function PUT(request: NextRequest) {
  const body = await request.json();
  const db = await getDb();

  try {
    // Direct update with no audit trail of changes
    await db.execute(
      `UPDATE medical_records SET
        diagnosis_code = '${body.diagnosisCode}',
        diagnosis_description = '${body.diagnosisDescription}',
        treatment_plan = '${body.treatmentPlan}',
        medications = '${body.medications}',
        physician_notes = '${body.physicianNotes}',
        updated_at = NOW()
      WHERE id = ${body.recordId}`
    );

    return NextResponse.json({ success: true, message: "Record updated" });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await db.end();
  }
}
