/**
 * Inspecciona la estructura completa de vwPesadasDeSalida y muestra todos los
 * campos disponibles para una pesada específica.
 *
 * Uso:
 *   node inspeccionar_vista_pesada.js [idPesada]
 *
 * Si no se pasa idPesada, usa 30283 por defecto.
 */
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
  const idPesada = parseInt(process.argv[2] || '30283', 10);

  console.log('='.repeat(80));
  console.log(`Inspeccionando vwPesadasDeSalida para IdPesada=${idPesada}`);
  console.log('='.repeat(80));

  const pesadasPool = await new sql.ConnectionPool(pesadasConfig).connect();

  // 1. Estructura de la vista (todas las columnas)
  console.log('\n--- 1) ESTRUCTURA DE LA VISTA vwPesadasDeSalida ---\n');
  const columns = await pesadasPool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'vistas'
      AND TABLE_NAME = 'vwPesadasDeSalida'
    ORDER BY ORDINAL_POSITION
  `);
  console.table(columns.recordset);

  // 2. Datos completos de la pesada
  console.log(`\n--- 2) DATOS COMPLETOS DE PESADA ${idPesada} ---\n`);
  const data = await pesadasPool
    .request()
    .input('idPesada', sql.Int, idPesada)
    .query(`SELECT TOP 1 * FROM [vistas].[vwPesadasDeSalida] WHERE IdPesada = @idPesada`);

  if (data.recordset.length === 0) {
    console.log(`No se encontró la pesada ${idPesada}`);
  } else {
    const row = data.recordset[0];
    // Mostrar como pares clave/valor para que sea fácil de leer
    for (const [k, v] of Object.entries(row)) {
      console.log(`  ${k.padEnd(35)} = ${v === null ? 'NULL' : v}`);
    }
  }

  await pesadasPool.close();

  // 3. Estructura de la tabla traslado en SIGO (campos destino)
  console.log('\n--- 3) ESTRUCTURA DE LA TABLA traslado EN SIGO ---\n');
  const sigoPool = await new sql.ConnectionPool(sigoConfig).connect();
  const trasladoCols = await sigoPool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'traslado'
    ORDER BY ORDINAL_POSITION
  `);
  console.table(trasladoCols.recordset);

  // 4. Si existe el traslado para esta pesada, mostrar sus valores actuales
  console.log(`\n--- 4) DATOS ACTUALES EN traslado PARA tras_ext_id=${idPesada} ---\n`);
  const trasladoData = await sigoPool
    .request()
    .input('extId', sql.NVarChar(50), String(idPesada))
    .query(`SELECT TOP 1 * FROM traslado WHERE tras_ext_id = @extId ORDER BY tras_id DESC`);

  if (trasladoData.recordset.length === 0) {
    console.log(`No hay registro en traslado para tras_ext_id=${idPesada}`);
  } else {
    const row = trasladoData.recordset[0];
    for (const [k, v] of Object.entries(row)) {
      const marker = v === null ? '  <-- NULL' : '';
      console.log(`  ${k.padEnd(35)} = ${v === null ? 'NULL' : v}${marker}`);
    }
  }

  await sigoPool.close();
  console.log('\n' + '='.repeat(80));
  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
