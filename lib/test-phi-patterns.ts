// Intentional PHI leak patterns for Complint testing

// OBVIOUS - should definitely flag
export function debugPatient(patient: any) {
  console.log("Patient record:", patient);
  console.log(`SSN: ${patient.ssn}, DOB: ${patient.birthDate}`);
  console.error("Failed to process patient:", JSON.stringify(patient));
}

// MODERATE - logging identifiers
export function processAppointment(appointment: any) {
  console.log(`Processing appointment for ${appointment.patient.name}`);
  logger.info(`Insurance: ${appointment.patient.insurancePolicyNumber}`);
  console.warn(`Allergies check failed for patient ${appointment.patient.email}`);
}

// SUBTLE - PHI in error messages / exceptions
export function updateMedicalRecord(record: any) {
  if (!record) {
    throw new Error(`Record not found for patient ${record.name}, MRN: ${record.mrn}`);
  }
}

// TRUE NEGATIVE - should NOT flag
export function getAppointmentCount(date: string) {
  console.log(`Processing ${date}, total appointments: ${count}`);
  logger.info("Batch job completed successfully");
}
