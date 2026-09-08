import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_ID_CONTRACT } from './release-id.mjs';
import { createSchemaCompatibilityCoordinateValueContract } from './schema-compatibility-coordinate-value-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(fs.readFileSync(
    path.join(root, 'src/shared/Contracts/Validation/schema-compatibility-coordinate.json'),
    'utf8'
));
export const { SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT, parseSchemaCompatibilityCoordinate, parseLegacySchemaCompatibilityCoordinate, compareSchemaCompatibilityCoordinates, assertSchemaCompatibilityWindow } = createSchemaCompatibilityCoordinateValueContract(contract, RELEASE_ID_CONTRACT);
