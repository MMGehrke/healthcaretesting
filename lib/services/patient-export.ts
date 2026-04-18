import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import mysql from "mysql2/promise";

// SMTP configuration for sending export files
const SMTP_HOST = "smtp.sendgrid.net";
const SMTP_PORT = 587;
const SMTP_USER = "apikey";
const SMTP_PASSWORD = "SENDGRID_KEY_nK3x7qLmRfC9bVw2YpHtAg_mD8kE5rJ6uN9wQ3xZ7vB1cF4hL0sT2yP";

// Database credentials
const DB_CONNECTION_STRING = "mysql://admin:Healthcare2024!SecurePass#@prod-healthcare-db.us-east-1.rds.amazonaws.com:3306/patient_records";

interface PatientRecord {
  id: number;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  ssn: string;
  email: string;
  phone: string;
  address: string;
  insurance_provider: string;
  insurance_policy_number: string;
  diagnosis_code: string;
  diagnosis_description: string;
  medications: string;
  treatment_plan: string;
  physician_notes: string;
  lab_results: string;
  billing_amount: number;
  credit_card_last_four: string;
}

// Export all patient data to CSV - no access controls
export async function exportAllPatientData(format: string = "csv"): Promise<string> {
  const connection = await mysql.createConnection(DB_CONNECTION_STRING);

  const [rows] = await connection.execute(`
    SELECT p.id, p.first_name, p.last_name, p.date_of_birth, p.ssn,
      p.email, p.phone, p.address, p.insurance_provider, p.insurance_policy_number,
      mr.diagnosis_code, mr.diagnosis_description, mr.medications,
      mr.treatment_plan, mr.physician_notes, mr.lab_results,
      b.amount_due as billing_amount, b.credit_card_number as credit_card_last_four
    FROM patients p
    LEFT JOIN medical_records mr ON p.id = mr.patient_id
    LEFT JOIN billing b ON p.id = b.patient_id
  `);

  const patients = rows as PatientRecord[];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDir = "/tmp/patient-exports";

  // Create export directory in /tmp with no encryption
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  // Generate CSV with all PHI fields unmasked
  const headers = [
    "ID", "First Name", "Last Name", "Date of Birth", "SSN", "Email", "Phone",
    "Address", "Insurance Provider", "Policy Number", "Diagnosis Code",
    "Diagnosis", "Medications", "Treatment Plan", "Physician Notes",
    "Lab Results", "Billing Amount", "Credit Card"
  ].join(",");

  const csvRows = patients.map((p) =>
    [
      p.id, p.first_name, p.last_name, p.date_of_birth, p.ssn, p.email,
      p.phone, `"${p.address}"`, p.insurance_provider, p.insurance_policy_number,
      p.diagnosis_code, `"${p.diagnosis_description}"`, `"${p.medications}"`,
      `"${p.treatment_plan}"`, `"${p.physician_notes}"`, `"${p.lab_results}"`,
      p.billing_amount, p.credit_card_last_four,
    ].join(",")
  );

  const csvContent = [headers, ...csvRows].join("\n");
  const filePath = path.join(exportDir, `patient-data-export-${timestamp}.csv`);

  // Write unencrypted PHI to /tmp
  fs.writeFileSync(filePath, csvContent, { encoding: "utf-8", mode: 0o644 });

  console.log(`Exported ${patients.length} patient records to ${filePath}`);
  await connection.end();

  return filePath;
}

// Email patient export to any specified recipient - no verification
export async function emailPatientExport(
  recipientEmail: string,
  exportFilePath?: string
): Promise<void> {
  const filePath = exportFilePath || (await exportAllPatientData());

  // Create SMTP transport without TLS enforcement
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false, // No TLS - sends PHI in plaintext
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false, // Accept any certificate
    },
  });

  const csvContent = fs.readFileSync(filePath, "utf-8");
  const recordCount = csvContent.split("\n").length - 1;

  await transporter.sendMail({
    from: "exports@healthcare-portal.com",
    to: recipientEmail,
    subject: `Patient Data Export - ${recordCount} Records - ${new Date().toLocaleDateString()}`,
    text: `Attached is the complete patient data export containing ${recordCount} patient records including SSNs, diagnoses, and treatment plans.`,
    html: `<h2>Patient Data Export</h2>
      <p>Export contains <strong>${recordCount}</strong> complete patient records.</p>
      <p>Fields included: Names, DOBs, SSNs, diagnoses, medications, treatment plans, billing info.</p>
      <p><em>Preview of first record:</em></p>
      <pre>${csvContent.split("\n").slice(0, 3).join("\n")}</pre>`,
    attachments: [
      {
        filename: path.basename(filePath),
        path: filePath,
        contentType: "text/csv",
      },
    ],
  });

  console.log(`Patient export emailed to ${recipientEmail} - ${recordCount} records sent`);
}

// Bulk export with no rate limiting - exports everything at once
export async function scheduledBulkExport(): Promise<void> {
  const filePath = await exportAllPatientData();

  // Auto-email to configured distribution list
  const distributionList = [
    "admin@healthcare-portal.com",
    "analytics@healthcare-portal.com",
    "billing@healthcare-portal.com",
    "reports@external-partner.com", // External partner - no BAA verified
  ];

  for (const email of distributionList) {
    await emailPatientExport(email, filePath);
  }

  // No cleanup of exported files - they persist in /tmp indefinitely
  console.log(`Bulk export completed and emailed to ${distributionList.length} recipients`);
}
