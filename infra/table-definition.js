export const TABLE_NAME = process.env.GRADEBOOK_TABLE_NAME || 'gradebook_platform_data';
export const BASE_KEYS = { pk: 'PK', sk: 'SK' };

export const INDEXES = [
  { name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK' },  // class + term rollups
  { name: 'GSI2', pk: 'GSI2PK', sk: 'GSI2SK' },  // per-student history
  { name: 'GSI3', pk: 'GSI3PK', sk: 'GSI3SK' },  // delta sync by class
];

export const TABLE_DEFINITION = {
  TableName: TABLE_NAME,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: BASE_KEYS.pk, AttributeType: 'S' },
    { AttributeName: BASE_KEYS.sk, AttributeType: 'S' },
    ...INDEXES.flatMap((i) => [
      { AttributeName: i.pk, AttributeType: 'S' },
      { AttributeName: i.sk, AttributeType: 'S' },
    ]),
  ],
  KeySchema: [
    { AttributeName: BASE_KEYS.pk, KeyType: 'HASH' },
    { AttributeName: BASE_KEYS.sk, KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: INDEXES.map((i) => ({
    IndexName: i.name,
    KeySchema: [
      { AttributeName: i.pk, KeyType: 'HASH' },
      { AttributeName: i.sk, KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  })),
  StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
};