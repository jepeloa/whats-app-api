const sql = require('mssql');

const pesadasConfig = {
  server: '192.168.1.25',
  port: 1433,
  user: 'svrvistas',
  password: 'unaM@Sdificil',
  database: 'Comisi_SantaSylvinaSA',
  options: { encrypt: false, trustServerCertificate: true },
};

const sigoConfig = {
  server: '192.168.1.46',
  port: 1433,
  user: 'usrN8N',
  password: 'n8ns1G0',
  database: 'db_sigo_dev',
  options: { encrypt: false, trustServerCertificate: true },
};

async function main() {
  const pesadasPool = await sql.connect(pesadasConfig);
  
  // Get recent pesadas
  const pesadas = await pesadasPool.request().query(`
    SELECT TOP 20 IdPesada, Chofer, Patente, Destino, PesoNeto, TelefonoChofer, RUCADestino
    FROM [vistas].[vwPesadasDeSalida]
    ORDER BY IdPesada DESC
  `);
  
  await pesadasPool.close();

  const sigoPool = await new sql.ConnectionPool(sigoConfig).connect();

  console.log('IdPesada | Chofer | Destino | PesoNeto | RUCADestino | #Ubicaciones');
  console.log('-'.repeat(100));

  for (const p of pesadas.recordset) {
    const ubResult = await sigoPool.request()
      .input('ref', sql.VarChar(50), String(p.RUCADestino))
      .query('SELECT COUNT(*) as cnt FROM ubicaciones WHERE ub_ref = @ref');
    
    const cnt = ubResult.recordset[0].cnt;
    console.log(
      `${p.IdPesada} | ${(p.Chofer||'').trim().substring(0,25)} | ${(p.Destino||'').trim().substring(0,20)} | ${p.PesoNeto} | ${p.RUCADestino} | ${cnt}`
    );
  }

  await sigoPool.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
