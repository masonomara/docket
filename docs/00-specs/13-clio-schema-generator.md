# Clio Schema Generator

## Problem

The LLM generates invalid Clio API parameters because the tool schema provides minimal guidance. Manual documentation drifts from the actual API and introduces errors (wrong casing, wrong parameter names, missing constraints).

## Solution

Generate schema from Clio's OpenAPI spec (`openapi.json`). Single source of truth, zero maintenance, zero manual errors.

## Task 1: Create Extraction Script

**File:** `scripts/extract-clio-schema.ts`

```typescript
import * as fs from "fs";

// Load OpenAPI spec
const openapi = JSON.parse(
  fs.readFileSync("openapi (1).json", "utf-8")
);

// Endpoints we care about
const ENDPOINTS: Record<string, string> = {
  matter: "/matters.json",
  contact: "/contacts.json",
  task: "/tasks.json",
  calendarentry: "/calendar_entries.json",
  activity: "/activities.json",
};

// Response schema names in OpenAPI
const RESPONSE_SCHEMAS: Record<string, string> = {
  matter: "Matter_base",
  contact: "Contact_base",
  task: "Task_base",
  calendarentry: "CalendarEntry_base",
  activity: "Activity_base",
};

interface ParamSchema {
  name: string;
  type: string;
  enum?: string[];
  format?: string;
  required: boolean;
  description: string;
}

interface FieldSchema {
  type: string;
  enum?: string[];
  format?: string;
  description: string;
}

interface ObjectSchema {
  endpoint: string;
  queryParams: Record<string, ParamSchema>;
  responseFields: Record<string, FieldSchema>;
}

function extractQueryParams(path: string): Record<string, ParamSchema> {
  const endpoint = openapi.paths[path]?.get;
  if (!endpoint?.parameters) return {};

  const params: Record<string, ParamSchema> = {};

  for (const p of endpoint.parameters) {
    if (p.in !== "query") continue;
    // Skip pagination/meta params
    if (["fields", "limit", "page_token", "order", "X-API-VERSION"].includes(p.name)) continue;

    const name = p.name.replace("[]", ""); // Normalize array params
    params[name] = {
      name: p.name,
      type: p.schema?.type || "string",
      enum: p.schema?.enum,
      format: p.schema?.format,
      required: p.required || false,
      description: p.description || "",
    };
  }

  return params;
}

function extractResponseFields(schemaName: string): Record<string, FieldSchema> {
  const schema = openapi.components?.schemas?.[schemaName];
  if (!schema?.properties) return {};

  const fields: Record<string, FieldSchema> = {};

  for (const [name, prop] of Object.entries(schema.properties) as [string, any][]) {
    // Skip internal fields
    if (["etag", "created_at", "updated_at", "deleted_at"].includes(name)) continue;

    fields[name] = {
      type: prop.type || "object",
      enum: prop.enum,
      format: prop.format,
      description: prop.description || "",
    };
  }

  return fields;
}

// Build the schema
const clioSchema: Record<string, ObjectSchema> = {};

for (const [type, path] of Object.entries(ENDPOINTS)) {
  clioSchema[type] = {
    endpoint: path,
    queryParams: extractQueryParams(path),
    responseFields: extractResponseFields(RESPONSE_SCHEMAS[type]),
  };
}

// Write output
const output = JSON.stringify(clioSchema, null, 2);
fs.writeFileSync("apps/api/src/generated/clio-schema.json", output);

console.log("Generated clio-schema.json");
console.log(`  ${Object.keys(clioSchema).length} object types`);
for (const [type, schema] of Object.entries(clioSchema)) {
  console.log(`  ${type}: ${Object.keys(schema.queryParams).length} params, ${Object.keys(schema.responseFields).length} fields`);
}
```

**Run:** `npx ts-node scripts/extract-clio-schema.ts`

## Task 2: Generated Schema Structure

**File:** `apps/api/src/generated/clio-schema.json`

The script outputs:

```json
{
  "matter": {
    "endpoint": "/matters.json",
    "queryParams": {
      "status": {
        "name": "status",
        "type": "string",
        "enum": ["open", "closed", "pending"],
        "required": false,
        "description": "Filter Matter records to those with a given status."
      },
      "responsible_attorney_id": {
        "name": "responsible_attorney_id",
        "type": "integer",
        "format": "int64",
        "required": false,
        "description": "The unique identifier for a single User."
      }
    },
    "responseFields": {
      "status": {
        "type": "string",
        "enum": ["Pending", "Open", "Closed"],
        "description": "The current status of the Matter"
      }
    }
  }
}
```

## Task 3: Build Validation from Schema

**File:** `apps/api/src/services/clio-validation.ts`

