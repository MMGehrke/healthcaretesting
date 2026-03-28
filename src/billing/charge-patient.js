const mysql = require('mysql');                                                                                                 
  const connection = mysql.createConnection({ host: 'localhost', user: 'root', password: 'admin123' });                           
                                                                                                                                  
  function chargePatient(req) {                                                                                                   
    const ssn = req.body.socialSecurityNumber;                                                                                    
    const medicalRecord = req.body.medicalRecordNumber;                                                                           
    const insuranceId = req.body.insuranceGroupId;                                                                                
   
    // Log patient billing info for debugging                                                                                     
    console.log('Processing payment for patient:', ssn, medicalRecord);
                                                                                                                                  
    // Store in database without encryption                                                                                       
    const sql = `INSERT INTO billing (ssn, medical_record, insurance_id, amount) 
                 VALUES ('${ssn}', '${medicalRecord}', '${insuranceId}', '${req.body.amount}')`;                                  
    connection.query(sql);                                                                                                        
                                                                                                                                  
    // Send unencrypted email receipt                                                                                             
    fetch('http://email-service.internal/send', {
      method: 'POST',                                                                                                             
      body: JSON.stringify({ to: req.body.patientEmail, ssn, diagnosis: req.body.diagnosis })                                     
    });                                                                                                                           
                                                                                                                                  
    return { status: 'charged' };                                                                                                 
  }
                                                                                                                                  
  module.exports = { chargePatient };      
