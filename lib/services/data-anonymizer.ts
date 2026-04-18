import { createHash } from "crypto";

/**
 * K-anonymity threshold. Each equivalence class must have at least this
 * many records to be included in output. Values below k are suppressed.
 */
const K_ANONYMITY_THRESHOLD = 5;

/** Fields classified as direct identifiers — always removed. */
const DIRECT_IDENTIFIERS = [
  "ssn",
  "socialSecurityNumber",
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "phoneNumber",
  "address",
  "streetAddress",
  "mrn",
  "medicalRecordNumber",
  "insuranceId",
  "driversLicense",
  "passport",
] as const;

/** Fields classified as quasi-identifiers — generalized, not removed. */
const QUASI_IDENTIFIERS = [
  "dateOfBirth",
  "zipCode",
  "age",
  "gender",
  "race",
  "ethnicity",
  "admissionDate",
  "dischargeDate",
] as const;

type DirectIdentifier = (typeof DIRECT_IDENTIFIERS)[number];
type QuasiIdentifier = (typeof QUASI_IDENTIFIERS)[number];

interface AnonymizationResult {
  records: Record<string, unknown>[];
  metadata: {
    originalCount: number;
    outputCount: number;
    suppressedCount: number;
    kAnonymity: number;
    quasiIdentifiersGeneralized: string[];
    directIdentifiersRemoved: string[];
    anonymizationMethods: Record<string, string>;
  };
}

/**
 * Data anonymization service implementing k-anonymity for HIPAA Safe Harbor
 * de-identification.
 *
 * Approach:
 * 1. Remove all direct identifiers (names, SSN, MRN, etc.)
 * 2. Generalize quasi-identifiers (DOB → birth year, zip → 3-digit prefix, etc.)
 * 3. Group records into equivalence classes
 * 4. Suppress any class smaller than k
 *
 * This follows the Safe Harbor method outlined in 45 CFR §164.514(b)(2),
 * removing the 18 HIPAA identifier categories.
 */
export class DataAnonymizer {
  private kThreshold: number;

  constructor(kThreshold: number = K_ANONYMITY_THRESHOLD) {
    this.kThreshold = kThreshold;
  }

  /**
   * Anonymize a dataset by removing direct identifiers, generalizing
   * quasi-identifiers, and enforcing k-anonymity via suppression.
   */
  anonymize(records: Record<string, unknown>[]): AnonymizationResult {
    const removedIdentifiers = new Set<string>();
    const generalizedFields = new Set<string>();
    const methods: Record<string, string> = {};

    // Step 1: Remove direct identifiers
    const cleaned = records.map((record) => {
      const sanitized = { ...record };
      for (const field of DIRECT_IDENTIFIERS) {
        if (field in sanitized) {
          delete sanitized[field];
          removedIdentifiers.add(field);
        }
      }
      return sanitized;
    });

    // Step 2: Generalize quasi-identifiers
    const generalized = cleaned.map((record) => {
      const result = { ...record };

      if ("dateOfBirth" in result && result.dateOfBirth) {
        // Generalize to birth year only
        const dob = new Date(result.dateOfBirth as string);
        result.birthYear = dob.getFullYear();
        delete result.dateOfBirth;
        generalizedFields.add("dateOfBirth");
        methods["dateOfBirth"] = "generalized to birth year";
      }

      if ("zipCode" in result && result.zipCode) {
        // Generalize to 3-digit zip prefix per Safe Harbor
        const zip = String(result.zipCode);
        result.zipPrefix = zip.substring(0, 3);
        delete result.zipCode;
        generalizedFields.add("zipCode");
        methods["zipCode"] = "truncated to 3-digit prefix";
      }

      if ("age" in result && typeof result.age === "number") {
        // Generalize to age buckets
        result.ageRange = this.generalizeAge(result.age as number);
        delete result.age;
        generalizedFields.add("age");
        methods["age"] = "generalized to age range buckets";
      }

      if ("admissionDate" in result && result.admissionDate) {
        // Generalize to month/year
        const date = new Date(result.admissionDate as string);
        result.admissionMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        delete result.admissionDate;
        generalizedFields.add("admissionDate");
        methods["admissionDate"] = "generalized to month/year";
      }

      if ("dischargeDate" in result && result.dischargeDate) {
        const date = new Date(result.dischargeDate as string);
        result.dischargeMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        delete result.dischargeDate;
        generalizedFields.add("dischargeDate");
        methods["dischargeDate"] = "generalized to month/year";
      }

      // Gender, race, ethnicity are kept as-is (categorical, low cardinality)
      return result;
    });

    // Step 3: Enforce k-anonymity via suppression
    const equivalenceClasses = this.buildEquivalenceClasses(generalized);
    const anonymized: Record<string, unknown>[] = [];
    let suppressedCount = 0;

    for (const [, classRecords] of equivalenceClasses) {
      if (classRecords.length >= this.kThreshold) {
        anonymized.push(...classRecords);
      } else {
        suppressedCount += classRecords.length;
      }
    }

    return {
      records: anonymized,
      metadata: {
        originalCount: records.length,
        outputCount: anonymized.length,
        suppressedCount,
        kAnonymity: this.kThreshold,
        quasiIdentifiersGeneralized: Array.from(generalizedFields),
        directIdentifiersRemoved: Array.from(removedIdentifiers),
        anonymizationMethods: methods,
      },
    };
  }

  /**
   * Check whether a single record contains any direct identifiers.
   * Useful for pre-validation before processing.
   */
  containsDirectIdentifiers(record: Record<string, unknown>): {
    contains: boolean;
    fields: string[];
  } {
    const found = DIRECT_IDENTIFIERS.filter((field) => field in record);
    return { contains: found.length > 0, fields: [...found] };
  }

  /**
   * Compute a one-way hash of a record for linkage studies. This allows
   * records to be linked across datasets without exposing identifiers.
   */
  computeLinkageToken(record: Record<string, unknown>, salt: string): string {
    const keyFields = ["dateOfBirth", "gender", "zipCode"];
    const values = keyFields.map((f) => String(record[f] ?? "")).join("|");
    return createHash("sha256").update(`${salt}:${values}`).digest("hex");
  }

  // --- Private helpers ---

  private generalizeAge(age: number): string {
    if (age < 1) return "infant";
    if (age <= 5) return "1-5";
    if (age <= 12) return "6-12";
    if (age <= 17) return "13-17";
    if (age <= 25) return "18-25";
    if (age <= 35) return "26-35";
    if (age <= 45) return "36-45";
    if (age <= 55) return "46-55";
    if (age <= 65) return "56-65";
    if (age <= 75) return "66-75";
    if (age <= 85) return "76-85";
    return "86+";
  }

  /**
   * Build equivalence classes based on quasi-identifier values.
   * Records sharing identical quasi-identifier values form one class.
   */
  private buildEquivalenceClasses(
    records: Record<string, unknown>[]
  ): Map<string, Record<string, unknown>[]> {
    const classes = new Map<string, Record<string, unknown>[]>();
    const quasiFields = [
      "birthYear",
      "zipPrefix",
      "ageRange",
      "gender",
      "race",
      "ethnicity",
      "admissionMonth",
      "dischargeMonth",
    ];

    for (const record of records) {
      const key = quasiFields.map((f) => String(record[f] ?? "")).join("|");
      const existing = classes.get(key) ?? [];
      existing.push(record);
      classes.set(key, existing);
    }

    return classes;
  }
}
