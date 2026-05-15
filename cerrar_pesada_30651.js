// Cierra manualmente la pesada 30651 en la DB de la app
// Uso dentro del container: node cerrar_pesada_30651.js
const { PrismaClient } = require('@prisma/client');

const ID_PESADA = '30651';

async function main() {
  const prisma = new PrismaClient();
  try {
    const delivery = await prisma.deliveryTracking.findFirst({
      where: { idPesada: ID_PESADA },
      include: { locations: true },
    });

    if (!delivery) {
      console.log(`[!] No se encontró pesada ${ID_PESADA}`);
      return;
    }

    console.log(`[i] Pesada ${ID_PESADA} encontrada (id=${delivery.id}, status=${delivery.status})`);
    console.log(`[i] Ubicaciones: ${delivery.locations.length} (${delivery.locations.filter(l => l.status === 'pending').length} pendientes)`);

    // 1) Marcar todas las ubicaciones pendientes como delivered con 0 kg
    const updatedLocations = await prisma.deliveryLocation.updateMany({
      where: { deliveryTrackingId: delivery.id, status: 'pending' },
      data: {
        status: 'delivered',
        kilosDescargados: 0,
        deliveredAt: new Date(),
        notes: 'Cierre manual',
      },
    });
    console.log(`[+] Ubicaciones cerradas: ${updatedLocations.count}`);

    // 2) Cerrar la pesada
    const updated = await prisma.deliveryTracking.update({
      where: { id: delivery.id },
      data: {
        status: 'completed',
        confirmedAt: delivery.confirmedAt || new Date(),
      },
    });
    console.log(`[+] Pesada ${ID_PESADA} cerrada → status=${updated.status}, confirmedAt=${updated.confirmedAt?.toISOString()}`);
  } catch (err) {
    console.error('[x] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
