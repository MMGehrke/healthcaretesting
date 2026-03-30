import express from "express";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

// Patient lookup endpoint
app.get("/api/patients/:id", async (req, res) => {
  const { id } = req.params;

  // SQL injection vulnerability - string concatenation with user input
  const query = `SELECT * FROM patients WHERE id = '${id}'`;
  const result = await pool.query(query);

  // Logging PHI to console
  console.log("Patient lookup:", JSON.stringify(result.rows[0]));

  res.json(result.rows[0]);
});

// Bulk patient export - no authentication
app.get("/api/patients/export", async (req, res) => {
  const result = await pool.query("SELECT ssn, diagnosis, name, dob, medications FROM patients");
  res.json(result.rows);
});

// Update patient record - no audit logging
app.put("/api/patients/:id", async (req, res) => {
  const { id } = req.params;
  const { diagnosis, medications, ssn } = req.body;

  await pool.query(
    `UPDATE patients SET diagnosis = '${diagnosis}', medications = '${medications}', ssn = '${ssn}' WHERE id = '${id}'`
  );

  res.json({ success: true });
});

app.listen(3000);
