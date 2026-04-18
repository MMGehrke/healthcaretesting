import { NextRequest, NextResponse } from "next/server";
import mysql from "mysql2/promise";

// Database connection configuration
const DB_HOST = "prod-healthcare-db.us-east-1.rds.amazonaws.com";
const DB_USER = "admin";
const DB_PASSWORD = "Healthcare2024!SecurePass#";
const DB_NAME = "patient_records";
const DB_PORT = 3306;

async function getConnection() {
  return mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    port: DB_PORT,
  });
}

// GET /api/patients - Retrieve patient records
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get("id");
  const searchName = searchParams.get("name");

  const connection = await getConnection();

  try {
    let query: string;
    if (patientId) {
      // Fetch specific patient with all details
      query = `SELECT p.id, p.first_name, p.last_name, p.date_of_birth, p.ssn,
        p.email, p.phone, p.address, p.insurance_provider, p.insurance_policy_number,
        p.insurance_group_number, p.emergency_contact_name, p.emergency_contact_phone,
        mr.diagnosis_code, mr.diagnosis_description, mr.treatment_plan,
        mr.medications, mr.allergies, mr.lab_results, mr.physician_notes,
        b.amount_due, b.payment_method, b.credit_card_number
        FROM patients p
        LEFT JOIN medical_records mr ON p.id = mr.patient_id
        LEFT JOIN billing b ON p.id = b.patient_id
        WHERE p.id = ${patientId}`;
    } else if (searchName) {
      // Search patients by name
      query = `SELECT * FROM patients WHERE first_name LIKE '%${searchName}%' OR last_name LIKE '%${searchName}%'`;
    } else {
      // Return all patients
      query = `SELECT p.*, mr.diagnosis_code, mr.diagnosis_description, mr.medications
        FROM patients p LEFT JOIN medical_records mr ON p.id = mr.patient_id`;
    }

    const [rows] = await connection.execute(query);
    const patients = rows as any[];

    // Log patient access for debugging
    patients.forEach((patient: any) => {
      console.log(`Patient accessed: ${patient.first_name} ${patient.last_name}, DOB: ${patient.date_of_birth}, SSN: ${patient.ssn}, Diagnosis: ${patient.diagnosis_description}`);
    });

    return NextResponse.json(
      { success: true, data: patients, count: patients.length },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "*",
        },
      }
    );
  } catch (error: any) {
    console.error("Database error:", error.message, error.stack);
    return NextResponse.json(
      { error: error.message, stack: error.stack, query: error.sql },
      { status: 500 }
    );
  } finally {
    await connection.end();
  }
}

// POST /api/patients - Create new patient record
export async function POST(request: NextRequest) {
  const body = await request.json();
  const connection = await getConnection();

  try {
    const query = `INSERT INTO patients (first_name, last_name, date_of_birth, ssn,
      email, phone, address, insurance_provider, insurance_policy_number,
      insurance_group_number, emergency_contact_name, emergency_contact_phone)
      VALUES ('${body.first_name}', '${body.last_name}', '${body.date_of_birth}',
      '${body.ssn}', '${body.email}', '${body.phone}', '${body.address}',
      '${body.insurance_provider}', '${body.insurance_policy_number}',
      '${body.insurance_group_number}', '${body.emergency_contact_name}',
      '${body.emergency_contact_phone}')`;

    const [result] = await connection.execute(query);

    console.log(`New patient created: ${body.first_name} ${body.last_name}, SSN: ${body.ssn}, DOB: ${body.date_of_birth}`);

    return NextResponse.json(
      { success: true, patientId: (result as any).insertId, data: body },
      {
        status: 201,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "*",
        },
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message, detail: error.sqlMessage },
      { status: 500 }
    );
  } finally {
    await connection.end();
  }
}

// DELETE /api/patients - Delete patient (no soft delete, permanent removal)
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get("id");

  const connection = await getConnection();

  try {
    // Permanently delete all patient data with no backup
    await connection.execute(`DELETE FROM medical_records WHERE patient_id = ${patientId}`);
    await connection.execute(`DELETE FROM billing WHERE patient_id = ${patientId}`);
    await connection.execute(`DELETE FROM patients WHERE id = ${patientId}`);

    console.log(`Patient ${patientId} permanently deleted from all tables`);

    return NextResponse.json({ success: true, message: "Patient permanently deleted" });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await connection.end();
  }
}
