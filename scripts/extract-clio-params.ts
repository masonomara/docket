// Run: node --experimental-strip-types scripts/extract-clio-params.ts
//
// This script extracts query parameters from the Clio OpenAPI spec
// and generates a JSON file that the API uses for filter validation.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File paths
const OPENAPI_PATH = path.join(__dirname, "..", "openapi.json");
const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "apps/api/src/generated/clio-params.json"
);

// Clio object types and their list endpoints
const ENDPOINTS: Record<string, string> = {
  Matter: "/matters.json",
  Contact: "/contacts.json",
  Task: "/tasks.json",
  CalendarEntry: "/calendar_entries.json",
  Activity: "/activities.json",
};

// Parameters we handle separately (pagination, field selection, etc.)
const PARAMS_TO_SKIP = new Set([
  "fields",
  "limit",
  "page_token",
  "order",
  "X-API-VERSION",
]);

type ExtractedParam = {
  name: string;
  type: string;
  format?: string;
  enum?: string[];
  description?: string;
  isArray?: boolean;
};

/**
 * Extract query parameters from an OpenAPI endpoint definition.
 */
function extractParamsFromEndpoint(
  openApiSpec: any,
  endpointPath: string
): Record<string, ExtractedParam> {
  const extractedParams: Record<string, ExtractedParam> = {};

  // Get the GET operation's parameters for this endpoint
  const endpoint = openApiSpec.paths?.[endpointPath];
  const getOperation = endpoint?.get;
  const parameters = getOperation?.parameters || [];

  for (const param of parameters) {
    // Only extract query parameters, skip headers and path params
    if (param.in !== "query") {
      continue;
    }

    // Skip params we handle separately
    if (PARAMS_TO_SKIP.has(param.name)) {
      continue;
    }

    const schema = param.schema || {};

    // Use the param name without [] suffix as the key
    const paramKey = param.name.replace("[]", "");

    // Build the extracted parameter object
    const extracted: ExtractedParam = {
      name: param.name,
      type: schema.type || "string",
      isArray: param.name.endsWith("[]"),
    };

    // Add optional fields if present
    if (schema.format) {
      extracted.format = schema.format;
    }

    if (schema.enum) {
      extracted.enum = schema.enum;
    }

    if (param.description) {
      // Truncate long descriptions
      extracted.description = param.description.slice(0, 200);
    }

    extractedParams[paramKey] = extracted;
  }

  return extractedParams;
}

/**
 * Count parameters with a specific property.
 */
function countParamsWithProperty(
  params: Record<string, ExtractedParam>,
  property: keyof ExtractedParam
): number {
  return Object.values(params).filter((param) => param[property]).length;
}

// Main script execution
function main() {
  // Load the OpenAPI spec
  const openApiSpec = JSON.parse(fs.readFileSync(OPENAPI_PATH, "utf-8"));

  // Build the output structure
  const output: {
    generatedAt: string;
    openApiVersion: string;
    objects: Record<
      string,
      { endpoint: string; params: Record<string, ExtractedParam> }
    >;
  } = {
    generatedAt: new Date().toISOString(),
    openApiVersion: openApiSpec.info?.version || "unknown",
    objects: {},
  };

  console.log("Extracting Clio API parameters...\n");

  let totalParams = 0;

  // Process each endpoint
  for (const [objectType, endpointPath] of Object.entries(ENDPOINTS)) {
    const params = extractParamsFromEndpoint(openApiSpec, endpointPath);
    const paramCount = Object.keys(params).length;
    const enumCount = countParamsWithProperty(params, "enum");
    const arrayCount = countParamsWithProperty(params, "isArray");

    output.objects[objectType] = {
      endpoint: endpointPath,
      params: params,
    };

    totalParams += paramCount;

    // Log progress
    const paddedType = objectType.padEnd(14);
    const paddedCount = paramCount.toString().padStart(2);
    console.log(
      `  ${paddedType} ${paddedCount} params (${enumCount} enum, ${arrayCount} array)`
    );
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  fs.mkdirSync(outputDir, { recursive: true });

  // Write the output file
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const objectCount = Object.keys(ENDPOINTS).length;
  console.log(`\nGenerated: ${OUTPUT_PATH}`);
  console.log(
    `Total: ${totalParams} parameters across ${objectCount} object types`
  );
}

main();
