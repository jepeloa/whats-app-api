import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import cron from 'node-cron';

import { DeliveryService } from './delivery.service';

export class DeliveryReminderSchedulerService {
  private readonly logger = new Logger('DeliveryReminderScheduler');
  private cronTask: cron.ScheduledTask | null = null;

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly deliveryService: DeliveryService,
  ) {}

  /**
   * Start the reminder scheduler
   */
  start() {
    const intervalMinutes = parseInt(process.env.DELIVERY_REMINDER_INTERVAL_MINUTES || '30', 10);

    // Run every X minutes
    const cronExpression = `*/${intervalMinutes} * * * *`;

    this.cronTask = cron.schedule(cronExpression, async () => {
      await this.checkPendingDeliveries();
    });

    this.cronTask.start();
    this.logger.info(`Reminder scheduler started. Running every ${intervalMinutes} minutes.`);
  }

  /**
   * Stop the reminder scheduler
   */
  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.logger.info('Reminder scheduler stopped.');
    }
  }

  /**
   * Check pending deliveries and send reminders if needed
   */
  private async checkPendingDeliveries() {
    this.logger.info('Checking for pending deliveries that need reminders...');

    const intervalMinutes = parseInt(process.env.DELIVERY_REMINDER_INTERVAL_MINUTES || '30', 10);
    const maxReminders = parseInt(process.env.DELIVERY_MAX_REMINDERS || '3', 10);

    // Calculate the threshold time (now - interval)
    const thresholdTime = new Date();
    thresholdTime.setMinutes(thresholdTime.getMinutes() - intervalMinutes);

    try {
      // Find active deliveries that:
      // 1. Are in pending or in_progress status
      // 2. Have pending locations
      // 3. Haven't received a reminder recently (or never)
      // 4. Haven't reached max reminders
      const pendingDeliveries = await this.prismaRepository.deliveryTracking.findMany({
        where: {
          status: { in: ['pending', 'in_progress'] },
          reminderCount: { lt: maxReminders },
          OR: [
            { lastReminderAt: null, lastMessageAt: { lt: thresholdTime } },
            { lastReminderAt: { lt: thresholdTime } },
            { lastReminderAt: null, lastMessageAt: null, createdAt: { lt: thresholdTime } },
          ],
        },
        include: {
          locations: true,
          Instance: true,
        },
      });

      this.logger.info(`Found ${pendingDeliveries.length} deliveries that need reminders`);

      for (const delivery of pendingDeliveries) {
        // Check if there are still pending locations
        const hasPendingLocations = delivery.locations.some((l) => l.status === 'pending');

        if (!hasPendingLocations) {
          // All locations delivered, but status not updated - update it
          await this.prismaRepository.deliveryTracking.update({
            where: { id: delivery.id },
            data: {
              status: 'completed',
              confirmedAt: new Date(),
            },
          });
          continue;
        }

        // Send reminder
        try {
          await this.deliveryService.sendReminder(delivery.id, delivery.Instance.name);
        } catch (error) {
          this.logger.error(`Error sending reminder for delivery ${delivery.idPesada}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error checking pending deliveries: ${error.message}`);
    }
  }
}
