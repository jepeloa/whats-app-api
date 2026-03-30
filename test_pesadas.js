const sql = require('mssql');
const config = { server: '192.168.1.25', port: 1433, user: 'svrvistas', password: 'unaM@Sdificil', database: 'Comisi_SantaSylvinaSA', options: { encrypt: false, trustServerCertificate: true } };
async function main() { try { const pool = await sql.connect(config); console.log('Conectado'); const result = await pool.request().query("SELECT * FROM [vistas].[vwPesadasDeSalida] WHERE IdPesada = 29352"); console.log(JSON.stringify(result.recordset, null, 2)); pool.close(); } catch (err) { console.error('Error:', err.message); } }
main();
