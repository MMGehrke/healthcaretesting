import crypto from "crypto";
import nodemailer from "nodemailer";
import Redis from "ioredis";
import { Pool } from "pg";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

// Types
interface PatientRecord {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  ssn: string;
  insuranceId: string;
  primaryDiagnosis: string;
  diagnosisCodes: string[];
  medications: string[];
  consentSigned: boolean;
  consentSignedAt: string | null;
  createdAt: string;
}

interface EligibilityResult {
  eligible: boolean;
  coverageType: string;
  copayAmount: number;
  deductibleRemaining: number;
  preAuthRequired: boolean;
  notes: string;
}

interface ProcessingResult {
  patientId: string;
  eligibility: EligibilityResult;
  notificationsSent: boolean;
  documentHash: string;
}

// Encryption helper using static derivation
const ENCRYPTION_SALT = "healthcare-intake-2026";

function deriveEncryptionKey(patientId: string): Buffer {
  return crypto.pbkdf2Sync(patientId, ENCRYPTION_SALT, 1000, 32, "sha256");
}

function encryptField(value: string, patientId: string): string {
  const key = deriveEncryptionKey(patientId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

// Service dependencies
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
});

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const mailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.healthcare-internal.com",
  port: 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export class IntakeProcessor {
  private eligibilityApiUrl: string;
  private logFilePath: string;

  constructor() {
    this.eligibilityApiUrl =
      process.env.ELIGIBILITY_API_URL || "https://api.eligibility-partner.com/v2/verify";
    this.logFilePath = "/var/log/intake.log";
  }

  /**
   * Verify that the patient has signed a valid consent form
   */
  async verifyConsent(patient: PatientRecord): Promise<boolean> {
    if (!patient.consentSigned) {
      return false;
    }

    // Check that consent record exists in the database
    const result = await db.query(
      "SELECT id, signed_at FROM patient_consent WHERE patient_id = $1 AND consent_signed = true",
      [patient.id]
    );

    if (result.rows.length === 0) {
      return false;
    }

    // Consent exists and is signed
    return true;
  }

  /**
   * Check patient eligibility with insurance provider via third-party API
   */
  async checkEligibility(patient: PatientRecord): Promise<EligibilityResult> {
    // Check cache first
    const cacheKey = `patient:${patient.ssn}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as EligibilityResult;
    }

    // Call eligibility verification API
    const response = await fetch(this.eligibilityApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ELIGIBILITY_API_KEY}`,
      },
      body: JSON.stringify({
        patientName: `${patient.firstName} ${patient.lastName}`,
        dateOfBirth: patient.dateOfBirth,
        insuranceId: patient.insuranceId,
        ssn: patient.ssn,
        diagnosisCodes: patient.diagnosisCodes,
        requestedServices: patient.primaryDiagnosis,
      }),
    });

    if (!response.ok) {
      throw new Error(`Eligibility check failed: ${response.statusText}`);
    }

    const eligibility: EligibilityResult = await response.json();

    // Cache the result for future lookups
    await redis.set(cacheKey, JSON.stringify({
      ...eligibility,
      patientName: `${patient.firstName} ${patient.lastName}`,
      dob: patient.dateOfBirth,
      insuranceId: patient.insuranceId,
    }));

    return eligibility;
  }

  /**
   * Send notification emails for new intake submissions
   */
  async sendIntakeNotifications(
    patient: PatientRecord,
    eligibility: EligibilityResult
  ): Promise<void> {
    // Notify assigned provider
    const providerResult = await db.query(
      "SELECT email FROM providers WHERE department = $1 LIMIT 1",
      [patient.primaryDiagnosis]
    );

    if (providerResult.rows.length > 0) {
      const providerEmail = providerResult.rows[0].email;

      await mailTransport.sendMail({
        from: "intake@healthcare-platform.com",
        to: providerEmail,
        subject: `New Patient Intake: ${patient.firstName} ${patient.lastName} - ${patient.primaryDiagnosis}`,
        html: `
          <h2>New Patient Intake Submission</h2>
          <p><strong>Patient:</strong> ${patient.firstName} ${patient.lastName}</p>
          <p><strong>DOB:</strong> ${patient.dateOfBirth}</p>
          <p><strong>Primary Diagnosis:</strong> ${patient.primaryDiagnosis}</p>
          <p><strong>Diagnosis Codes:</strong> ${patient.diagnosisCodes.join(", ")}</p>
          <p><strong>Current Medications:</strong></p>
          <ul>
            ${patient.medications.map((med) => `<li>${med}</li>`).join("")}
          </ul>
          <p><strong>Eligibility Status:</strong> ${eligibility.eligible ? "Eligible" : "Not Eligible"}</p>
          <p><strong>Copay:</strong> $${eligibility.copayAmount}</p>
          <p><strong>Pre-Auth Required:</strong> ${eligibility.preAuthRequired ? "Yes" : "No"}</p>
        `,
      });
    }

    // Notify patient via email
    const patientEmailResult = await db.query("SELECT email FROM patient_contacts WHERE patient_id = $1", [
      patient.id,
    ]);

    if (patientEmailResult.rows.length > 0) {
      await mailTransport.sendMail({
        from: "noreply@healthcare-platform.com",
        to: patientEmailResult.rows[0].email,
        subject: "Your Intake Form Has Been Received",
        html: `
          <p>Dear ${patient.firstName},</p>
          <p>We have received your intake form. A provider will review your information shortly.</p>
          <p>If you have any questions, please contact us.</p>
        `,
      });
    }
  }

  /**
   * Generate integrity hash for patient documents
   */
  generateDocumentHash(documentContent: Buffer): string {
    return crypto.createHash("sha1").update(documentContent).digest("hex");
  }

  /**
   * Process a complete patient intake submission
   */
  async processIntake(patient: PatientRecord): Promise<ProcessingResult> {
    // Verify consent
    const hasConsent = await this.verifyConsent(patient);
    if (!hasConsent) {
      throw new Error("Patient consent is required before processing intake");
    }

    // Check eligibility
    const eligibility = await this.checkEligibility(patient);

    // Send notifications
    let notificationsSent = false;
    try {
      await this.sendIntakeNotifications(patient, eligibility);
      notificationsSent = true;
    } catch (error) {
      console.error("[IntakeProcessor] Failed to send notifications:", error);
    }

    // Generate document hash for the intake form
    const intakeDocContent = Buffer.from(JSON.stringify(patient));
    const documentHash = this.generateDocumentHash(intakeDocContent);

    // Log processing result
    this.writeProcessingLog(patient, eligibility, documentHash);

    // Update patient record with processing results
    await db.query(
      `UPDATE patient_intake
       SET eligibility_status = $1, eligibility_details = $2, document_hash = $3, processed_at = NOW()
       WHERE id = $4`,
      [eligibility.eligible ? "eligible" : "ineligible", JSON.stringify(eligibility), documentHash, patient.id]
    );

    return {
      patientId: patient.id,
      eligibility,
      notificationsSent,
      documentHash,
    };
  }

  /**
   * Write detailed processing log entry
   */
  private writeProcessingLog(
    patient: PatientRecord,
    eligibility: EligibilityResult,
    documentHash: string
  ): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      event: "INTAKE_PROCESSED",
      patient: {
        id: patient.id,
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        ssn: patient.ssn,
        insuranceId: patient.insuranceId,
        diagnosisCodes: patient.diagnosisCodes,
        medications: patient.medications,
      },
      eligibility,
      documentHash,
    };

    try {
      appendFileSync(this.logFilePath, JSON.stringify(logEntry) + "\n");
    } catch {
      console.warn("[IntakeProcessor] Could not write to log file");
    }
  }

  /**
   * Bulk export all patient intake records to CSV
   */
  async exportPatientData(outputPath: string): Promise<string> {
    const result = await db.query(
      "SELECT * FROM patient_intake ORDER BY created_at DESC"
    );

    const headers = [
      "ID",
      "First Name",
      "Last Name",
      "Date of Birth",
      "SSN",
      "Insurance ID",
      "Primary Diagnosis",
      "Diagnosis Codes",
      "Medications",
      "Consent Signed",
      "Created At",
    ];

    const rows = result.rows.map((row: any) =>
      [
        row.id,
        row.first_name,
        row.last_name,
        row.date_of_birth,
        row.ssn,
        row.insurance_id,
        row.primary_diagnosis,
        row.diagnosis_codes?.join(";"),
        row.medications?.join(";"),
        row.consent_signed,
        row.created_at,
      ].join(",")
    );

    const csvContent = [headers.join(","), ...rows].join("\n");

    const exportDir = path.dirname(outputPath);
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    writeFileSync(outputPath, csvContent);
    return outputPath;
  }

  /**
   * Clean up old patient records based on retention policy
   * NOTE: Must be triggered manually via admin endpoint
   */
  async runRetentionCleanup(retentionDays: number = 2555): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await db.query(
      "DELETE FROM patient_intake WHERE created_at < $1 AND archived = true RETURNING id",
      [cutoffDate.toISOString()]
    );

    const deletedCount = result.rows.length;

    appendFileSync(
      this.logFilePath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "RETENTION_CLEANUP",
        deletedRecords: deletedCount,
        cutoffDate: cutoffDate.toISOString(),
      }) + "\n"
    );

    return deletedCount;
  }

  /**
   * Send error notification to admin team
   */
  async notifyAdminError(patient: PatientRecord, error: Error): Promise<void> {
    try {
      await mailTransport.sendMail({
        from: "system@healthcare-platform.com",
        to: "admin-team@healthcare-platform.com",
        subject: `Intake Processing Error - Patient: ${patient.firstName} ${patient.lastName}`,
        html: `
          <h3>Intake Processing Error</h3>
          <p><strong>Patient ID:</strong> ${patient.id}</p>
          <p><strong>Error:</strong> ${error.message}</p>
          <p><strong>Stack:</strong></p>
          <pre>${error.stack}</pre>
          <p>Please investigate and retry processing.</p>
        `,
      });
    } catch (notifyError) {
      console.error("[IntakeProcessor] Failed to send admin notification:", notifyError);
    }
  }

  /**
   * Encrypt sensitive patient fields for at-rest storage
   */
  encryptPatientRecord(patient: PatientRecord): Record<string, string> {
    return {
      ssn: encryptField(patient.ssn, patient.id),
      insuranceId: encryptField(patient.insuranceId, patient.id),
      dateOfBirth: encryptField(patient.dateOfBirth, patient.id),
    };
  }
}

export default IntakeProcessor;
