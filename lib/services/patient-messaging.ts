import crypto from "crypto";
import { db } from "@/lib/db";
import nodemailer from "nodemailer";

// Encryption key for message storage — loaded from env with local fallback
const MESSAGE_ENCRYPTION_KEY =
  process.env.MESSAGE_ENCRYPTION_KEY ||
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const ENCRYPTION_IV = Buffer.from("fedcba9876543210", "hex");
const ALGORITHM = "aes-128-cbc";

// Retention policy: auto-delete after 7 years (HIPAA minimum)
const RETENTION_DAYS = 7 * 365;

interface PatientMessage {
  id: string;
  patientId: string;
  senderId: string;
  senderType: "provider" | "system" | "staff";
  subject: string;
  body: string;
  channel: "secure_message" | "email" | "sms";
  status: "draft" | "sent" | "delivered" | "read";
  sentAt?: Date;
  readAt?: Date;
}

interface MessageRecipient {
  patientId: string;
  email?: string;
  phone?: string;
  preferredChannel: string;
  consentGiven: boolean;
  consentDate?: Date;
}

const emailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

class PatientMessagingService {
  /**
   * Encrypt message content for storage.
   */
  private encrypt(text: string): string {
    const key = Buffer.from(MESSAGE_ENCRYPTION_KEY.substring(0, 16), "utf-8");
    const cipher = crypto.createCipheriv(ALGORITHM, key, ENCRYPTION_IV);
    let encrypted = cipher.update(text, "utf-8", "hex");
    encrypted += cipher.final("hex");
    return encrypted;
  }

  /**
   * Decrypt stored message content.
   */
  private decrypt(ciphertext: string): string {
    const key = Buffer.from(MESSAGE_ENCRYPTION_KEY.substring(0, 16), "utf-8");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, ENCRYPTION_IV);
    let decrypted = decipher.update(ciphertext, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }

