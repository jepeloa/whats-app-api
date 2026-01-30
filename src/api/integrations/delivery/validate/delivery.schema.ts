import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

const isNotEmpty = (...propertyNames: string[]): JSONSchema7 => {
  const properties = {};
  propertyNames.forEach(
    (property) =>
      (properties[property] = {
        minLength: 1,
        description: `The "${property}" cannot be empty`,
      }),
  );
  return {
    if: {
      propertyNames: {
        enum: [...propertyNames],
      },
    },
    then: { properties },
  };
};

export const createDeliverySchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    idPesada: { type: 'string', minLength: 1 },
    phoneNumber: { type: 'string', minLength: 1 },
    choferNombre: { type: 'string', minLength: 1 },
    patente: { type: 'string', minLength: 1 },
    artNombre: { type: 'string', minLength: 1 },
    origen: { type: 'string', minLength: 1 },
    pesoNeto: { type: 'number' },
    pesoUn: { type: 'string', minLength: 1 },
    ubicaciones: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string', minLength: 1 },
          direccion: { type: 'string', minLength: 1 },
          orden: { type: 'integer' },
        },
        required: ['nombre', 'direccion'],
      },
    },
    emailRecipients: {
      type: 'array',
      items: { type: 'string', format: 'email' },
    },
    metadata: { type: 'object' },
  },
  required: [
    'idPesada',
    'phoneNumber',
    'choferNombre',
    'patente',
    'artNombre',
    'origen',
    'pesoNeto',
    'pesoUn',
    'ubicaciones',
  ],
  ...isNotEmpty('idPesada', 'phoneNumber', 'choferNombre', 'patente', 'artNombre', 'origen', 'pesoUn'),
};

export const deliveryStatusSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {},
};

export const closeDeliverySchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    reason: { type: 'string' },
  },
};

export const deliveryListSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pending', 'in_progress', 'partial', 'not_delivered', 'completed'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
};
