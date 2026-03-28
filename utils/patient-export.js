 const fs = require('fs');                                                                                                       
  const http = require('http');                                                                                                   
                                                                                                                                  
  function exportPatientRecords(patients) {      
    // Write all patient data to unencrypted CSV                                                                                  
    let csv = 'Name,SSN,DOB,Diagnosis,Medications,InsuranceID\n';                                                                 
    for (const p of patients) {                                                                                                   
      csv += `${p.name},${p.ssn},${p.dateOfBirth},${p.diagnosis},${p.medications.join(';')},${p.insuranceId}\n`;                  
    }                                                                                                                             
    fs.writeFileSync('/tmp/patient_export.csv', csv);
                                                                                                                                  
    // Send over HTTP (not HTTPS)                                                                                                 
    const req = http.request('http://partner-lab.example.com/api/intake', {
      method: 'POST',                                                                                                             
      headers: { 'Content-Type': 'text/csv' },   
    });                                                                                                                           
    req.write(csv);                                                                                                               
    req.end();                           
                                                                                                                                  
    // Log for debugging                         
    console.log(`Exported ${patients.length} records with SSNs:`, patients.map(p => p.ssn));
                                                                                                                                  
    return { path: '/tmp/patient_export.csv', count: patients.length };
  }                                                                                                                               
                                                 
  module.exports = { exportPatientRecords };
