import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { HttpStatus } from '@api/routes/index.router';
import { deliveryController } from '@api/server.module';
import { RequestHandler, Router } from 'express';

import { CloseDeliveryDto, CreateDeliveryDto, DeliveryStatusDto } from '../dto/delivery.dto';
import {
  closeDeliverySchema,
  createDeliverySchema,
  deliveryListSchema,
  deliveryStatusSchema,
} from '../validate/delivery.schema';

export class DeliveryRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      // Create a new delivery tracking
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CreateDeliveryDto>({
          request: req,
          schema: createDeliverySchema,
          ClassRef: CreateDeliveryDto,
          execute: (instance, data) => deliveryController.create(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      // Get delivery status
      .get(this.routerPath('status/:idPesada'), ...guards, async (req, res) => {
        const response = await this.dataValidate<DeliveryStatusDto>({
          request: req,
          schema: deliveryStatusSchema,
          ClassRef: DeliveryStatusDto,
          execute: (instance) => deliveryController.getStatus(instance, { idPesada: req.params.idPesada }),
        });

        res.status(HttpStatus.OK).json(response);
      })
      // List deliveries
      .get(this.routerPath('list'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: deliveryListSchema,
          ClassRef: InstanceDto,
          execute: (instance) =>
            deliveryController.list(instance, {
              status: req.query.status as string,
              limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
              offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
            }),
        });

        res.status(HttpStatus.OK).json(response);
      })
      // Close a delivery manually
      .put(this.routerPath('close/:idPesada'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CloseDeliveryDto>({
          request: req,
          schema: closeDeliverySchema,
          ClassRef: CloseDeliveryDto,
          execute: (instance) =>
            deliveryController.close(instance, {
              idPesada: req.params.idPesada,
              reason: req.body.reason,
            }),
        });

        res.status(HttpStatus.OK).json(response);
      })
      // Get audit trail
      .get(this.routerPath('audit/:idPesada'), ...guards, async (req, res) => {
        const response = await this.dataValidate<DeliveryStatusDto>({
          request: req,
          schema: deliveryStatusSchema,
          ClassRef: DeliveryStatusDto,
          execute: (instance) => deliveryController.getAudit(instance, { idPesada: req.params.idPesada }),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