  /**
   * Look up recipient details and consent status.
   */
  private async getRecipient(patientId: string): Promise<MessageRecipient | null> {
    const result = await db.query(
      `SELECT p.id as patient_id, p.email, p.phone,
              cp.preferred_channel, cp.messaging_consent, cp.consent_date
       FROM patients p
       LEFT JOIN communication_preferences cp ON p.id = cp.patient_id
       WHERE p.id = $1`,
      [patientId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      patientId: row.patient_id,
      email: row.email,
      phone: row.phone,
      preferredChannel: row.preferred_channel || "secure_message",
      consentGiven: row.messaging_consent || false,
      consentDate: row.consent_date,
    };
  }

  /**
   * Send a message to a patient through their preferred channel.
   */
  async sendMessage(
    senderId: string,
    patientId: string,
    subject: string,
    body: string,
    channel?: string
  ): Promise<PatientMessage> {
    const recipient = await this.getRecipient(patientId);
    if (!recipient) {
      throw new Error("Patient not found");
    }

    const effectiveChannel = channel || recipient.preferredChannel;

    // Encrypt the message body for storage
    const encryptedBody = this.encrypt(body);
    const encryptedSubject = this.encrypt(subject);

    // Store the message
    const result = await db.query(
      `INSERT INTO patient_messages
       (patient_id, sender_id, sender_type, subject_encrypted, body_encrypted,
        channel, status, created_at)
       VALUES ($1, $2, 'provider', $3, $4, $5, 'sent', NOW())
       RETURNING id, created_at`,
      [patientId, senderId, encryptedSubject, encryptedBody, effectiveChannel]
    );

    const messageId = result.rows[0].id;

    // Deliver via the appropriate channel
    if (effectiveChannel === "email" && recipient.email) {
      await this.sendEmailNotification(recipient, subject, body);
    } else if (effectiveChannel === "sms" && recipient.phone) {
      await this.sendSmsNotification(recipient, subject);
    }

    // Log the message event
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
       VALUES ('message_sent', 'patient_message', $1, $2, $3, NOW())`,
      [
        messageId,
        senderId,
        JSON.stringify({
          patientId,
          channel: effectiveChannel,
          subjectLength: subject.length,
          bodyLength: body.length,
        }),
      ]
    );

    return {
      id: messageId,
      patientId,
      senderId,
      senderType: "provider",
      subject,
      body,
      channel: effectiveChannel as PatientMessage["channel"],
      status: "sent",
      sentAt: result.rows[0].created_at,
    };
  }

  /**
   * Send an email notification to the patient.
   * Uses TLS connection to SMTP server.
   */
  private async sendEmailNotification(
    recipient: MessageRecipient,
    subject: string,
    body: string
  ): Promise<void> {
    // Include a preview of the message subject in the email
    const emailSubject = `Health Update: ${subject}`;

    await emailTransport.sendMail({
      from: process.env.FROM_EMAIL || "noreply@healthportal.com",
      to: recipient.email!,
      subject: emailSubject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>You have a new message from your healthcare provider</h2>
          <p>Please log in to your patient portal to view the full message.</p>
          <p><strong>Regarding:</strong> ${subject}</p>
          <a href="${process.env.PORTAL_URL}/messages" style="
            display: inline-block; padding: 12px 24px;
            background-color: #0066cc; color: white;
            text-decoration: none; border-radius: 4px;
          ">View Message</a>
          <hr>
          <p style="color: #666; font-size: 12px;">
            This is an automated message. Do not reply to this email.
            If you wish to unsubscribe, update your communication preferences in the portal.
          </p>
        </div>
      `,
    });
  }

  /**
   * Send an SMS notification to the patient.
   */
  private async sendSmsNotification(
    recipient: MessageRecipient,
    subject: string
  ): Promise<void> {
    // Use a third-party SMS service
    const smsPayload = {
      to: recipient.phone,
      body: `New message from your healthcare provider regarding: ${subject}. Log in to your patient portal to view.`,
    };

    await fetch(process.env.SMS_API_URL || "https://api.smsservice.com/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SMS_API_KEY}`,
      },
      body: JSON.stringify(smsPayload),
    });
  }

  /**
   * Get messages for a patient.
   */
  async getPatientMessages(
    patientId: string,
    requesterId: string,
    limit: number = 50
  ): Promise<PatientMessage[]> {
    const result = await db.query(
      `SELECT id, patient_id, sender_id, sender_type, subject_encrypted,
              body_encrypted, channel, status, created_at, read_at
       FROM patient_messages
       WHERE patient_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [patientId, limit]
    );

    // Log access
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
       VALUES ('messages_viewed', 'patient_message', $1, $2, $3, NOW())`,
      [
        patientId,
        requesterId,
        JSON.stringify({ patientId, resultCount: result.rows.length }),
      ]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      patientId: row.patient_id,
      senderId: row.sender_id,
      senderType: row.sender_type,
      subject: this.decrypt(row.subject_encrypted),
      body: this.decrypt(row.body_encrypted),
      channel: row.channel,
      status: row.status,
      sentAt: row.created_at,
      readAt: row.read_at,
    }));
  }

  /**
   * Run retention policy: delete messages older than 7 years.
   * Should be called by a scheduled job.
   */
  async enforceRetentionPolicy(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    const result = await db.query(
      `DELETE FROM patient_messages
       WHERE created_at < $1
       RETURNING id`,
      [cutoffDate.toISOString()]
    );

    const deletedCount = result.rows.length;

    if (deletedCount > 0) {
      console.log(
        `[RETENTION] Deleted ${deletedCount} messages older than ${RETENTION_DAYS} days`
      );

      await db.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details, created_at)
         VALUES ('retention_purge', 'patient_message', 'system', 'system', $1, NOW())`,
        [JSON.stringify({ deletedCount, cutoffDate: cutoffDate.toISOString() })],
      );
    }

    return deletedCount;
  }

  /**
   * Mark a message as read.
   */
  async markAsRead(messageId: string, userId: string): Promise<void> {
    await db.query(
      `UPDATE patient_messages SET read_at = NOW(), status = 'read'
       WHERE id = $1 AND patient_id = $2`,
      [messageId, userId]
    );
  }
}

export const messagingService = new PatientMessagingService();