```typescript
import clioSchema from "../generated/clio-schema.json";

interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

export function validateFilters(
  objectType: string,
  filters?: Record<string, unknown>
): ValidationResult {
  const type = objectType.toLowerCase().replace("_", "");
  const schema = clioSchema[type as keyof typeof clioSchema];

  if (!schema) {
    return { valid: false, error: `Unknown object type: ${objectType}` };
  }

  if (!filters) return { valid: true };

  for (const [key, value] of Object.entries(filters)) {
    const param = schema.queryParams[key];

    // Unknown parameter - let Clio handle it (might be valid, just not extracted)
    if (!param) continue;

    // Check enum values
    if (param.enum && value !== undefined) {
      const normalizedValue = String(value).toLowerCase();
      const validValues = param.enum.map((v) => v.toLowerCase());

      if (!validValues.includes(normalizedValue)) {
        return {
          valid: false,
          error: `Invalid ${key} "${value}" for ${objectType}.`,
          suggestion: `Valid values: ${param.enum.join(", ")}`,
        };
      }
    }
  }

  // Task-specific: assignee_id requires assignee_type
  if (type === "task" && filters.assignee_id && !filters.assignee_type) {
    return {
      valid: false,
      error: "assignee_id requires assignee_type to be specified.",
      suggestion: 'Add assignee_type: "user" or "contact"',
    };
  }

  return { valid: true };
}

// Normalize filter values (e.g., lowercase status)
export function normalizeFilters(
  objectType: string,
  filters?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!filters) return undefined;

  const type = objectType.toLowerCase().replace("_", "");
  const schema = clioSchema[type as keyof typeof clioSchema];
  if (!schema) return filters;

  const normalized = { ...filters };

  for (const [key, value] of Object.entries(normalized)) {
    const param = schema.queryParams[key];
    if (!param?.enum || value === undefined) continue;

    // Lowercase enum values for query params
    normalized[key] = String(value).toLowerCase();
  }

  return normalized;
}
```

## Task 4: Build Tool Schema from Generated Schema

**File:** `apps/api/src/services/clio-tool-schema.ts`

```typescript
import clioSchema from "../generated/clio-schema.json";

function formatParamsForType(type: string): string {
  const schema = clioSchema[type as keyof typeof clioSchema];
  if (!schema) return "";

  const lines: string[] = [];

  for (const [name, param] of Object.entries(schema.queryParams)) {
    let line = `- ${name}: ${param.type}`;
    if (param.enum) {
      line += ` (${param.enum.map((v) => `"${v}"`).join(" | ")})`;
    }
    if (param.format) {
      line += ` [${param.format}]`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

export function buildFiltersDescription(): string {
  const sections = Object.entries(clioSchema).map(([type, schema]) => {
    const typeName = type.toUpperCase();
    const params = formatParamsForType(type);
    return `${typeName}:\n${params}`;
  });

  return `Query filters (vary by objectType):

${sections.join("\n\n")}

Date format: YYYY-MM-DD
Datetime format: ISO 8601 (e.g., 2024-01-15T14:00:00Z)`;
}

// Use in getClioTools()
export function getClioToolSchema() {
  return {
    name: "clioQuery",
    description: "Query or modify data in Clio",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "create", "update"],
        },
        objectType: {
          type: "string",
          enum: ["Matter", "Contact", "Task", "CalendarEntry", "Activity"],
          description: "The Clio object type. Use Activity for time entries.",
        },
        id: {
          type: "string",
          description: "Object ID for single-record operations",
        },
        filters: {
          type: "object",
          description: buildFiltersDescription(),
        },
        fields: {
          type: "string",
          description: "Comma-separated fields to return. Use nested syntax: client{id,name}",
        },
        data: {
          type: "object",
          description: "Data for create/update operations",
        },
      },
      required: ["operation", "objectType"],
    },
  };
}
```

## Task 5: Wire Up in Tenant

**File:** `apps/api/src/do/tenant.ts`

Replace manual tool schema with generated version:

```typescript
import { getClioToolSchema } from "../services/clio-tool-schema";
import { validateFilters, normalizeFilters } from "../services/clio-validation";

// In getClioTools():
private getClioTools(): Tool[] {
  return [getClioToolSchema()];
}

// In executeClioRead():
private async executeClioRead(
  userId: string,
  args: { objectType: string; id?: string; filters?: Record<string, unknown> }
): Promise<string> {
  // Validate filters
  if (!args.id) {
    const validation = validateFilters(args.objectType, args.filters);
    if (!validation.valid) {
      const hint = validation.suggestion ? ` ${validation.suggestion}` : "";
      return `Filter error: ${validation.error}${hint}`;
    }
  }

  // Normalize filter values (lowercase enums, etc.)
  const normalizedFilters = normalizeFilters(args.objectType, args.filters);

  // ... rest of implementation
}
```

## Task 6: Add to Build Process

**File:** `package.json`

```json
{
  "scripts": {
    "generate:clio-schema": "ts-node scripts/extract-clio-schema.ts",
    "prebuild": "npm run generate:clio-schema",
    "build": "..."
  }
}
```

## Task 7: Add Generated File to .gitignore (Optional)

If you want to regenerate on each build:

```
# .gitignore
apps/api/src/generated/
```

Or commit it for transparency and faster builds.

## Verification

After running the generator:

```bash
npx ts-node scripts/extract-clio-schema.ts
```

Check output:
- `apps/api/src/generated/clio-schema.json` exists
- Contains 5 object types
- Each has queryParams and responseFields
- Enum values match OpenAPI spec

Test validation:
- `status: "Open"` normalizes to `"open"`, query succeeds
- `status: "active"` fails with suggestion
- `assignee_id` without `assignee_type` fails with suggestion

## Source

All data extracted from `openapi (1).json` (Clio API v4 OpenAPI spec).

## Benefits

1. **Single source of truth** - OpenAPI spec is authoritative
2. **Zero maintenance** - Regenerate when Clio updates API
3. **Zero manual errors** - No typos, wrong casing, missing params
4. **Type safe** - Can generate TypeScript types from schema
5. **Comprehensive** - Extracts ALL parameters, not just manually documented ones
