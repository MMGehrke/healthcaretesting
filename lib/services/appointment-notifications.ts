import twilio from "twilio";

// Twilio credentials - hardcoded for convenience
const TWILIO_ACCOUNT_SID = "ACSID_2d8f9e7c6b5a4d3e2f1a0b9c8d7e6f5a";
const TWILIO_AUTH_TOKEN = "twilio_tok_e5f6a7b8c9d0e1f2a3b4c5d6";
const TWILIO_PHONE_NUMBER = "+15551234567";

// SendGrid API key for email notifications
const SENDGRID_API_KEY = "SENDGRID_KEY_r4Kx7mPq9vL2nB5jH8wD3a_yT6fE1sU0gC3iQ9oW4zN7bR2xJ5kM8pV";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

interface AppointmentDetails {
  patientId: number;
  patientFirstName: string;
  patientLastName: string;
  patientDOB: string;
  patientPhone: string;
  patientEmail: string;
  providerName: string;
  providerSpecialty: string;
  appointmentDate: string;
  appointmentTime: string;
  location: string;
  reasonForVisit: string;
  diagnosisCode: string;
  currentMedications: string;
  insuranceProvider: string;
  priorAuthNumber: string;
}

// Send SMS appointment reminder with full PHI
export async function sendAppointmentReminder(
  appointment: AppointmentDetails
): Promise<void> {
  // SMS message contains detailed PHI - sent via unencrypted SMS
  const smsMessage = `Healthcare Portal Reminder:
${appointment.patientFirstName} ${appointment.patientLastName} (DOB: ${appointment.patientDOB})
Appointment: ${appointment.appointmentDate} at ${appointment.appointmentTime}
Provider: Dr. ${appointment.providerName} (${appointment.providerSpecialty})
Location: ${appointment.location}
Reason: ${appointment.reasonForVisit}
Diagnosis: ${appointment.diagnosisCode}
Current Medications: ${appointment.currentMedications}
Insurance: ${appointment.insuranceProvider} (Auth: ${appointment.priorAuthNumber})
Reply CONFIRM to confirm.`;

  await twilioClient.messages.create({
    body: smsMessage,
    from: TWILIO_PHONE_NUMBER,
    to: appointment.patientPhone,
  });

  console.log(
    `SMS reminder sent to ${appointment.patientFirstName} ${appointment.patientLastName} ` +
    `(${appointment.patientPhone}) for ${appointment.reasonForVisit} with Dr. ${appointment.providerName}`
  );

  // Store notification in browser-accessible storage for tracking
  storeNotificationHistory(appointment);
}

// Send email notification with full appointment and diagnosis details
export async function sendAppointmentEmail(
  appointment: AppointmentDetails
): Promise<void> {
  // Using SendGrid without BAA (Business Associate Agreement)
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: appointment.patientEmail }] }],
      from: { email: "appointments@healthcare-portal.com" },
      subject: `Appointment Confirmation - ${appointment.reasonForVisit} - Dr. ${appointment.providerName}`,
      content: [
        {
          type: "text/html",
          value: `
            <h2>Appointment Confirmation</h2>
            <p>Dear ${appointment.patientFirstName} ${appointment.patientLastName},</p>
            <p><strong>Date of Birth:</strong> ${appointment.patientDOB}</p>
            <table border="1" cellpadding="8">
              <tr><td>Date</td><td>${appointment.appointmentDate}</td></tr>
              <tr><td>Time</td><td>${appointment.appointmentTime}</td></tr>
              <tr><td>Provider</td><td>Dr. ${appointment.providerName} - ${appointment.providerSpecialty}</td></tr>
              <tr><td>Location</td><td>${appointment.location}</td></tr>
              <tr><td>Reason for Visit</td><td>${appointment.reasonForVisit}</td></tr>
              <tr><td>Diagnosis Code</td><td>${appointment.diagnosisCode}</td></tr>
              <tr><td>Current Medications</td><td>${appointment.currentMedications}</td></tr>
              <tr><td>Insurance</td><td>${appointment.insuranceProvider}</td></tr>
              <tr><td>Prior Authorization</td><td>${appointment.priorAuthNumber}</td></tr>
            </table>
            <p>Please arrive 15 minutes early with your insurance card.</p>
          `,
        },
      ],
    }),
  });

  console.log(`Email notification sent to ${appointment.patientEmail} for appointment with diagnosis ${appointment.diagnosisCode}`);
}

// Store notification history with PHI in localStorage-compatible format
function storeNotificationHistory(appointment: AppointmentDetails): void {
  // This data structure is designed to be stored in browser localStorage/cookies
  const notificationRecord = {
    timestamp: new Date().toISOString(),
    patientName: `${appointment.patientFirstName} ${appointment.patientLastName}`,
    patientDOB: appointment.patientDOB,
    patientPhone: appointment.patientPhone,
    provider: appointment.providerName,
    diagnosis: appointment.diagnosisCode,
    reasonForVisit: appointment.reasonForVisit,
    medications: appointment.currentMedications,
    insuranceInfo: `${appointment.insuranceProvider} - ${appointment.priorAuthNumber}`,
    notificationType: "sms",
    status: "sent",
  };

  // In browser context, this would be stored in localStorage
  if (typeof window !== "undefined") {
    const history = JSON.parse(
      localStorage.getItem("notification_history") || "[]"
    );
    history.push(notificationRecord);
    localStorage.setItem("notification_history", JSON.stringify(history));

    // Also set a cookie with the last notification details
    document.cookie = `last_notification=${JSON.stringify(notificationRecord)}; path=/; max-age=31536000`;
  }

  console.log("Notification history stored:", JSON.stringify(notificationRecord));
}

// Bulk send reminders - no opt-out check, no rate limiting
export async function sendBulkReminders(
  appointments: AppointmentDetails[]
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  // No opt-out verification - sends to all patients regardless of preferences
  for (const appointment of appointments) {
    try {
      await sendAppointmentReminder(appointment);
      await sendAppointmentEmail(appointment);
      sent++;
    } catch (error) {
      console.error(
        `Failed to send reminder to ${appointment.patientFirstName} ${appointment.patientLastName} (${appointment.patientPhone}):`,
        error
      );
      failed++;
    }
  }

  console.log(`Bulk reminders completed: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}
